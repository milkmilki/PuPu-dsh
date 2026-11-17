import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { strFromU8, strToU8, zipSync } from 'fflate';
import type { Role } from '../contracts.js';
import type { Catalog } from '../catalog.js';
import { openDatabase } from '../engine/database.js';
import {
  entryPath, ensurePlainDirectory, hash, readOnly, readZip, recordKey,
  removeStage, tableSnapshot, type Row, type Snapshot,
} from './shared.js';

export interface PackageManifest {
  format: 'pupu-notes'; version: 1; kind: 'full' | 'seed'; role: Role;
  files: Record<string, { sha256: string; bytes: number }>;
}
const STATE_TABLES = new Set([
  'settings', 'dialogue', 'cursors', 'versions', 'provenance', 'source_documents', 'source_aliases',
]);
const ARCHIVE_TABLES = new Set(['records', 'note_sources', 'imports']);
const decoder = new TextDecoder('utf-8', { fatal: true });

export function inspectNotesPackage(path: string): { manifest: PackageManifest; entries: Record<string, Uint8Array> } {
  const entries = readZip(path);
  const manifest = JSON.parse(strFromU8(entries['manifest.json'] ?? new Uint8Array())) as PackageManifest;
  if (manifest.format !== 'pupu-notes' || manifest.version !== 1 ||
    !['full', 'seed'].includes(manifest.kind) || typeof manifest.role?.id !== 'string' ||
    typeof manifest.role.name !== 'string' || !manifest.role.name.trim() ||
    typeof manifest.role.roleCardPath !== 'string' || !manifest.files || typeof manifest.files !== 'object')
    throw new Error('不支持的笔记包');
  entryPath(manifest.role.roleCardPath);
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'manifest.json') continue;
    if ((!name.startsWith('notes/') && !['state.sqlite', 'migration.sqlite', 'history.json'].includes(name)) || name === 'notes/')
      throw new Error('笔记包含未支持的条目');
    if (name.startsWith('notes/')) decoder.decode(data);
    const check = manifest.files[name];
    if (!check || check.bytes !== data.length || check.sha256 !== hash(data)) throw new Error('笔记包校验失败');
  }
  for (const name of Object.keys(manifest.files)) {
    entryPath(name);
    if (!entries[name]) throw new Error('笔记包条目缺失');
  }
  return { manifest, entries };
}

export function packageSnapshot(entries: Record<string, Uint8Array>, staging: string): {
  snapshot: Snapshot; state: Snapshot; archive: Snapshot;
} {
  const state: Snapshot = {}, archive: Snapshot = {};
  for (const name of ['state.sqlite', 'migration.sqlite']) if (entries[name]) {
    const path = join(staging, `input-${name}`);
    writeFileSync(path, entries[name], { flag: 'wx' });
    const db = readOnly(path);
    try { Object.assign(name === 'state.sqlite' ? state : archive, tableSnapshot(db, name === 'state.sqlite' ? STATE_TABLES : ARCHIVE_TABLES)); }
    finally { db.close(); }
  }
  const snapshot: Snapshot = {
    notes: Object.entries(entries).filter(([name]) => name.startsWith('notes/')).map(([name, bytes]) => ({
      key: name.slice(6), path: name.slice(6), content: decoder.decode(bytes), sha256: hash(bytes),
    })),
    ...Object.fromEntries(Object.entries(state).map(([name, rows]) => [`notes_state_${name}`, rows])),
    ...Object.fromEntries(Object.entries(archive).map(([name, rows]) => [`notes_archive_${name}`, rows])),
  };
  if (entries['history.json']) {
    const history = JSON.parse(decoder.decode(entries['history.json']));
    if (!Array.isArray(history)) throw new Error('历史审计数据格式无效');
    snapshot.notes_history = history.map((record, number) => ({ id: number, data: JSON.stringify(record) }));
  }
  return { snapshot, state, archive };
}
/** Attach package provenance to a renamed additive note without activating its old runtime state. */
export function packageNoteRecords(snapshot: Snapshot, state: Snapshot, archive: Snapshot, path: string) {
  const records = [{ table: 'notes', key: path }];
  const aliases = new Set([path]);
  for (;;) {
    const size = aliases.size;
    for (const row of state.source_aliases ?? []) if (aliases.has(String(row.path))) aliases.add(String(row.original_path));
    if (aliases.size === size) break;
  }
  const provenance = (state.provenance ?? []).filter(row => aliases.has(String(row.path)));
  const sourceKeys = new Set(provenance.map(row => String(row.source_key)));
  const add = (table: string, rows: Row[]) => rows.forEach(row => {
    const all = snapshot[table] ?? [];
    const number = all.indexOf(row);
    records.push({ table, key: recordKey(row, number) });
  });
  add('notes_state_provenance', provenance);
  add('notes_state_dialogue', (state.dialogue ?? []).filter(row => sourceKeys.has(`dialogue:${row.seq}`)));
  add('notes_state_source_documents', (state.source_documents ?? []).filter(row => sourceKeys.has(String(row.source_key))));
  add('notes_state_versions', (state.versions ?? []).filter(row => aliases.has(String(row.path))));
  const noteSources = (archive.note_sources ?? []).filter(row => aliases.has(String(row.path)));
  const rawKeys = new Set(noteSources.map(row => `${row.source_key}\0${row.table_name}\0${row.record_key}`));
  add('notes_archive_records', (archive.records ?? []).filter(row => rawKeys.has(`${row.source_key}\0${row.table_name}\0${row.record_key}`)));
  return records;
}

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`笔记库字段 ${field} 不是文本`);
  return value;
}
function number(row: Row, field: string, minimum = 0): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`笔记库字段 ${field} 无效`);
  return value;
}
function validPath(row: Row, field: string): string { return entryPath(text(row, field)); }
function validJson(row: Row, field: string): string {
  const value = text(row, field); JSON.parse(value); return value;
}
function validTime(row: Row): void {
  if (!Number.isFinite(Date.parse(text(row, 'at')))) throw new Error('笔记库时间字段无效');
}
/** Rebuild only data into our own schema; imported SQL, triggers and jobs never run. */
export function restoreState(target: string, state: Snapshot, role: Role): void {
  const db = openDatabase(target);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const row of state.dialogue ?? []) {
      if (!['human', 'assistant'].includes(text(row, 'party'))) throw new Error('导入对话身份无效');
      validTime(row);
      if (!Array.isArray(JSON.parse(validJson(row, 'attachments')))) throw new Error('导入附件引用无效');
      db.prepare('INSERT INTO dialogue(seq,session_id,message_id,party,speaker,text,attachments,at) VALUES (?,?,?,?,?,?,?,?)')
        .run(number(row, 'seq', 1), text(row, 'session_id'), text(row, 'message_id'), row.party,
          text(row, 'speaker'), text(row, 'text'), row.attachments, row.at);
    }
    for (const row of state.cursors ?? []) {
      const session = text(row, 'session_id'), seq = number(row, 'seq');
      const maximum = Number((db.prepare('SELECT COALESCE(MAX(seq),0) AS maximum FROM dialogue WHERE session_id=?').get(session) as { maximum: number }).maximum);
      if (seq > maximum || (seq > 0 && !db.prepare('SELECT 1 FROM dialogue WHERE session_id=? AND seq=?').get(session, seq)))
        throw new Error('导入游标超出所属会话的已保存对话');
      db.prepare('INSERT INTO cursors VALUES(?,?)').run(session, seq);
    }
    for (const row of state.versions ?? []) {
      validTime(row);
      if (row.content !== null && typeof row.content !== 'string') throw new Error('导入版本内容无效');
      db.prepare('INSERT INTO versions(id,path,content,operation,at,operation_id) VALUES(?,?,?,?,?,?)')
        .run(number(row, 'id', 1), validPath(row, 'path'), row.content, text(row, 'operation'), row.at, text(row, 'operation_id'));
    }
    for (const row of state.provenance ?? []) db.prepare('INSERT INTO provenance VALUES(?,?,?)')
      .run(validPath(row, 'path'), text(row, 'source_key'), text(row, 'operation_id'));
    for (const row of state.source_documents ?? []) db.prepare('INSERT INTO source_documents VALUES(?,?,?,?)')
      .run(text(row, 'source_key'), text(row, 'kind'), text(row, 'content'), validJson(row, 'metadata'));
    for (const row of state.source_aliases ?? []) db.prepare('INSERT INTO source_aliases VALUES(?,?)')
      .run(validPath(row, 'path'), validPath(row, 'original_path'));
    // Only these settings are owned by portable memory; no runtime/model settings survive.
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('initialized', 'true');
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('roleCardPath', entryPath(role.roleCardPath));
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* transaction may not have started */ } throw error; }
  finally { db.close(); }
}

function completedHistory(source: DatabaseSync): unknown[] {
  const tables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  const history: unknown[] = [];
  if (tables.has('source_documents')) {
    const retained = source.prepare("SELECT content FROM source_documents WHERE kind='imported-history'").all() as { content: string }[];
    for (const record of retained) history.push({ kind: 'earlier-import-history', record: JSON.parse(record.content) });
  }
  if (tables.has('operations')) history.push(...source.prepare("SELECT * FROM operations WHERE status='applied'").all().map(row => ({ kind: 'operation', record: row })));
  if (tables.has('tasks')) history.push(...source.prepare("SELECT * FROM tasks WHERE status='completed'").all().map(row => ({ kind: 'completed-task', record: row })));
  return history;
}
/** A seed's source opt-in includes only material reachable from the selected notes. */
function selectedState(snapshot: Snapshot, paths: Set<string>): Snapshot {
  const aliases = new Set(paths);
  for (;;) {
    const size = aliases.size;
    for (const row of snapshot.source_aliases ?? []) if (aliases.has(String(row.path))) aliases.add(String(row.original_path));
    if (aliases.size === size) break;
  }
  const provenance = (snapshot.provenance ?? []).filter(row => aliases.has(String(row.path)));
  const keys = new Set(provenance.map(row => String(row.source_key)));
  const dialogues = (snapshot.dialogue ?? []).filter(row => keys.has(`dialogue:${row.seq}`));
  return {
    dialogue: dialogues, cursors: [], versions: [],
    provenance,
    source_documents: (snapshot.source_documents ?? []).filter(row => keys.has(String(row.source_key))),
    source_aliases: (snapshot.source_aliases ?? []).filter(row => aliases.has(String(row.path))),
  };
}
function selectedArchive(snapshot: Snapshot, paths: Set<string>): Snapshot {
  const refs = (snapshot.note_sources ?? []).filter(row => paths.has(String(row.path)));
  const keys = new Set(refs.map(row => `${row.source_key}\0${row.table_name}\0${row.record_key}`));
  return {
    records: (snapshot.records ?? []).filter(row => keys.has(`${row.source_key}\0${row.table_name}\0${row.record_key}`)),
    note_sources: refs, imports: [],
  };
}
export async function exportPackage(
  catalog: Catalog, role: Role, destination: string, kind: 'full' | 'seed',
  selected?: string[], includeSources = false,
) {
  const root = catalog.rootFor(role.id), entries: Record<string, Uint8Array> = {};
  const notes = new Map<string, Uint8Array>();
  function walk(directory: string, prefix: string): void {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path), key = entryPath(`${prefix}${name}`);
      if (stat.isSymbolicLink()) throw new Error('无法打包链接');
      if (stat.isDirectory()) walk(path, `${key}/`);
      else if (stat.isFile()) { const bytes = readFileSync(path); decoder.decode(bytes); notes.set(key, bytes); }
    }
  }
  walk(join(root, 'notes'), '');
  for (const path of selected ?? []) {
    entryPath(path);
    if (![...notes.keys()].some(name => name === path || name.startsWith(`${path}/`))) throw new Error(`选择的笔记不存在：${path}`);
  }
  if (kind === 'seed' && selected && !selected.length) throw new Error('请至少选择一份笔记');
  for (const [path, bytes] of notes) if (kind === 'full' || !selected ||
    selected.some(chosen => chosen === path || path.startsWith(`${chosen}/`)) || path === role.roleCardPath)
    entries[`notes/${path}`] = bytes;
  const chosenPaths = new Set(Object.keys(entries).map(path => path.slice('notes/'.length)));
  const stageRoot = join(catalog.root, '.staging');
  ensurePlainDirectory(stageRoot);
  const staging = join(stageRoot, `export-${randomUUID()}`);
  ensurePlainDirectory(staging);
  try {
    if (kind === 'full' || includeSources) for (const name of ['state.sqlite', 'migration.sqlite']) if (existsSync(join(root, name))) {
      if (name === 'migration.sqlite') {
        const source = readOnly(join(root, name));
        let snapshot: Snapshot;
        try { snapshot = tableSnapshot(source, ARCHIVE_TABLES); } finally { source.close(); }
        if (kind === 'seed') snapshot = selectedArchive(snapshot, chosenPaths);
        const { openArchive, restoreArchive } = await import('./archive.js');
        const db = openArchive(staging);
        try { restoreArchive(db, snapshot); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
      } else {
        const source = readOnly(join(root, name));
        let snapshot: Snapshot, history: unknown[];
        try { snapshot = tableSnapshot(source, STATE_TABLES); history = completedHistory(source); }
        finally { source.close(); }
        if (kind === 'seed') snapshot = selectedState(snapshot, chosenPaths);
        const target = join(staging, 'state');
        ensurePlainDirectory(target);
        restoreState(target, snapshot, role);
        entries['state.sqlite'] = readFileSync(join(target, 'state.sqlite'));
        if (kind === 'full') entries['history.json'] = strToU8(JSON.stringify(history));
        continue;
      }
      entries[name] = readFileSync(join(staging, name));
    }
    const manifest: PackageManifest = {
      format: 'pupu-notes', version: 1, kind,
      role: { id: role.id, name: role.name, speakerName: role.speakerName, roleCardPath: role.roleCardPath, createdAt: role.createdAt },
      files: Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [path, { sha256: hash(bytes), bytes: bytes.length }])),
    };
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    ensurePlainDirectory(dirname(resolve(destination)));
    writeFileSync(destination, zipSync(entries), { flag: 'wx' });
    return { path: resolve(destination), destination: resolve(destination), kind,
      notes: Object.keys(entries).filter(path => path.startsWith('notes/')).length,
      includesSources: kind === 'full' || includeSources };
  } finally { removeStage(stageRoot, staging); }
}
