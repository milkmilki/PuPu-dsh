import { randomUUID } from 'node:crypto';
import type { Binding, EngineClient, ImportSelection, Json, JsonObject, ModelRoute, Role, Task, TranscriptEntry, Trigger, UiRequest } from './contracts.js';
import { Catalog } from './catalog.js';
import { EnginePool } from './mcp/client.js';
import { notesCommandSchema } from './mcp/schema.js';
import { MigrationService, exportPackage } from './migration.js';
import { TaskRunner, type Generate } from './runner.js';

export type { GenerateInput, GenerateResult } from './runner.js';
export interface ProductAdapter {
  generate: Generate;
  createSession(input: { roleId: string; name: string; speakerName: string; cwd?: string; workspaceId?: string; model?: ModelRoute }): Promise<string>;
  flushSession?(sessionId: string): Promise<void>;
}
export class ProductService {
  readonly catalog: Catalog;
  readonly migration: MigrationService;
  readonly runner: TaskRunner;
  private pool: EnginePool;
  private timer?: NodeJS.Timeout;
  private hostErrors = new Map<string, string>();
  private rawEngine: (roleId: string) => Promise<EngineClient>;
  private guarded = new Map<string, EngineClient>();
  private gates = new Map<string, { wait: Promise<void>; release: () => void }>();
  private exclusiveBusy = new Set<string>();
  private calls = new Map<string, Set<Promise<unknown>>>();
  constructor(readonly root: string, private adapter: ProductAdapter, options: {
    engineEntry?: string;
    engineFactory?: (role: Role, root: string) => Promise<EngineClient>;
  } = {}) {
    this.catalog = new Catalog(root);
    this.pool = new EnginePool(id => this.catalog.rootFor(id), options.engineEntry);
    this.rawEngine = options.engineFactory
      ? id => options.engineFactory!(this.role(id), this.catalog.rootFor(id))
      : id => this.pool.get(this.role(id));
    this.engine = async id => {
      this.role(id);
      let client = this.guarded.get(id);
      if (!client) {
        client = {
          notes: (command, context) => this.withCall(id, async () => (await this.rawEngine(id)).notes(command, context)),
          admin: <T>(method: Parameters<EngineClient['admin']>[0], args?: JsonObject) => this.withCall(id, async () => (await this.rawEngine(id)).admin<T>(method, args)),
          close: () => this.pool.release(id),
        };
        this.guarded.set(id, client);
      }
      return client;
    };
    this.migration = new MigrationService(this.catalog);
    this.runner = new TaskRunner(id => this.role(id), id => this.engine(id), adapter.generate);
  }
  engine: (roleId: string) => Promise<EngineClient>;
  roles() { return this.catalog.roles(); }
  role(id: string) { return this.catalog.role(id); }
  bindings() { return this.catalog.bindings(); }
  binding(sessionId: string): Binding | undefined { return this.catalog.binding(sessionId); }
  reportHostError(sessionId: string, error: string) { this.hostErrors.set(sessionId, error); }
  rememberModel(roleId: string, route: ModelRoute) {
    if (!route?.provider || !route?.model) throw new Error('模型路由缺少提供方或名称');
    this.catalog.rememberModel(roleId, route);
    this.runner.wake(roleId);
  }
  async initialize() {
    await this.tick();
    for (const role of this.roles()) this.runner.wake(role.id);
    this.timer = setInterval(() => { void this.tick().catch(error => this.reportHostError('daily', String(error))); }, 60_000);
    this.timer.unref();
  }
  async tick(now = new Date()) {
    if (now.getHours() < 3) return;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const role of this.roles()) {
      for (const binding of this.bindings().filter(binding => binding.roleId === role.id)) {
        await this.adapter.flushSession?.(binding.sessionId);
      }
      await (await this.engine(role.id)).admin('registerDaily', { day });
      this.runner.wake(role.id);
    }
  }
  async notifyTrigger(roleId: string, trigger: Trigger) {
    await (await this.engine(roleId)).admin('registerTrigger', { trigger: trigger as unknown as JsonObject });
    this.runner.wake(roleId);
  }
  private async withCall<T>(roleId: string, action: () => Promise<T>): Promise<T> {
    while (this.gates.has(roleId)) await this.gates.get(roleId)!.wait;
    const calls = this.calls.get(roleId) ?? new Set<Promise<unknown>>();
    this.calls.set(roleId, calls);
    const promise = action();
    calls.add(promise);
    try { return await promise; } finally { calls.delete(promise); }
  }
  private async exclusive<T>(roleId: string, operation: () => Promise<T>): Promise<T> {
    if (this.exclusiveBusy.has(roleId)) throw new Error('这个角色正在导入或导出，请等待当前操作完成。');
    this.exclusiveBusy.add(roleId);
    try { await this.runner.suspend(roleId); }
    catch (error) { this.exclusiveBusy.delete(roleId); throw error; }
    let release!: () => void;
    const wait = new Promise<void>(done => { release = done; });
    this.gates.set(roleId, { wait, release });
    try {
      await Promise.allSettled([...(this.calls.get(roleId) ?? [])]);
      await this.pool.release(roleId);
      return await operation();
    } finally {
      await this.pool.release(roleId);
      this.gates.delete(roleId);
      this.exclusiveBusy.delete(roleId);
      release();
      this.runner.resume(roleId);
    }
  }
  async dispatch(request: UiRequest): Promise<unknown> {
    const input = request.input ?? {};
    if (request.action === 'state') {
      const role = request.roleId ? this.role(request.roleId) : this.roles()[0];
      let tasks: Task[] = [], stats: JsonObject = {};
      let taskTranscript: unknown[] = [];
      if (role) {
        const engine = await this.engine(role.id);
        tasks = await engine.admin<Task[]>('listTasks');
        stats = await engine.admin<JsonObject>('stats');
        const card = await engine.admin<{ path: string; content: string | null }>('roleCard');
        if (card.path !== role.roleCardPath) this.catalog.save({ ...this.role(role.id), roleCardPath: card.path });
        if (typeof input.taskId === 'string') {
          const entries = await engine.admin<TranscriptEntry[]>('transcript', { taskId: input.taskId });
          taskTranscript = entries.map(safeTranscript);
        }
      }
      return {
        roles: this.roles(), bindings: this.bindings(), selectedRoleId: role?.id,
        tasks, stats, taskTranscript,
        modelReady: !!(role?.memoryModel || role?.lastModel),
        ...(!role?.memoryModel && !role?.lastModel && role ? { waitingReason: '尚未选择记忆模型。可先创建角色会话，或在角色设置中指定整理模型。' } : {}),
        ...(this.hostErrors.size ? { error: [...this.hostErrors].map(([session, error]) => `${session}: ${error}`).join('\n') } : {}),
      };
    }
    if (request.action === 'createRole') {
      const role = this.catalog.create(String(input.name ?? ''), String(input.speakerName ?? ''));
      const engine = await this.engine(role.id);
      if (typeof input.persona === 'string' && input.persona) {
        const card = await engine.admin<{ path: string; content: string | null }>('roleCard');
        await engine.notes({ action: 'edit', path: card.path, oldText: card.content ?? '', newText: input.persona }, { actor: role.speakerName });
      }
      return role;
    }
    if (request.action === 'previewImport') return this.migration.preview(String(input.path ?? ''));
    if (request.action === 'confirmImport') {
      const target = this.migration.targetRoleId(String(input.token));
      const result = await (target
        ? this.exclusive(target, () => this.migration.confirm(input as unknown as ImportSelection))
        : this.migration.confirm(input as unknown as ImportSelection));
      if (result.role.memoryModel || result.role.lastModel) this.runner.wake(result.role.id);
      return result;
    }
    if (!request.roleId) throw new Error('请先选择角色');
    const role = this.role(request.roleId);
    const engine = await this.engine(role.id);
    switch (request.action) {
      case 'updateRole': {
        const next = { ...this.role(role.id) };
        if (typeof input.name === 'string') { if (!input.name.trim()) throw new Error('角色名称不能为空'); next.name = input.name.trim(); }
        if (typeof input.speakerName === 'string') { if (!input.speakerName.trim()) throw new Error('说话者名称不能为空'); next.speakerName = input.speakerName.trim(); }
        if (input.memoryModel === null) delete next.memoryModel;
        else if (input.memoryModel) {
          const route = input.memoryModel as unknown as ModelRoute;
          if (!route.provider?.trim() || !route.model?.trim()) throw new Error('请同时填写提供方与模型名称');
          next.memoryModel = { provider: route.provider.trim(), model: route.model.trim() };
        }
        this.catalog.save(next);
        if (next.memoryModel || next.lastModel) this.runner.wake(next.id);
        return next;
      }
      case 'createSession': {
        const speakerName = typeof input.speakerName === 'string' && input.speakerName.trim() ? input.speakerName.trim() : role.speakerName;
        const sessionId = await this.adapter.createSession({
          roleId: role.id, name: role.name, speakerName,
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
          workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
          model: role.lastModel,
        });
        this.catalog.bind(sessionId, role.id, speakerName);
        return { sessionId };
      }
      case 'notes': return engine.notes(notesCommandSchema.parse(input), { actor: `ui:${role.speakerName}` });
      case 'versions': return engine.admin('versions', { path: String(input.path) });
      case 'undo': return engine.admin('undo', { versionId: Number(input.versionId), context: { actor: `ui:${role.speakerName}` } });
      case 'manual': {
        const sessionIds = typeof input.sessionId === 'string'
          ? [input.sessionId]
          : this.bindings().filter(b => b.roleId === role.id).map(b => b.sessionId);
        for (const sessionId of sessionIds) {
          const binding = this.binding(sessionId);
          if (!binding || binding.roleId !== role.id) throw new Error('会话不属于这个角色');
          await this.adapter.flushSession?.(sessionId);
          await this.notifyTrigger(role.id, { triggerId: `manual:${randomUUID()}`, sessionId, reason: 'manual' });
        }
        return { status: 'queued', sessions: sessionIds.length, message: sessionIds.length ? '已登记整理请求；完成后才更新处理游标。' : '尚无此插件创建的会话。' };
      }
      case 'retry': {
        const taskId = String(input.taskId);
        const previous = await engine.admin<Task>('getTask', { taskId });
        const configured = this.role(role.id);
        const route = configured.memoryModel ?? configured.lastModel;
        if (route && (previous.status === 'failed' || previous.status === 'stopped')) {
          // Keep provider replay metadata on historical messages; select the route
          // currently chosen in settings for the retried request.
          await engine.admin('appendTranscript', { taskId, entry: {
            kind: 'request', payload: { route: { provider: route.provider, model: route.model } }, at: new Date().toISOString(),
          } });
        }
        const task = await engine.admin('retryTask', { taskId });
        this.runner.wake(role.id);
        return task;
      }
      case 'stop': return this.runner.stop(role.id, String(input.taskId)).then(() => ({ status: 'stopped' }));
      case 'export': {
        if (input.kind !== 'full' && input.kind !== 'seed') throw new Error('导出种类无效');
        if (typeof input.destination !== 'string') throw new Error('请填写导出路径');
        return this.exclusive(role.id, async () => {
          const raw = await this.rawEngine(role.id);
          const card = await raw.admin<{ path: string; content: string | null }>('roleCard');
          await this.pool.release(role.id);
          return exportPackage(this.catalog, { ...role, roleCardPath: card.path }, String(input.destination), input.kind as 'full' | 'seed',
            Array.isArray(input.paths) ? input.paths.map(String) : undefined, input.includeSources === true);
        });
      }
      default: throw new Error('未知界面操作');
    }
  }
  async dispose() {
    if (this.timer) clearInterval(this.timer);
    await this.runner.close();
    await this.pool.close();
    this.catalog.close();
  }
}
function safeTranscript(entry: TranscriptEntry) {
  const p = entry.payload as Record<string, Json>;
  const message = p.message as { content?: { type: string; [key: string]: unknown }[]; role?: string } | undefined;
  const payload = {
    ...(message ? { role: message.role, content: message.content?.filter(b => b.type === 'text' || b.type === 'tool-call') } : {}),
    ...(p.finish ? { finish: p.finish } : {}),
    ...(p.usage ? { usage: p.usage } : {}),
    ...(p.elapsedMs ? { elapsedMs: p.elapsedMs } : {}),
    ...(entry.kind === 'error' ? { error: p.message } : {}),
  };
  return { kind: entry.kind, at: entry.at, payload };
}
