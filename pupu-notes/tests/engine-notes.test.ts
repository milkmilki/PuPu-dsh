import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotesEngine } from '../src/engine/index.js';
import { digest } from '../src/engine/files.js';
import { DatabaseSync } from 'node:sqlite';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-engine-'));
  return { root, engine: new NotesEngine(root, { roleName: '璐璐' }) };
};
test('natural note edits are exact, replay-safe, versioned and scoped to one role', async () => {
  const { engine } = setup();
  const other = setup().engine;
  const original = '小夫喜欢热茶。\n最近计划去海边。';
  const command = { action: 'create' as const, path: '人物/小夫.md', content: original };
  await engine.execute(command, { operationId: 'create-once' });
  assert.deepEqual(await engine.execute(command, { operationId: 'create-once' }), { saved: true, kind: 'file', path: command.path, revision: digest(original) });
  await assert.rejects(engine.execute({ ...command, content: '别的内容' }, { operationId: 'create-once' }), /参数/);
  const read = await engine.execute({ action: 'view', path: command.path });
  assert.equal(read.content, original);
  await engine.execute({ action: 'edit', path: command.path, oldText: '热茶', newText: '温水', revision: String(read.revision) });
  await assert.rejects(engine.execute({ action: 'edit', path: command.path, oldText: '温水', newText: '果汁', revision: String(read.revision) }), /重新读取/);
  assert.equal((await engine.execute({ action: 'search', query: '温水' })).total, 1);
  assert.equal((await other.execute({ action: 'search', query: '温水' })).total, 0);
  const originalVersion = engine.versions(command.path).find(version => version.content === original)!;
  await engine.undo(originalVersion.id);
  assert.equal((await engine.execute({ action: 'view', path: command.path })).content, original);
  engine.close(); other.close();
});
test('move fixes note links, retains pinned role-card entry and delete restores through versions', async () => {
  const { engine } = setup();
  await engine.execute({ action: 'create', path: '经历/出游.md', content: '我们看过日落。' });
  await engine.execute({ action: 'edit', path: '目录.md', oldText: '# 记忆目录', newText: '# 记忆目录\n\n[出游](经历/出游.md)' });
  await engine.execute({ action: 'move', path: '经历', to: '往事' });
  assert.match(String((await engine.execute({ action: 'view', path: '目录.md' })).content), /\(往事\/出游.md\)/);
  assert.equal((await engine.execute({ action: 'view', path: '往事/出游.md' })).content, '我们看过日落。');
  await engine.execute({ action: 'move', path: '角色.md', to: '自我.md' });
  assert.equal(engine.roleCard().path, '自我.md');
  await engine.execute({ action: 'delete', path: '自我.md' });
  assert.equal(engine.roleCard().content, null);
  const beforeDelete = engine.versions('自我.md').find(version => version.content !== null)!;
  await engine.undo(beforeDelete.id);
  assert.match(engine.roleCard().content!, /璐璐/);
  engine.close();
});
test('daily read coverage cannot be satisfied by directory listings or search snippets', async () => {
  const { engine } = setup();
  await engine.execute({ action: 'create', path: '随记/长文.md', content: Array.from({ length: 205 }, (_, index) => `第${index + 1}行`).join('\n') });
  const task = engine.registerDaily('2026-11-17');
  engine.nextTask();
  await engine.execute({ action: 'view' }, { taskId: task.id });
  await engine.execute({ action: 'search', query: '第1行' }, { taskId: task.id });
  assert.throws(() => engine.finishTask(task.id), /通读/);
  for (const path of ['角色.md', '目录.md']) await engine.execute({ action: 'view', path }, { taskId: task.id });
  const first = await engine.execute({ action: 'view', path: '随记/长文.md', lineCount: 200 }, { taskId: task.id });
  assert.equal(first.nextStartLine, 201);
  assert.throws(() => engine.finishTask(task.id), /通读/);
  await engine.execute({ action: 'view', path: '随记/长文.md', startLine: 201 }, { taskId: task.id });
  assert.equal(engine.finishTask(task.id).status, 'completed');
  engine.close();
});
test('a prepared journal recovers after interruption without duplicate versions', async () => {
  const { engine, root } = setup();
  const plan = { changes: [{ path: '随记/恢复.md', before: null, after: '完整文本' }], createDirectories: [], deleteDirectories: [] };
  engine.db.prepare('INSERT INTO operations(id,fingerprint,kind,status,plan,result,at) VALUES (?,?,?,?,?,?,?)')
    .run('crashed-operation', 'fingerprint', 'create', 'prepared', JSON.stringify(plan), JSON.stringify({ saved: true }), new Date().toISOString());
  // Simulate process termination after the file was written but before operation commit.
  writeFileSync(join(root, 'notes', '随记', '恢复.md'), '完整文本');
  engine.close();
  const reopened = new NotesEngine(root);
  assert.equal((await reopened.execute({ action: 'view', path: '随记/恢复.md' })).content, '完整文本');
  assert.equal(reopened.versions('随记/恢复.md').length, 2);
  reopened.close();
  const twice = new NotesEngine(root);
  assert.equal(twice.versions('随记/恢复.md').length, 2);
  twice.close();
});
test('provenance returns actual source dialogue and original read snapshots', async () => {
  const { engine } = setup();
  engine.captureDialogue({ sessionId: 'a', messageId: '1', party: 'human', speaker: '小夫', text: '我喜欢热茶。', at: new Date().toISOString() });
  const task = engine.registerTrigger({ triggerId: 'x', sessionId: 'a', reason: 'manual' });
  engine.nextTask();
  await engine.execute({ action: 'sources' }, { taskId: task.id });
  await engine.execute({ action: 'create', path: '人物/小夫.md', content: '小夫喜欢热茶。' }, { taskId: task.id, operationId: 'task-write' });
  const result = await engine.execute({ action: 'sources', path: '人物/小夫.md' });
  assert.equal((result.sources as { text: string }[])[0]!.text, '我喜欢热茶。');
  engine.finishTask(task.id);
  engine.close();
});
test('an invalid parent path cannot leave a poisoned write journal and long lines are not truncated', async () => {
  const { engine } = setup();
  await engine.execute({ action: 'create', path: 'a.md', content: '普通文件' });
  await assert.rejects(engine.execute({ action: 'create', path: 'a.md/child.md', content: '无效' }), /目录/);
  const long = '很长的一行'.repeat(10000);
  await engine.execute({ action: 'create', path: '随记/长行.md', content: long });
  assert.equal((await engine.execute({ action: 'view', path: '随记/长行.md' })).content, long);
  engine.close();
});
test('legacy provenance remains queryable after directory moves and keeps changed record versions', async () => {
  const { root, engine } = setup();
  await engine.execute({ action: 'create', path: '经历/旅行.md', content: '过去的一次旅行。' });
  const archive = new DatabaseSync(join(root, 'migration.sqlite'));
  archive.exec(`CREATE TABLE records(source_key TEXT,table_name TEXT,record_key TEXT,fingerprint TEXT,data TEXT);
    CREATE TABLE note_sources(path TEXT,source_key TEXT,table_name TEXT,record_key TEXT);`);
  archive.prepare('INSERT INTO note_sources VALUES(?,?,?,?)').run('经历/旅行.md', 'role', 'event_threads', '1');
  for (const text of ['旧标题', '后来补充的标题'])
    archive.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run('role', 'event_threads', '1', digest(text), JSON.stringify({ title: text }));
  archive.close();
  await engine.execute({ action: 'move', path: '经历', to: '往事' });
  const result = await engine.execute({ action: 'sources', path: '往事/旅行.md' });
  assert.equal(result.total, 2);
  assert.deepEqual((result.sources as { record: { title: string } }[]).map(source => source.record.title).sort(), ['后来补充的标题', '旧标题'].sort());
  engine.close();
});
test('second live engine cannot reset another task queue and closed engine releases its role lease', () => {
  const { engine, root } = setup();
  engine.captureDialogue({ sessionId: 'a', messageId: '1', party: 'human', speaker: '小夫', text: '正在处理。', at: new Date().toISOString() });
  const task = engine.registerTrigger({ triggerId: 'lease', sessionId: 'a', reason: 'manual' });
  engine.nextTask();
  assert.throws(() => new NotesEngine(root), /关闭另一个连接/);
  assert.equal(engine.getTask(task.id).status, 'running');
  engine.close();
  const reopened = new NotesEngine(root);
  assert.equal(reopened.getTask(task.id).status, 'queued');
  reopened.close();
});
test('startup recovers half-written diagnostic locks after a dead owner and constructor failure releases only its lease', () => {
  const { engine, root } = setup();
  engine.close();
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  db.prepare('INSERT INTO engine_owner(slot,pid,token) VALUES(1,?,?)').run(2147483647, 'dead-process');
  db.close();
  writeFileSync(join(root, '.notes-engine.lock'), '');
  writeFileSync(join(root, '.notes-write.lock'), '{"pid":');
  const recovered = new NotesEngine(root);
  assert.match(recovered.roleCard().content!, /璐璐/);
  recovered.close();
  assert.equal(existsSync(join(root, '.notes-engine.lock')), false);
  const badRoot = mkdtempSync(join(tmpdir(), 'notes-bad-init-'));
  assert.throws(() => new NotesEngine(badRoot, { roleCardPath: '../bad.md' }), /路径/);
  assert.equal(existsSync(join(badRoot, '.notes-engine.lock')), false);
  const retry = new NotesEngine(badRoot);
  retry.close();
});
