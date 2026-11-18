import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelResult } from '../src/mcp/model-view.js';
import { notesCommandSchema, notesSchema, notesToolSchema } from '../src/mcp/schema.js';
import { NotesEngine } from '../src/engine/index.js';
import type { JsonObject } from '../src/contracts.js';

test('model schema and note results contain natural text and pagination without revision tokens', () => {
  assert.equal('revision' in (notesToolSchema.parameters.properties as object), false);
  assert.equal(notesSchema.safeParse({ action: 'view', path: '角色.md', revision: 'private' }).success, false);
  assert.equal(notesCommandSchema.safeParse({ action: 'view', path: '角色.md', revision: 'private' }).success, true);
  assert.deepEqual(modelResult({ kind: 'file', path: '人物/小夫.md', content: '喜欢温水。', revision: 'private-revision', startLine: 1, totalLines: 201, nextStartLine: 101 }), {
    kind: 'file', path: '人物/小夫.md', content: '喜欢温水。', startLine: 1, totalLines: 201, nextStartLine: 101,
  });
});
test('source dialogue hides database/message identities while preserving names, full text, time and readable attachment fields', () => {
  const projected = modelResult({
    kind: 'dialogue', offset: 0, total: 1, nextOffset: null,
    messages: [{
      seq: 34, sessionId: 'private-session-uuid', messageId: 'private-message-uuid',
      party: 'human', speaker: '小夫', text: '原话完整保留。\n第二行。', at: '2026-11-17T10:00:00Z',
      attachments: [{ type: 'file', ref: { id: 'private-attachment-uuid', filename: '旅行照片.png', mimeType: 'image/png', size: 900 } }],
    }],
  });
  const text = JSON.stringify(projected);
  assert.doesNotMatch(text, /private-|seq|sessionId|messageId/);
  assert.match(text, /小夫/); assert.match(text, /第二行/); assert.match(text, /旅行照片/);
  assert.equal((projected.messages as JsonObject[])[0]!.at, '2026-11-17T10:00:00Z');
});
test('legacy evidence keeps complete meaningful fields but removes primary keys and nested reference identities', () => {
  const projected = modelResult({
    kind: 'sources', path: '人物/小夫.md', total: 1, nextOffset: null,
    sources: [{ kind: 'legacy', table: 'person_facts', record: {
      id: 50, subject_person_key: 'private-person', object_person_key: 'private-other',
      source_context_session: 'private-session', source_msg_start_id: 7, source_msg_end_id: 8,
      fact_key: '饮品偏好', fact_value: '11月10日以后改喝温水。\n不是热茶。', confidence: 0.9,
      created_at: '2026-11-10T12:00:00Z', data: JSON.stringify({ operation_id: 'private-operation', text: '完整的补充原话。' }),
    } }],
  });
  const text = JSON.stringify(projected);
  assert.doesNotMatch(text, /private-|subject.person|source.msg|operation.id/);
  assert.match(text, /饮品偏好/); assert.match(text, /不是热茶/); assert.match(text, /完整的补充原话/);
  assert.match(text, /2026-11-10/);
});
test('hidden read CAS protects model exact edits across another actor write and permits stable operation replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-model-cas-'));
  const engine = new NotesEngine(root);
  try {
    await engine.execute({ action: 'create', path: '随记/共同.md', content: '第一件事。\n第二件事。' });
    const read = await engine.execute({ action: 'view', path: '随记/共同.md' }, { actor: 'chat:a' });
    assert.equal('revision' in modelResult(read), false);
    await engine.execute({ action: 'edit', path: '随记/共同.md', oldText: '第二件事。', newText: '别人改过第二件事。' }, { actor: 'chat:b' });
    await assert.rejects(engine.execute({ action: 'edit', path: '随记/共同.md', oldText: '第一件事。', newText: '我改第一件事。' }, { actor: 'chat:a' }), /重新读取/);
    await engine.execute({ action: 'view', path: '随记/共同.md' }, { actor: 'chat:a' });
    const command = { action: 'edit' as const, path: '随记/共同.md', oldText: '第一件事。', newText: '我改第一件事。' };
    await engine.execute(command, { actor: 'chat:a', operationId: 'stable-edit' });
    await engine.execute(command, { actor: 'chat:a', operationId: 'stable-edit' });
    assert.equal(engine.files.read('随记/共同.md'), '我改第一件事。\n别人改过第二件事。');
  } finally { engine.close(); }
});
test('daily manifest stays immutable when another actor shortens an unread note', async () => {
  const engine = new NotesEngine(mkdtempSync(join(tmpdir(), 'notes-daily-cas-')));
  try {
    const original = Array.from({ length: 205 }, (_, index) => `原始第${index + 1}行`).join('\n');
    await engine.execute({ action: 'create', path: '随记/旧长文.md', content: original });
    const task = engine.registerDaily('2026-11-18'); engine.nextTask();
    await engine.execute({ action: 'view', path: '随记/旧长文.md', lineCount: 200 }, { taskId: task.id });
    await engine.execute({ action: 'edit', path: '随记/旧长文.md', oldText: original, newText: '后来缩成一行。' }, { actor: 'chat:other' });
    const tail = await engine.execute({ action: 'view', path: '随记/旧长文.md', startLine: 201 }, { taskId: task.id });
    assert.match(String(tail.content), /原始第205行/);
    assert.equal(tail.archived, true);
    const manifest = engine.tasks.manifestSnapshot(task.id, '随记/旧长文.md')!;
    assert.equal(manifest.content, original);
    assert.equal(manifest.line_count, 205);
    const current = await engine.execute({ action: 'view', path: '随记/旧长文.md' }, { taskId: task.id });
    assert.equal(current.content, '后来缩成一行。');
    for (const path of ['角色.md', '目录.md']) await engine.execute({ action: 'view', path }, { taskId: task.id });
    assert.equal(engine.finishTask(task.id).status, 'completed');
  } finally { engine.close(); }
});
test('hidden directory CAS rejects another actor new child and allows reread or the models own child edits', async () => {
  const engine = new NotesEngine(mkdtempSync(join(tmpdir(), 'notes-directory-cas-')));
  try {
    await engine.execute({ action: 'create', path: '往事/最初.md', content: '最初的笔记。' });
    await engine.execute({ action: 'view', path: '往事' }, { actor: 'chat:a' });
    await engine.execute({ action: 'create', path: '往事/别人新增.md', content: '新增的内容。' }, { actor: 'chat:b' });
    await assert.rejects(engine.execute({ action: 'delete', path: '往事' }, { actor: 'chat:a' }), /重新读取/);
    await assert.rejects(engine.execute({ action: 'move', path: '往事', to: '历史' }, { actor: 'chat:a' }), /重新读取/);
    // An unrelated own edit cannot silently accept the unseen new child.
    await engine.execute({ action: 'edit', path: '往事/最初.md', oldText: '最初', newText: '原来的' }, { actor: 'chat:a' });
    await assert.rejects(engine.execute({ action: 'move', path: '往事', to: '历史' }, { actor: 'chat:a' }), /重新读取/);
    await engine.execute({ action: 'view', path: '往事' }, { actor: 'chat:a' });
    await engine.execute({ action: 'create', path: '往事/自己新增.md', content: '自己刚写的。' }, { actor: 'chat:a' });
    await engine.execute({ action: 'move', path: '往事', to: '历史' }, { actor: 'chat:a' });
    assert.equal(engine.files.read('历史/别人新增.md'), '新增的内容。');
    await engine.execute({ action: 'view', path: '历史' }, { actor: 'chat:a' });
    await engine.execute({ action: 'edit', path: '历史/别人新增.md', oldText: '新增的内容。', newText: '别人修改过的内容。' }, { actor: 'chat:b' });
    await assert.rejects(engine.execute({ action: 'delete', path: '历史' }, { actor: 'chat:a' }), /重新读取/);
    await engine.execute({ action: 'view', path: '历史' }, { actor: 'chat:a' });
    await engine.execute({ action: 'delete', path: '历史' }, { actor: 'chat:a' });
    assert.equal(engine.files.kind('历史'), null);
  } finally { engine.close(); }
});
