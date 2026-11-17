import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  DialogueInput, Json, JsonObject, NotesCommand, OperationContext, RoleEngine,
  Task, TranscriptEntry, Trigger, Version,
} from '../contracts.js';
import { openDatabase, transaction } from './database.js';
import { digest, FilePlan, NotesError, NotesFiles, rewriteLinks, timestamp } from './files.js';
import { pageNumber, sourceFromRow, TaskStore } from './tasks.js';

interface OperationRow {
  id: string; fingerprint: string; kind: string; status: string; plan: string;
  result: string; task_id: string | null; actor: string | null; at: string;
}
export { NotesError };

/** A role's engine. Only notes/ is model writable; state.sqlite is host-owned. */
export class NotesEngine implements RoleEngine {
  readonly db: DatabaseSync;
  readonly files: NotesFiles;
  readonly tasks: TaskStore;
  readonly root: string;
  private readonly lockPath: string;
  private readonly leasePath: string;
  private readonly leaseToken = randomUUID();
  private leaseFd: number | undefined;
  private closed = false;
  constructor(roleRoot: string, options: { roleName?: string; roleCardPath?: string } = {}) {
    mkdirSync(roleRoot, { recursive: true });
    this.root = roleRoot;
    this.lockPath = join(roleRoot, '.notes-write.lock');
    this.leasePath = join(roleRoot, '.notes-engine.lock');
    this.db = openDatabase(roleRoot);
    let ownerClaimed = false;
    try {
      // SQLite serializes stale-owner reclamation, avoiding a file-lock unlink race.
      transaction(this.db, () => {
        const owner = this.db.prepare('SELECT pid,token FROM engine_owner WHERE slot=1').get() as { pid: number; token: string } | undefined;
        if (owner) {
          let alive = true;
          try { process.kill(Number(owner.pid), 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
          if (alive) throw new NotesError('LOCKED', '这个角色的记忆引擎正在使用该目录，请先关闭另一个连接。');
        }
        this.db.prepare('INSERT OR REPLACE INTO engine_owner(slot,pid,token) VALUES(1,?,?)').run(process.pid, this.leaseToken);
        ownerClaimed = true;
      });
      // The transactional owner lease is authoritative. A crashed writer may
      // have left either diagnostic file empty before its metadata was flushed.
      rmSync(this.leasePath, { force: true });
      rmSync(this.lockPath, { force: true });
      this.leaseFd = this.acquireLock(this.leasePath, this.leaseToken);
      this.files = new NotesFiles(join(roleRoot, 'notes'));
      this.tasks = new TaskStore(this.db, this.files);
      this.withLock(() => {
        this.recover();
        if (!this.setting('roleCardPath')) this.setSetting('roleCardPath', this.files.normalize(options.roleCardPath ?? '角色.md'));
        if (!this.setting('initialized')) {
          const card = this.setting('roleCardPath')!;
          const changes = [];
          if (!this.files.kind(card)) changes.push({ path: card, before: null, after: `# ${options.roleName ?? '角色'}\n\n请在这里用自然语言写下自己的身份、性格和说话方式。\n` });
          if (!this.files.kind('目录.md')) changes.push({ path: '目录.md', before: null, after: '# 记忆目录\n\n这里是自己的笔记。可以自由修改组织方式、创建和整理卡片组。\n\n- [人物](人物/)\n- [经历](经历/)\n- [随记](随记/)\n' });
          this.files.apply({ changes, createDirectories: ['人物', '经历', '随记'], deleteDirectories: [] });
          this.setSetting('initialized', 'true');
        }
      });
    } catch (error) {
      // Construction can fail during journal recovery; do not strand the live-PID lease.
      if (ownerClaimed) this.db.prepare('DELETE FROM engine_owner WHERE slot=1 AND token=?').run(this.leaseToken);
      this.db.close();
      if (this.leaseFd !== undefined) {
        closeSync(this.leaseFd); this.leaseFd = undefined;
        this.removeOwnedLock(this.leasePath, this.leaseToken);
      }
      throw error;
    }
  }
  private setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  private setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  private acquireLock(path: string, token = randomUUID()): number {
    let fd: number;
    try { fd = openSync(path, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = 0;
      try { owner = Number(JSON.parse(readFileSync(path, 'utf8')).pid); } catch { /* corrupt lock remains visible */ }
      let alive = true;
      if (owner > 0) try { process.kill(owner, 0); } catch (check) { alive = (check as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive) throw new NotesError('LOCKED', '这个角色的记忆引擎正在使用该目录，请先关闭另一个连接。');
      rmSync(path);
      fd = openSync(path, 'wx');
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: timestamp() })); }
    catch (error) { closeSync(fd); rmSync(path, { force: true }); throw error; }
    return fd;
  }
  private removeOwnedLock(path: string, token: string): void {
    if (!existsSync(path)) return;
    let actual: { token?: string };
    try { actual = JSON.parse(readFileSync(path, 'utf8')) as { token?: string }; } catch { return; }
    if (actual.token === token) rmSync(path, { force: true });
  }
  private withLock<T>(fn: () => T): T {
    const token = randomUUID(), fd = this.acquireLock(this.lockPath, token);
    try { return fn(); }
    finally { closeSync(fd); this.removeOwnedLock(this.lockPath, token); }
  }
  private recover(): void {
    const pending = this.db.prepare("SELECT * FROM operations WHERE status='prepared' ORDER BY rowid").all() as unknown as OperationRow[];
    for (const operation of pending) this.applyPrepared(operation);
  }
  private applyPrepared(operation: OperationRow): void {
    const plan = JSON.parse(operation.plan) as FilePlan;
    try {
      this.files.apply(plan);
      transaction(this.db, () => {
        for (const change of plan.changes) {
          this.db.prepare('INSERT OR IGNORE INTO versions(path,content,operation,at,operation_id) VALUES (?,?,?,?,?)')
            .run(change.path, change.before, `before:${operation.kind}`, operation.at, `before:${operation.id}`);
          this.db.prepare('INSERT OR IGNORE INTO versions(path,content,operation,at,operation_id) VALUES (?,?,?,?,?)')
            .run(change.path, change.after, operation.kind, operation.at, operation.id);
          const sources = operation.task_id
            ? this.db.prepare('SELECT source_key FROM task_reads WHERE task_id=?').all(operation.task_id)
            : operation.actor ? this.db.prepare('SELECT source_key FROM actor_reads WHERE actor=?').all(operation.actor) : [];
          for (const source of sources as { source_key: string }[])
            this.db.prepare('INSERT OR IGNORE INTO provenance(path,source_key,operation_id) VALUES (?,?,?)')
              .run(change.path, source.source_key, operation.id);
          const scope = operation.task_id ? `task:${operation.task_id}` : operation.actor ? `actor:${operation.actor}` : undefined;
          if (scope) {
            if (change.after === null) this.db.prepare('DELETE FROM read_revisions WHERE scope=? AND path=?').run(scope, change.path);
            else this.db.prepare('INSERT INTO read_revisions(scope,path,revision) VALUES(?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=excluded.revision')
              .run(scope, change.path, digest(change.after));
          }
        }
        if (plan.roleCard !== undefined) this.setSetting('roleCardPath', plan.roleCard);
        for (const alias of plan.aliases ?? []) {
          this.db.prepare('INSERT OR IGNORE INTO source_aliases(path,original_path) VALUES (?,?)').run(alias.to, alias.from);
          this.db.prepare('INSERT OR IGNORE INTO provenance(path,source_key,operation_id) SELECT ?,source_key,operation_id FROM provenance WHERE path=?')
            .run(alias.to, alias.from);
        }
        const scope = operation.task_id ? `task:${operation.task_id}` : operation.actor ? `actor:${operation.actor}` : undefined;
        if (scope) for (const previous of plan.directoryReads ?? []) {
          const current = this.db.prepare('SELECT revision FROM read_revisions WHERE scope=? AND path=?').get(scope, previous.path) as { revision: string } | undefined;
          if (current?.revision !== previous.revision) continue;
          if (this.files.kind(previous.path) === 'directory')
            this.db.prepare('UPDATE read_revisions SET revision=? WHERE scope=? AND path=?').run(this.pathRevision(previous.path), scope, previous.path);
          else this.db.prepare('DELETE FROM read_revisions WHERE scope=? AND path=?').run(scope, previous.path);
        }
        this.db.prepare("UPDATE operations SET status='applied',error=NULL WHERE id=?").run(operation.id);
      });
    } catch (error) {
      this.db.prepare('UPDATE operations SET error=? WHERE id=?').run(error instanceof Error ? error.message : String(error), operation.id);
      throw error;
    }
  }
  private mutate(kind: string, payload: Json, planBuilder: () => { plan: FilePlan; result: JsonObject }, context: OperationContext): JsonObject {
    const operationId = context.operationId ?? randomUUID();
    const fingerprint = digest(JSON.stringify({ kind, payload, taskId: context.taskId ?? null, actor: context.actor ?? null }));
    return this.withLock(() => {
      this.recover();
      const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId) as unknown as OperationRow | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new NotesError('OPERATION_CONFLICT', '重放操作的参数与原操作不同。');
        return JSON.parse(previous.result) as JsonObject;
      }
      if (context.taskId) this.tasks.assertActive(context.taskId);
      const { plan, result } = planBuilder();
      const scope = this.readScope(context);
      if (scope) {
        const affected = [...plan.changes.map(change => change.path), ...plan.createDirectories, ...plan.deleteDirectories];
        plan.directoryReads = (this.db.prepare('SELECT path,revision FROM read_revisions WHERE scope=?').all(scope) as { path: string; revision: string }[])
          .filter(previous => affected.some(path => !previous.path || path === previous.path || path.startsWith(`${previous.path}/`)) &&
            this.files.kind(previous.path) === 'directory' && this.pathRevision(previous.path) === previous.revision);
      }
      const at = timestamp();
      // The plan and both file states are durable before the first filesystem mutation.
      this.db.prepare('INSERT INTO operations(id,fingerprint,kind,status,plan,result,task_id,actor,at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(operationId, fingerprint, kind, 'prepared', JSON.stringify(plan), JSON.stringify(result), context.taskId ?? null, context.actor ?? null, at);
      const operation = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId) as unknown as OperationRow;
      this.applyPrepared(operation);
      return result;
    });
  }
  private path(command: NotesCommand, optional = false): string {
    const normalized = this.files.normalize(command.path ?? '');
    if (!optional && !normalized) throw new NotesError('INVALID_PATH', '这项操作需要笔记路径。');
    return normalized;
  }
  private readScope(context: OperationContext): string | undefined {
    return context.taskId ? `task:${context.taskId}` : context.actor ? `actor:${context.actor}` : undefined;
  }
  private pathRevision(path: string): string {
    if (this.files.kind(path) === 'file') return digest(this.files.read(path));
    const tree = (directory: string): Json[] => this.files.list(directory).map(entry =>
      entry.kind === 'directory' ? [entry.path, 'directory', tree(entry.path)] : [entry.path, 'file', digest(this.files.read(entry.path))]);
    return digest(JSON.stringify(tree(path)));
  }
  private checkRevision(path: string, revision: string | undefined, context: OperationContext): void {
    const scope = this.readScope(context);
    if (revision === undefined && scope) revision = (this.db.prepare('SELECT revision FROM read_revisions WHERE scope=? AND path=?').get(scope, path) as { revision: string } | undefined)?.revision;
    if (revision !== undefined && this.pathRevision(path) !== revision)
      throw new NotesError('STALE_REVISION', '笔记已经被修改，请重新读取后再编辑。');
  }
  private readSource(context: OperationContext, key: string, content: string, metadata: JsonObject): void {
    this.db.prepare('INSERT OR IGNORE INTO source_documents(source_key,kind,content,metadata) VALUES (?,?,?,?)')
      .run(key, 'note', content, JSON.stringify(metadata));
    if (context.actor) this.db.prepare('INSERT OR IGNORE INTO actor_reads(actor,source_key) VALUES (?,?)').run(context.actor, key);
  }
  async execute(command: NotesCommand, context: OperationContext = {}): Promise<JsonObject> {
    if (!command || !['view', 'search', 'create', 'edit', 'move', 'delete', 'sources'].includes(command.action))
      throw new NotesError('INVALID_ACTION', '不支持这个笔记操作。');
    if (context.taskId) this.tasks.assertActive(context.taskId);
    const path = this.path(command, ['view', 'search', 'sources'].includes(command.action));
    switch (command.action) {
      case 'view': return this.view(path, command, context);
      case 'search': return this.search(path, command);
      case 'sources': return this.sources(path, command, context);
      case 'create': return this.mutate('create', command as unknown as Json, (): { plan: FilePlan; result: JsonObject } => {
        if (this.files.kind(path)) throw new NotesError('ALREADY_EXISTS', '同名笔记或目录已经存在。');
        if (command.kind === 'directory') return {
          plan: { changes: [], createDirectories: [path], deleteDirectories: [] },
          result: { saved: true, kind: 'directory', path },
        };
        if (typeof command.content !== 'string') throw new NotesError('INVALID_CONTENT', '新笔记需要文本内容。');
        return {
          plan: { changes: [{ path, before: null, after: command.content }], createDirectories: [], deleteDirectories: [] },
          result: { saved: true, kind: 'file', path, revision: digest(command.content) },
        };
      }, context);
      case 'edit': return this.mutate('edit', command as unknown as Json, () => {
        const before = this.files.read(path);
        this.checkRevision(path, command.revision, context);
        if (typeof command.oldText !== 'string' || typeof command.newText !== 'string')
          throw new NotesError('INVALID_EDIT', '编辑需要原文和替换文本。');
        if (!command.oldText) {
          if (before !== '') throw new NotesError('AMBIGUOUS_EDIT', '空原文只能用于空文件。');
        } else if (before.split(command.oldText).length !== 2)
          throw new NotesError('AMBIGUOUS_EDIT', '原文必须在当前笔记中精确且只出现一次。');
        const after = command.oldText ? before.replace(command.oldText, command.newText) : command.newText;
        return {
          plan: { changes: [{ path, before, after }], createDirectories: [], deleteDirectories: [] },
          result: { saved: true, kind: 'file', path, revision: digest(after) },
        };
      }, context);
      case 'move': return this.move(path, command, context);
      case 'delete': return this.mutate('delete', command as unknown as Json, () => {
        const kind = this.files.kind(path);
        if (!kind) throw new NotesError('NOT_FOUND', '找不到要删除的笔记或目录。');
        this.checkRevision(path, command.revision, context);
        return {
          plan: {
            changes: this.files.walk(path).map(file => ({ path: file.path, before: file.content, after: null })),
            createDirectories: [], deleteDirectories: kind === 'directory' ? this.files.directories(path) : [],
          },
          result: { saved: true, deleted: true, path, recoverable: true },
        };
      }, context);
    }
  }
  private view(path: string, command: NotesCommand, context: OperationContext): JsonObject {
    const kind = this.files.kind(path);
    const snapshot = context.taskId ? this.tasks.manifestSnapshot(context.taskId, path) : undefined;
    if (kind === 'directory' && !snapshot) {
      const offset = pageNumber(command.offset, 0, Number.MAX_SAFE_INTEGER), limit = pageNumber(command.limit, 50, 100);
      if (!limit) throw new NotesError('INVALID_PAGE', '每页条目数量必须大于零。');
      const entries = this.files.list(path), page = entries.slice(offset, offset + limit);
      const scope = this.readScope(context);
      if (scope) this.db.prepare('INSERT INTO read_revisions(scope,path,revision) VALUES(?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=excluded.revision')
        .run(scope, path, this.pathRevision(path));
      return { kind, path, entries: page, total: entries.length, offset, nextOffset: offset + page.length < entries.length ? offset + page.length : null };
    }
    if (kind !== 'file' && !snapshot) throw new NotesError('NOT_FOUND', '找不到这个笔记。');
    const live = kind === 'file' ? this.files.read(path) : null;
    const changed = !!snapshot && (live === null || digest(live) !== snapshot.revision);
    const snapshotIncomplete = !!snapshot && (JSON.parse(snapshot.read_lines) as number[]).length < snapshot.line_count;
    const useSnapshot = !!snapshot && (live === null || changed && snapshotIncomplete);
    const content = useSnapshot ? snapshot!.content : live!, lines = content.split('\n');
    const startLine = pageNumber(command.startLine, 1, Number.MAX_SAFE_INTEGER), count = pageNumber(command.lineCount, 100, 200);
    if (!startLine || !count) throw new NotesError('INVALID_PAGE', '起始行和每页行数必须大于零。');
    const page = lines.slice(startLine - 1, startLine - 1 + count);
    if (context.taskId) this.tasks.recordFileRead(context.taskId, path, content, startLine, page.length);
    const revision = digest(content);
    const scope = this.readScope(context);
    if (scope) this.db.prepare('INSERT INTO read_revisions(scope,path,revision) VALUES(?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=excluded.revision')
      .run(scope, path, revision);
    this.readSource(context, `note:${path}@${revision}`, content, { path, revision });
    return { kind: 'file', path, content: page.join('\n'), revision, startLine, totalLines: lines.length, archived: useSnapshot,
      ...(changed && useSnapshot ? { status: '这份笔记在整理开始后发生变化。这里显示本次起始原文；请先逐页读完，再重新读取当前内容后编辑。' } : {}),
      nextStartLine: startLine - 1 + page.length < lines.length ? startLine + page.length : null };
  }
  private search(path: string, command: NotesCommand): JsonObject {
    if (typeof command.query !== 'string' || !command.query.trim()) throw new NotesError('INVALID_QUERY', '请输入要寻找的自然语言词语或短句。');
    const offset = pageNumber(command.offset, 0, Number.MAX_SAFE_INTEGER), limit = pageNumber(command.limit, 20, 100);
    if (!limit) throw new NotesError('INVALID_PAGE', '每页结果数量必须大于零。');
    const query = command.query.toLocaleLowerCase();
    const terms = query.trim().split(/\s+/);
    const matches: { path: string; line: number; snippet: string }[] = [];
    for (const file of this.files.walk(path)) {
      const content = file.content!, lower = content.toLocaleLowerCase(), filename = file.path.toLocaleLowerCase();
      if (!terms.every(term => lower.includes(term) || filename.includes(term))) continue;
      const lines = content.split('\n');
      const index = lines.findIndex(line => terms.some(term => line.toLocaleLowerCase().includes(term)));
      const line = index < 0 ? 1 : index + 1;
      matches.push({ path: file.path, line, snippet: lines.slice(Math.max(0, line - 2), line + 1).join('\n') });
    }
    const page = matches.slice(offset, offset + limit);
    return { kind: 'search', query: command.query, path, matches: page, total: matches.length, offset,
      nextOffset: offset + page.length < matches.length ? offset + page.length : null };
  }
  private sources(path: string, command: NotesCommand, context: OperationContext): JsonObject {
    if (!path) {
      if (!context.taskId) throw new NotesError('TASK_REQUIRED', '读取待整理对话需要当前后台任务。');
      return this.tasks.sourcePage(context.taskId, command.offset, command.limit);
    }
    const offset = pageNumber(command.offset, 0, Number.MAX_SAFE_INTEGER), limit = pageNumber(command.limit, 20, 100);
    if (!limit) throw new NotesError('INVALID_PAGE', '每页来源数量必须大于零。');
    const rows = this.db.prepare('SELECT DISTINCT source_key FROM provenance WHERE path=? ORDER BY source_key').all(path) as { source_key: string }[];
    const imported = this.importedSources(path);
    const total = rows.length + imported.length;
    const sources: JsonObject[] = [];
    for (let index = offset; index < Math.min(offset + limit, total); index++) {
      if (index < rows.length) {
        const row = rows[index]!;
        sources.push(this.resolveSource(row.source_key));
        if (context.taskId) this.db.prepare('INSERT OR IGNORE INTO task_reads(task_id,source_key) VALUES (?,?)').run(context.taskId, row.source_key);
        if (context.actor) this.db.prepare('INSERT OR IGNORE INTO actor_reads(actor,source_key) VALUES (?,?)').run(context.actor, row.source_key);
      } else {
        const source = imported[index - rows.length]!;
        sources.push(source);
        const key = `import:${path}:${digest(JSON.stringify(source))}`;
        this.db.prepare('INSERT OR IGNORE INTO source_documents(source_key,kind,content,metadata) VALUES (?,?,?,?)')
          .run(key, 'legacy', JSON.stringify(source), JSON.stringify({ path }));
        if (context.taskId) this.db.prepare('INSERT OR IGNORE INTO task_reads(task_id,source_key) VALUES (?,?)').run(context.taskId, key);
        if (context.actor) this.db.prepare('INSERT OR IGNORE INTO actor_reads(actor,source_key) VALUES (?,?)').run(context.actor, key);
      }
    }
    return { kind: 'sources', path, sources, total, offset,
      nextOffset: offset + sources.length < total ? offset + sources.length : null,
      explanation: '这些是编辑时读取过的材料；不表示每句话都有逐字验证的证据。' };
  }
  private importedSources(path: string): JsonObject[] {
    const migrationPath = join(this.root, 'migration.sqlite');
    if (!existsSync(migrationPath)) return [];
    const paths = new Set([path]), pending = [path];
    while (pending.length) {
      const current = pending.pop()!;
      for (const row of this.db.prepare('SELECT original_path FROM source_aliases WHERE path=?').all(current) as { original_path: string }[])
        if (!paths.has(row.original_path)) { paths.add(row.original_path); pending.push(row.original_path); }
    }
    const legacy = new DatabaseSync(migrationPath, { readOnly: true });
    try {
      const results = new Map<string, JsonObject>();
      const select = legacy.prepare(`SELECT r.source_key,r.table_name,r.record_key,r.data
        FROM note_sources n JOIN records r ON r.source_key=n.source_key AND r.table_name=n.table_name AND r.record_key=n.record_key
        WHERE n.path=? ORDER BY r.table_name,r.record_key`);
      for (const original of paths) for (const row of select.all(original) as {
        source_key: string; table_name: string; record_key: string; data: string;
      }[]) {
        results.set(`${row.source_key}:${row.table_name}:${row.record_key}:${digest(row.data)}`,
          { kind: 'legacy', table: row.table_name, record: JSON.parse(row.data) as Json });
      }
      return [...results.values()];
    } finally { legacy.close(); }
  }
  private resolveSource(key: string): JsonObject {
    if (key.startsWith('dialogue:')) {
      const row = this.db.prepare('SELECT * FROM dialogue WHERE seq=?').get(Number(key.slice(9)));
      if (row) return { kind: 'dialogue', ...sourceFromRow(row as unknown as Parameters<typeof sourceFromRow>[0]) } as unknown as JsonObject;
    }
    const row = this.db.prepare('SELECT kind,content,metadata FROM source_documents WHERE source_key=?').get(key) as
      { kind: string; content: string; metadata: string } | undefined;
    if (row) return { kind: row.kind, content: row.content, metadata: JSON.parse(row.metadata) as Json };
    return { kind: 'unavailable', description: '来源索引仍保留，原材料暂不可用。' };
  }
  private move(path: string, command: NotesCommand, context: OperationContext): JsonObject {
    return this.mutate('move', command as unknown as Json, () => {
      const to = this.files.normalize(command.to ?? '');
      if (!to || !this.files.kind(path)) throw new NotesError('NOT_FOUND', '移动需要现有源路径和目标相对路径。');
      if (to === path || to.startsWith(`${path}/`)) throw new NotesError('INVALID_MOVE', '不能把目录移动到自身内部。');
      if (this.files.kind(to)) throw new NotesError('ALREADY_EXISTS', '目标路径已经存在。');
      this.checkRevision(path, command.revision, context);
      const moving = this.files.walk(path), moved = new Map(moving.map(file => [file.path, to + file.path.slice(path.length)]));
      const sourceDirectories = this.files.kind(path) === 'directory' ? this.files.directories(path) : [];
      for (const directory of sourceDirectories) moved.set(directory, to + directory.slice(path.length));
      const all = this.files.walk(), changes = [];
      for (const file of all) {
        const finalPath = moved.get(file.path) ?? file.path;
        const after = rewriteLinks(file.content!, file.path, finalPath, moved);
        if (finalPath !== file.path) {
          changes.push({ path: file.path, before: file.content, after: null });
          changes.push({ path: finalPath, before: null, after });
        } else if (after !== file.content) changes.push({ path: file.path, before: file.content, after });
      }
      const pinned = this.setting('roleCardPath')!;
      return {
        plan: { changes, createDirectories: sourceDirectories.map(directory => to + directory.slice(path.length)),
          deleteDirectories: sourceDirectories,
          aliases: moving.map(file => ({ from: file.path, to: to + file.path.slice(path.length) })),
          ...(pinned === path || pinned.startsWith(`${path}/`) ? { roleCard: to + pinned.slice(path.length) } : {}) },
        result: { saved: true, moved: true, path, to, updatedLinksIn: changes.filter(change => change.after !== null).map(change => change.path) },
      };
    }, context);
  }
  roleCard(): { path: string; content: string | null } {
    const path = this.setting('roleCardPath') ?? '角色.md';
    return { path, content: this.files.maybeRead(path) };
  }
  captureDialogue(input: DialogueInput): { seq: number; inserted: boolean } { return this.tasks.capture(input); }
  registerTrigger(trigger: Trigger): Task { return this.tasks.register(trigger); }
  registerDaily(day: string): Task { return this.tasks.registerDaily(day); }
  listTasks(): Task[] { return this.tasks.list(); }
  nextTask(): Task | null { return this.tasks.next(); }
  getTask(taskId: string): Task { return this.tasks.get(taskId); }
  retryTask(taskId: string): Task { return this.tasks.retry(taskId); }
  stopTask(taskId: string): Task { return this.tasks.stop(taskId); }
  finishTask(taskId: string): Task { return this.tasks.finish(taskId); }
  failTask(taskId: string, error: string): Task { return this.tasks.setStatus(taskId, 'failed', error); }
  transcript(taskId: string): TranscriptEntry[] { return this.tasks.transcript(taskId); }
  appendTranscript(taskId: string, entry: TranscriptEntry): void { this.tasks.append(taskId, entry); }
  versions(path: string): Version[] {
    path = this.files.normalize(path);
    return (this.db.prepare('SELECT id,path,content,operation,at FROM versions WHERE path=? ORDER BY id DESC').all(path) as unknown as Version[])
      .map(row => ({ ...row, id: Number(row.id) }));
  }
  async undo(versionId: number, context: OperationContext = {}): Promise<JsonObject> {
    const version = this.db.prepare('SELECT * FROM versions WHERE id=?').get(versionId) as unknown as Version | undefined;
    if (!version) throw new NotesError('VERSION_NOT_FOUND', '找不到要恢复的笔记版本。');
    return this.mutate('undo', { versionId }, () => {
      if (this.files.kind(version.path) === 'directory') throw new NotesError('RESTORE_CONFLICT', '这个笔记路径目前被目录占用，请先移动该目录。');
      return {
        plan: { changes: [{ path: version.path, before: this.files.maybeRead(version.path), after: version.content }],
          createDirectories: [], deleteDirectories: [] },
        result: { saved: true, path: version.path, restored: true, deleted: version.content === null },
      };
    }, context);
  }
  stats(): JsonObject {
    const count = (table: string): number => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    const tasks = this.listTasks(), blocking = tasks.find(task => task.status === 'failed' || task.status === 'stopped');
    return { files: this.files.walk().length, dialogue: count('dialogue'), versions: count('versions'),
      tasks: tasks.length, pending: tasks.filter(task => task.status !== 'completed').length,
      unprocessedMessages: Number((this.db.prepare('SELECT COUNT(*) AS count FROM dialogue d LEFT JOIN cursors c ON c.session_id=d.session_id WHERE d.seq>COALESCE(c.seq,0)').get() as { count: number }).count),
      blockedBy: blocking?.id ?? null, roleCardMissing: this.roleCard().content === null };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.prepare('DELETE FROM engine_owner WHERE slot=1 AND token=?').run(this.leaseToken);
      this.db.close();
    }
    finally {
      if (this.leaseFd !== undefined) { closeSync(this.leaseFd); this.leaseFd = undefined; }
      this.removeOwnedLock(this.leasePath, this.leaseToken);
    }
  }
}
