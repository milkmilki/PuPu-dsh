import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../src/catalog.js';
import { MigrationService, exportPackage, inspectNotesPackage } from '../src/migration.js';
import { restoreState } from '../src/migration/package.js';
import { NotesEngine } from '../src/engine/index.js';
import { strToU8, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { atomicJson, readOnly, tableSnapshot } from '../src/migration/shared.js';
import { validateZip } from '../src/migration/zip.js';

function legacy(root: string) {
  const path = join(root, 'old.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE people(person_key TEXT PRIMARY KEY,display_name TEXT,aliases TEXT);
    CREATE TABLE person_facts(id INTEGER,subject_person_key TEXT,object_person_key TEXT,fact_key TEXT,fact_value TEXT,status TEXT);
    CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp TEXT);
    CREATE TABLE event_threads(id INTEGER,title TEXT,rollup_summary TEXT,status TEXT);
    CREATE TABLE event_steps(id INTEGER,thread_id INTEGER,summary TEXT,cause TEXT,reflection TEXT);
    CREATE TABLE fact_evidence(id INTEGER,fact_id INTEGER,evidence_text TEXT);
    CREATE TABLE summaries(id INTEGER,summary TEXT,created_at TEXT);
    CREATE TABLE model_requests(id INTEGER,status TEXT,request TEXT);
    CREATE TABLE memory_jobs(id INTEGER,status TEXT,payload TEXT);
    INSERT INTO people VALUES('owner','小夫',''),('guest','小夫','另一位');
    INSERT INTO person_facts VALUES(1,'owner','','喜好','不吃香菜','active');
    INSERT INTO person_facts VALUES(2,'guest','','喜好','喜欢香菜','active');
    INSERT INTO messages VALUES(1,'owner','user','不要加香菜','2026-11-17T00:00:00Z');
    INSERT INTO event_threads VALUES(1,'一起吃面','晚餐的约定','active');
    INSERT INTO event_steps VALUES(1,1,'点了清汤面','下雨了','觉得很暖和');
    INSERT INTO fact_evidence VALUES(1,1,'不要加香菜');
    INSERT INTO summaries VALUES(1,'约好下次一起吃面','2026-11-17T00:00:00Z');
    INSERT INTO model_requests VALUES(1,'pending','不应该运行');
    INSERT INTO memory_jobs VALUES(1,'completed','历史任务');
  `);
  db.close();
  return path;
}
test('copy import preserves natural notes, same-name people and immutable record hashes, repeat/delta does not overwrite notes', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-import-'));
  const old = legacy(temp);
  const original = readFileSync(old);
  const catalog = new Catalog(join(temp, 'new'));
  const migration = new MigrationService(catalog);
  const preview = await migration.preview(old);
  assert.equal(preview.counts.person_facts, 2);
  assert.equal(preview.counts.model_requests, undefined);
  await assert.rejects(migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: {}, confirmed: false }));
  const imported = await migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: { owner: '小夫', guest: '同名朋友' }, confirmed: true });
  const roleRoot = catalog.rootFor(imported.role.id);
  assert.match(readFileSync(join(roleRoot, 'notes/人物/小夫.md'), 'utf8'), /不吃香菜/);
  assert.match(readFileSync(join(roleRoot, 'notes/经历/一起吃面.md'), 'utf8'), /觉得很暖和/);
  assert.equal(readdirSync(join(roleRoot, 'notes/人物')).length, 2);
  writeFileSync(join(roleRoot, 'notes/人物/小夫.md'), '# AI 已整理\n\n保留我的编辑。');
  const again = await migration.preview(old);
  assert.equal(migration.targetRoleId(again.token), imported.role.id);
  const repeated = await migration.confirm({ token: again.token, name: '璐璐', speakerName: '小夫', personMapping: {}, confirmed: true });
  assert.equal(repeated.changed, 0);
  assert.deepEqual(readFileSync(old), original);
  const changed = new DatabaseSync(old);
  changed.prepare('UPDATE person_facts SET fact_value=? WHERE id=1').run('也不吃葱');
  changed.close();
  const delta = await migration.preview(old);
  const result = await migration.confirm({ token: delta.token, name: '璐璐', speakerName: '小夫', personMapping: {}, confirmed: true });
  assert.equal(result.role.id, imported.role.id);
  assert.equal(result.changed, 1);
  assert.match(readFileSync(join(roleRoot, 'notes/人物/小夫.md'), 'utf8'), /AI 已整理/);
  assert.ok(existsSync(join(roleRoot, 'notes/导入补充')));
  catalog.close();
});
test('legacy catalog persona is read as data while malformed source schemas are rejected', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-persona-import-'));
  const source = legacy(temp), root = join(temp, 'legacy-data');
  const roleRoot = join(root, 'characters', 'old-role');
  mkdirSync(roleRoot, { recursive: true });
  writeFileSync(join(roleRoot, 'memory.db'), readFileSync(source));
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ roles: [{
    id: 'old-role', name: '璐璐', persona: '说话很轻，喜欢认真记下约定。',
  }] }));
  const catalog = new Catalog(join(temp, 'target')), migration = new MigrationService(catalog);
  const preview = await migration.preview(join(roleRoot, 'memory.db'));
  assert.equal(preview.name, '璐璐');
  const result = await migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: { owner: '小夫', guest: '另一个小夫' }, confirmed: true });
  assert.match(readFileSync(join(catalog.rootFor(result.role.id), 'notes/角色.md'), 'utf8'), /喜欢认真记下约定/);
  const malformed = join(temp, 'virtual.sqlite');
  const db = new DatabaseSync(malformed);
  db.exec('CREATE VIRTUAL TABLE dialogue USING fts5(text)');
  db.close();
  const imported = readOnly(malformed);
  try { assert.throws(() => tableSnapshot(imported, new Set(['dialogue'])), /不能是虚拟表/); }
  finally { imported.close(); }
  catalog.close();
});
test('seed package excludes source dialogue and model routes; checksum tampering is rejected', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-export-'));
  const catalog = new Catalog(join(temp, 'new'));
  const role = catalog.create('璐璐', '小夫');
  role.memoryModel = { provider: 'private-route', model: 'private-model' };
  catalog.save(role);
  const engine = new NotesEngine(catalog.rootFor(role.id), { roleName: role.name });
  engine.captureDialogue({ sessionId: 's', messageId: 'm', party: 'human', speaker: '小夫', text: '私密的原话', at: '2026-11-17T00:00:00Z' });
  await engine.execute({ action: 'create', path: '随记/种子.md', content: '# 种子\n\n喜欢散步。' });
  const path = join(temp, 'seed.pupunotes');
  await exportPackage(catalog, role, path, 'seed', ['随记/种子.md']);
  const result = inspectNotesPackage(path);
  assert.equal(result.manifest.role.memoryModel, undefined);
  assert.equal(result.entries['state.sqlite'], undefined);
  assert.ok(result.entries['notes/随记/种子.md']);
  result.entries['notes/随记/种子.md'] = strToU8('被改过');
  writeFileSync(join(temp, 'bad.pupunotes'), zipSync(result.entries));
  assert.throws(() => inspectNotesPackage(join(temp, 'bad.pupunotes')), /校验失败/);
  engine.close();
  catalog.close();
});
test('legacy zip rejects path traversal before extraction', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-bad-'));
  const catalog = new Catalog(join(temp, 'new'));
  const migration = new MigrationService(catalog);
  const path = join(temp, 'bad.pupumem');
  writeFileSync(path, zipSync({ '../escaped': strToU8('no') }));
  await assert.rejects(migration.preview(path), /非法路径/);
  assert.equal(existsSync(join(temp, 'escaped')), false);
  catalog.close();
});
test('ZIP preflight rejects Windows collisions, ZIP64 and impossible central directories before inflation', () => {
  const duplicate = zipSync({ 'notes/Name.md': strToU8('one'), 'notes/name.md': strToU8('two') });
  assert.throws(() => validateZip(duplicate), /重复或大小写冲突/);
  const pathConflict = zipSync({ notes: strToU8('file'), 'notes/角色.md': strToU8('card') });
  assert.throws(() => validateZip(pathConflict), /文件和目录路径冲突/);
  const original = zipSync({ 'notes/角色.md': strToU8('card') });
  const zip64 = original.slice(), end = zip64.length - 22;
  new DataView(zip64.buffer).setUint32(end + 16, 0xffffffff, true);
  assert.throws(() => validateZip(zip64), /ZIP64/);
  const broken = original.slice(); new DataView(broken.buffer).setUint32(end + 12, 0x7fffffff, true);
  assert.throws(() => validateZip(broken), /目录范围无效/);
  const huge = original.slice(), central = new DataView(huge.buffer).getUint32(end + 16, true);
  new DataView(huge.buffer).setUint32(central + 24, 1024 * 1024 * 1024, true);
  assert.throws(() => validateZip(huge), /解压内容过大/);
  validateZip(original);
});
test('legacy package persona is imported from supported manifest data', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-manifest-persona-')), source = legacy(temp);
  const file = join(temp, 'persona.pupumem');
  writeFileSync(file, zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: 'pupu-memory', version: 1, character: { name: '璐璐', persona: '记得细节，讲话很轻。' } })),
    'memory.sqlite': readFileSync(source),
  }));
  const catalog = new Catalog(join(temp, 'target')), migration = new MigrationService(catalog);
  const preview = await migration.preview(file);
  const imported = await migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: { owner: '小夫', guest: '另一个小夫' }, confirmed: true });
  assert.match(readFileSync(join(catalog.rootFor(imported.role.id), 'notes/角色.md'), 'utf8'), /记得细节，讲话很轻/);
  catalog.close();
});
test('full and seed packages roundtrip note prose, sources and versions without resuming source jobs', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-roundtrip-'));
  const catalog = new Catalog(join(temp, 'source'));
  const role = catalog.create('璐璐', '小夫');
  const engine = new NotesEngine(catalog.rootFor(role.id), { roleName: role.name });
  const dialogue = engine.captureDialogue({
    sessionId: 's', messageId: 'one', party: 'human', speaker: '小夫', text: '今晚去看星星。', at: '2026-11-17T00:00:00Z',
  });
  const task = engine.registerTrigger({ triggerId: 't', sessionId: 's', reason: 'manual' });
  engine.nextTask();
  await engine.execute({ action: 'sources' }, { taskId: task.id });
  await engine.execute({ action: 'create', path: '经历/星星.md', content: '# 星星\n\n约好今晚一起看星星。\n' }, { taskId: task.id, operationId: 'create-stars' });
  const active = engine.registerTrigger({ triggerId: 'unfinished', sessionId: 's', reason: 'manual' });
  assert.equal(active.status, 'queued');
  const sourceText = readFileSync(join(catalog.rootFor(role.id), 'notes/经历/星星.md'), 'utf8');
  engine.close();
  const full = join(temp, 'full.pupunotes'), seed = join(temp, 'seed.pupunotes');
  await exportPackage(catalog, role, full, 'full');
  await exportPackage(catalog, role, seed, 'seed', ['经历/星星.md']);
  for (const [path, sources] of [[full, true], [seed, false]] as const) {
    const importedCatalog = new Catalog(join(temp, sources ? 'full-target' : 'seed-target'));
    const migration = new MigrationService(importedCatalog);
    const preview = await migration.preview(path);
    const imported = await migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: {}, confirmed: true });
    const targetEngine = new NotesEngine(importedCatalog.rootFor(imported.role.id));
    assert.equal(readFileSync(join(importedCatalog.rootFor(imported.role.id), 'notes/经历/星星.md'), 'utf8'), sourceText);
    assert.equal(targetEngine.listTasks().length, 0, 'imported active tasks must never resume');
    const result = await targetEngine.execute({ action: 'sources', path: '经历/星星.md', limit: 100 });
    const prose = JSON.stringify(result);
    assert.equal(prose.includes('今晚去看星星'), sources);
    assert.equal(targetEngine.versions('经历/星星.md').length > 0, sources);
    targetEngine.close(); importedCatalog.close();
  }
  assert.ok(dialogue.seq > 0);
  catalog.close();
});
test('legacy import exposes original evidence and raw messages and imports only proven unread dialogue', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-evidence-'));
  const source = legacy(temp);
  const old = new DatabaseSync(source);
  old.exec(`ALTER TABLE fact_evidence ADD COLUMN source_context_session TEXT;
    ALTER TABLE fact_evidence ADD COLUMN source_msg_start_id INTEGER;
    ALTER TABLE fact_evidence ADD COLUMN source_msg_end_id INTEGER;
    UPDATE fact_evidence SET source_context_session='owner',source_msg_start_id=1,source_msg_end_id=1;
    CREATE TABLE engine_meta(key TEXT,value TEXT);
    INSERT INTO engine_meta VALUES('character_id','synthetic-role'),('review:owner','1');
    INSERT INTO messages VALUES(2,'owner','assistant','那就不加香菜。','2026-11-17T00:00:01Z');
    INSERT INTO messages VALUES(3,'unknown','user','无法证明处理游标的会话。','2026-11-17T00:00:02Z');`);
  old.close();
  const catalog = new Catalog(join(temp, 'target')), migration = new MigrationService(catalog);
  const preview = await migration.preview(source);
  await assert.rejects(migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: { owner: '小夫' }, confirmed: true }), /明确映射/);
  const result = await migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: { owner: '小夫', guest: '同名朋友' }, confirmed: true });
  const engine = new NotesEngine(catalog.rootFor(result.role.id));
  const sources = await engine.execute({ action: 'sources', path: '人物/小夫.md', limit: 100 });
  assert.match(JSON.stringify(sources), /不要加香菜/);
  assert.match(JSON.stringify(sources), /fact_evidence/);
  assert.match(JSON.stringify(sources), /messages/);
  const task = engine.nextTask();
  assert.ok(task);
  const page = await engine.execute({ action: 'sources' }, { taskId: task.id });
  const messages = page.messages as { text: string }[];
  assert.deepEqual(messages.map(message => message.text), ['那就不加香菜。']);
  const archived = new DatabaseSync(join(catalog.rootFor(result.role.id), 'migration.sqlite'), { readOnly: true });
  const records = archived.prepare('SELECT data,fingerprint FROM records').all() as { data: string; fingerprint: string }[];
  for (const record of records) assert.equal(createHash('sha256').update(record.data).digest('hex'), record.fingerprint);
  assert.equal(records.length, Object.values(preview.counts).reduce((sum, value) => sum + value, 0));
  archived.close(); engine.close(); catalog.close();
});
test('prepared activation rolls forward after rename interruption without deleting the prior role', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-activate-'));
  const catalog = new Catalog(join(temp, 'target')), role = catalog.create('璐璐', '小夫');
  const destination = catalog.rootFor(role.id), stage = join(catalog.root, '.staging', 'prepared');
  mkdirSync(stage, { recursive: true }); writeFileSync(join(stage, 'marker'), 'new');
  writeFileSync(join(destination, 'marker'), 'old');
  const backup = join(catalog.root, '.staging', 'backup');
  const journal = join(catalog.root, '.import-journals', 'job.json');
  atomicJson(journal, { id: 'job', role, sourceKey: 'source', importData: { done: true }, stage, destination, backup, journal });
  renameSync(destination, backup);
  new MigrationService(catalog);
  assert.equal(readFileSync(join(destination, 'marker'), 'utf8'), 'new');
  assert.equal(existsSync(backup), false);
  assert.ok(catalog.importRecord('source'));
  assert.equal(existsSync(journal), false);
  catalog.close();
});
test('seed source opt-in includes reachable evidence and excludes unrelated dialogue and old versions', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-seed-privacy-'));
  const catalog = new Catalog(join(temp, 'source')), role = catalog.create('璐璐', '小夫');
  const engine = new NotesEngine(catalog.rootFor(role.id));
  for (const [name, text] of [['shared', '一起看星星'], ['private', '只属于另一页的秘密']] as const) {
    engine.captureDialogue({ sessionId: name, messageId: name, party: 'human', speaker: '小夫', text, at: '2026-11-18T00:00:00Z' });
    const task = engine.registerTrigger({ triggerId: name, sessionId: name, reason: 'manual' }); engine.nextTask();
    await engine.execute({ action: 'sources' }, { taskId: task.id });
    await engine.execute({ action: 'create', path: `随记/${name}.md`, content: text }, { taskId: task.id });
    engine.finishTask(task.id);
  }
  engine.close();
  const file = join(temp, 'selected.pupunotes');
  await exportPackage(catalog, role, file, 'seed', ['随记/shared.md'], true);
  const pack = inspectNotesPackage(file), stateFile = join(temp, 'inspect.sqlite');
  writeFileSync(stateFile, pack.entries['state.sqlite']!);
  const db = new DatabaseSync(stateFile, { readOnly: true });
  const rows = db.prepare('SELECT text FROM dialogue').all() as { text: string }[];
  assert.deepEqual(rows.map(row => row.text), ['一起看星星']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM versions').get() as { n: number }).n, 0);
  db.close(); catalog.close();
});
test('imported cursor cannot point into another session or beyond preserved dialogue', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-cursor-'));
  const role = { id: 'new', name: '璐璐', speakerName: '小夫', roleCardPath: '角色.md', createdAt: '2026-11-18T00:00:00Z' };
  assert.throws(() => restoreState(temp, {
    dialogue: [{ seq: 1, session_id: 'a', message_id: 'm', party: 'human', speaker: '小夫', text: '原文', attachments: '[]', at: role.createdAt }],
    cursors: [{ session_id: 'b', seq: 1 }],
  }, role), /游标超出/);
});
test('later package import keeps additive note provenance while preserving destination edits', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'pupu-package-delta-'));
  const source = new Catalog(join(temp, 'source')), role = source.create('璐璐', '小夫');
  let engine = new NotesEngine(source.rootFor(role.id));
  await engine.execute({ action: 'create', path: '经历/约定.md', content: '第一次约定。' });
  engine.close();
  const first = join(temp, 'first.pupunotes'); await exportPackage(source, role, first, 'full');
  const target = new Catalog(join(temp, 'target')), migration = new MigrationService(target);
  const preview = await migration.preview(first);
  const imported = await migration.confirm({ token: preview.token, name: '璐璐', speakerName: '小夫', personMapping: {}, confirmed: true });
  const destination = target.rootFor(imported.role.id);
  writeFileSync(join(destination, 'notes/经历/约定.md'), '目标角色自己整理过的文字。');
  engine = new NotesEngine(source.rootFor(role.id));
  engine.captureDialogue({ sessionId: 'new', messageId: 'new', party: 'human', speaker: '小夫', text: '增量来源中确切的那句原话。', at: '2026-11-18T00:00:00Z' });
  const task = engine.registerTrigger({ triggerId: 'new', sessionId: 'new', reason: 'manual' }); engine.nextTask();
  await engine.execute({ action: 'sources' }, { taskId: task.id });
  await engine.execute({ action: 'edit', path: '经历/约定.md', oldText: '第一次约定。', newText: '新的约定。' }, { taskId: task.id });
  engine.finishTask(task.id); engine.close();
  const second = join(temp, 'second.pupunotes'); await exportPackage(source, role, second, 'full');
  const next = await migration.preview(second);
  const result = await migration.confirm({ token: next.token, name: '璐璐', speakerName: '小夫', personMapping: {}, confirmed: true });
  assert.equal(result.role.id, imported.role.id);
  assert.equal(readFileSync(join(destination, 'notes/经历/约定.md'), 'utf8'), '目标角色自己整理过的文字。');
  const supplemental = readdirSync(join(destination, 'notes/导入补充'))[0]!;
  const supplementaryPath = `导入补充/${supplemental}/经历/约定.md`;
  engine = new NotesEngine(destination);
  const evidence = await engine.execute({ action: 'sources', path: supplementaryPath, limit: 100 });
  assert.match(JSON.stringify(evidence), /增量来源中确切的那句原话/);
  assert.equal(engine.listTasks().length, 0);
  engine.close(); target.close(); source.close();
});
