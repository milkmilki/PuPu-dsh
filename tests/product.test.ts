import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { ProductService } from '../src/product.js';
import { NotesEngine } from '../src/engine/index.js';
import { invokeAdmin } from '../src/mcp/server.js';
import type { EngineClient, JsonObject, Role, Task } from '../src/contracts.js';
import { inspectNotesPackage } from '../src/migration.js';

test('product binds only new sessions, isolates role notes and fixes speaker identity per conversation', async () => {
  const engines = new Map<string, NotesEngine>();
  let sessionSequence = 0;
  const created: { speakerName: string; roleId: string }[] = [];
  const product = new ProductService(mkdtempSync(join(tmpdir(), 'notes-product-')), {
    generate: async () => { throw new Error('No automatic extraction before trigger'); },
    createSession: async input => { created.push(input); return `session-${++sessionSequence}`; },
  }, {
    engineFactory: async (role, root) => {
      let engine = engines.get(role.id);
      if (!engine) { engine = new NotesEngine(root, { roleName: role.name }); engines.set(role.id, engine); }
      const current = engine;
      return {
        notes: (command, context) => current.execute(command, context),
        admin: async <T>(method: Parameters<EngineClient['admin']>[0], args: JsonObject = {}) => await invokeAdmin(current, method, args) as T,
        close: async () => {},
      };
    },
  });
  try {
    const a = await product.dispatch({ action: 'createRole', input: { name: '仆仆', speakerName: '小夫', persona: '# 仆仆\n\n喜欢认真倾听。' } }) as Role;
    const b = await product.dispatch({ action: 'createRole', input: { name: '璐璐', speakerName: '小夫' } }) as Role;
    assert.equal(product.binding('ordinary-assistant'), undefined);
    const sessionA = await product.dispatch({ action: 'createSession', roleId: a.id, input: { speakerName: '知夏姐姐' } }) as { sessionId: string };
    const sessionB = await product.dispatch({ action: 'createSession', roleId: b.id, input: {} }) as { sessionId: string };
    assert.equal(product.binding(sessionA.sessionId)!.speakerName, '知夏姐姐');
    assert.equal(product.binding(sessionB.sessionId)!.speakerName, '小夫');
    await product.dispatch({ action: 'updateRole', roleId: a.id, input: { speakerName: '其他名字' } });
    assert.equal(product.binding(sessionA.sessionId)!.speakerName, '知夏姐姐');
    await product.dispatch({ action: 'notes', roleId: a.id, input: { action: 'create', path: '随记/秘密.md', content: '只有仆仆知道的海边约定。' } });
    const aSearch = await product.dispatch({ action: 'notes', roleId: a.id, input: { action: 'search', query: '海边' } }) as JsonObject;
    const bSearch = await product.dispatch({ action: 'notes', roleId: b.id, input: { action: 'search', query: '海边' } }) as JsonObject;
    assert.equal(aSearch.total, 1); assert.equal(bSearch.total, 0);
    await assert.rejects(product.dispatch({ action: 'manual', roleId: b.id, input: { sessionId: sessionA.sessionId } }), /属于/);
    assert.equal(created.length, 2);
  } finally {
    await product.dispose();
    for (const engine of engines.values()) engine.close();
  }
});

test('daily startup catch-up is local, idempotent, blocks behind source failure and does not affect other roles', async () => {
  const engines = new Map<string, NotesEngine>();
  const product = new ProductService(mkdtempSync(join(tmpdir(), 'notes-product-daily-')), {
    generate: async () => { throw new Error('隔离的模拟模型超时'); },
    createSession: async () => 'unused',
  }, {
    engineFactory: async (role, root) => {
      let engine = engines.get(role.id);
      if (!engine) { engine = new NotesEngine(root, { roleName: role.name }); engines.set(role.id, engine); }
      const current = engine;
      return {
        notes: (command, context) => current.execute(command, context),
        admin: async <T>(method: Parameters<EngineClient['admin']>[0], args: JsonObject = {}) => await invokeAdmin(current, method, args) as T,
        close: async () => {},
      };
    },
  });
  try {
    const a = await product.dispatch({ action: 'createRole', input: { name: '仆仆', speakerName: '小夫' } }) as Role;
    const b = await product.dispatch({ action: 'createRole', input: { name: '璐璐', speakerName: '小夫' } }) as Role;
    product.rememberModel(a.id, { provider: 'test', model: 'memory' });
    product.rememberModel(b.id, { provider: 'test', model: 'memory' });
    const engineA = await product.engine(a.id);
    await engineA.admin('captureDialogue', { input: { sessionId: 'source-a', messageId: '1', party: 'human', speaker: '小夫', text: '待整理对话', at: new Date().toISOString() } });
    await product.tick(new Date(2026, 10, 17, 2, 59)); await product.runner.idle();
    assert.equal(engines.get(a.id)!.listTasks().length, 0);
    await product.tick(new Date(2026, 10, 17, 3, 0)); await product.runner.idle();
    const aTasks = engines.get(a.id)!.listTasks(), bTasks = engines.get(b.id)!.listTasks();
    assert.equal(aTasks.length, 2);
    assert.equal(aTasks[0]!.status, 'failed');
    assert.equal(aTasks[1]!.status, 'queued');
    assert.equal(aTasks[1]!.reason, 'daily');
    assert.equal(bTasks.length, 1);
    assert.equal(bTasks[0]!.status, 'failed');
    await product.tick(new Date(2026, 10, 17, 12, 0)); await product.runner.idle();
    assert.equal(engines.get(a.id)!.listTasks().length, 2);
    assert.equal(engines.get(b.id)!.listTasks().length, 1);
  } finally {
    await product.dispose();
    for (const engine of engines.values()) engine.close();
  }
});

test('seed export suspends background work, preserves completed writes and lets cached engine reconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-product-export-'));
  let reached!: () => void;
  const pending = new Promise<void>(resolve => { reached = resolve; });
  let requests = 0;
  const product = new ProductService(root, {
    createSession: async () => 'unused',
    generate: async () => {
      requests++;
      if (requests <= 2) {
        const command = requests === 1 ? { action: 'sources' } : { action: 'create', path: '随记/保留.md', content: '导出前已经写下的记忆。' };
        return { finish: 'tool-calls', message: createAssistantMessage({
          source: { provider: 'test', model: 'memory' },
          content: [{ type: 'tool-call', id: ToolCallId(`export-${requests}`), name: 'notes', arguments: JSON.stringify(command) }],
        }) };
      }
      if (requests === 3) { reached(); return new Promise(() => {}); }
      return { finish: 'stop', message: createAssistantMessage({
        source: { provider: 'test', model: 'memory' }, content: [{ type: 'text', text: '读取和写入已经完成。' }],
      }) };
    },
  }, { engineEntry: resolve('dist/mcp.mjs') });
  try {
    const role = await product.dispatch({ action: 'createRole', input: { name: '璐璐', speakerName: '小夫' } }) as Role;
    product.rememberModel(role.id, { provider: 'test', model: 'memory' });
    const engine = await product.engine(role.id);
    await engine.admin('captureDialogue', { input: { sessionId: 'session', messageId: 'one', party: 'human', speaker: '小夫', text: '值得保留。', at: new Date().toISOString() } });
    await product.notifyTrigger(role.id, { triggerId: 'export-trigger', sessionId: 'session', reason: 'manual' });
    await pending;
    const destination = join(root, 'seed.pupunotes');
    await product.dispatch({ action: 'export', roleId: role.id, input: { kind: 'seed', destination, paths: ['随记/保留.md'] } });
    await product.runner.idle();
    const data = inspectNotesPackage(destination);
    assert.match(new TextDecoder().decode(data.entries['notes/随记/保留.md']), /导出前/);
    assert.equal(data.entries['state.sqlite'], undefined);
    assert.equal((await engine.notes({ action: 'view', path: '随记/保留.md' })).content, '导出前已经写下的记忆。');
    const tasks = await engine.admin<Task[]>('listTasks');
    assert.equal(tasks[0]!.status, 'completed');
  } finally { await product.dispose(); }
});

test('retry uses the currently selected memory model while preserving completed source reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-product-model-retry-'));
  const routes: string[] = [];
  let goodCalls = 0;
  const product = new ProductService(root, {
    createSession: async () => 'unused',
    generate: async request => {
      routes.push(request.route.model);
      if (request.route.model === 'unavailable') throw new Error('原模型不可用');
      goodCalls++;
      return {
        finish: goodCalls === 1 ? 'tool-calls' : 'stop',
        message: createAssistantMessage({
          source: { provider: request.route.provider, model: request.route.model },
          content: goodCalls === 1
            ? [{ type: 'tool-call', id: ToolCallId('read-retry'), name: 'notes', arguments: '{"action":"sources"}' }]
            : [{ type: 'text', text: '读完了，没有需要修改的笔记。' }],
        }),
      };
    },
  }, { engineEntry: resolve('dist/mcp.mjs') });
  try {
    const role = await product.dispatch({ action: 'createRole', input: { name: '璐璐', speakerName: '小夫' } }) as Role;
    product.rememberModel(role.id, { provider: 'test', model: 'unavailable' });
    const engine = await product.engine(role.id);
    await engine.admin('captureDialogue', { input: { sessionId: 's', messageId: 'm', party: 'human', speaker: '小夫', text: '先读原话。', at: new Date().toISOString() } });
    await product.notifyTrigger(role.id, { triggerId: 'model-retry', sessionId: 's', reason: 'manual' });
    await product.runner.idle();
    const failed = (await engine.admin<Task[]>('listTasks'))[0]!;
    assert.equal(failed.status, 'failed');
    await product.dispatch({ action: 'updateRole', roleId: role.id, input: { memoryModel: { provider: 'test', model: 'replacement' } } });
    await product.dispatch({ action: 'retry', roleId: role.id, input: { taskId: failed.id } });
    await product.runner.idle();
    assert.deepEqual(routes, ['unavailable', 'replacement', 'replacement']);
    assert.equal((await engine.admin<Task>('getTask', { taskId: failed.id })).status, 'completed');
  } finally { await product.dispose(); }
});
