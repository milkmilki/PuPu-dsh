import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, entryPath, hash, recordKey, type Projection, type Snapshot } from './shared.js';

export function openArchive(root: string): DatabaseSync {
  const db = new DatabaseSync(join(root, 'migration.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS records(
      source_key TEXT,table_name TEXT,record_key TEXT,fingerprint TEXT,data TEXT,
      PRIMARY KEY(source_key,table_name,record_key,fingerprint));
    CREATE TABLE IF NOT EXISTS note_sources(
      path TEXT,source_key TEXT,table_name TEXT,record_key TEXT,
      PRIMARY KEY(path,source_key,table_name,record_key));
    CREATE TABLE IF NOT EXISTS imports(source_key TEXT PRIMARY KEY,payload TEXT);`);
  return db;
}
export function appendRecords(db: DatabaseSync, sourceKey: string, snapshot: Snapshot): Set<string> {
  const changed = new Set<string>();
  for (const [table, rows] of Object.entries(snapshot)) rows.forEach((row, number) => {
    const data = canonical(row), key = recordKey(row, number);
    const result = db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)').run(sourceKey, table, key, hash(data), data);
    if (result.changes) changed.add(`${table}:${key}`);
  });
  return changed;
}
export function addReferences(db: DatabaseSync, path: string, sourceKey: string, projection: Projection): void {
  for (const record of projection.records) db.prepare('INSERT OR IGNORE INTO note_sources VALUES(?,?,?,?)')
    .run(path, sourceKey, record.table, record.key);
}
export function restoreArchive(db: DatabaseSync, snapshot: Snapshot): void {
  for (const row of snapshot.records ?? []) {
    if (typeof row.source_key !== 'string' || typeof row.table_name !== 'string' ||
      typeof row.record_key !== 'string' || typeof row.fingerprint !== 'string' || typeof row.data !== 'string')
      throw new Error('导入来源归档的字段无效');
    JSON.parse(row.data);
    if (hash(row.data) !== row.fingerprint) throw new Error('来源记录指纹校验失败');
    db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)')
      .run(row.source_key, row.table_name, row.record_key, row.fingerprint, row.data);
  }
  for (const row of snapshot.note_sources ?? []) {
    if ([row.path, row.source_key, row.table_name, row.record_key].some(value => typeof value !== 'string'))
      throw new Error('导入笔记来源引用无效');
    entryPath(String(row.path));
    if (!db.prepare('SELECT 1 FROM records WHERE source_key=? AND table_name=? AND record_key=?')
      .get(row.source_key, row.table_name, row.record_key)) throw new Error('导入来源引用缺少原始记录');
    db.prepare('INSERT OR IGNORE INTO note_sources VALUES(?,?,?,?)')
      .run(row.path, row.source_key, row.table_name, row.record_key);
  }
  for (const row of snapshot.imports ?? []) {
    if (typeof row.source_key !== 'string' || typeof row.payload !== 'string') throw new Error('来源导入历史无效');
    JSON.parse(row.payload);
    db.prepare('INSERT OR IGNORE INTO imports VALUES(?,?)').run(row.source_key, row.payload);
  }
}
export function archiveCoverage(db: DatabaseSync, sourceKey: string, snapshot: Snapshot) {
  const expected = Object.values(snapshot).reduce((sum, rows) => sum + rows.length, 0);
  const actual = Number((db.prepare('SELECT COUNT(*) AS count FROM records WHERE source_key=?').get(sourceKey) as { count: number }).count);
  const bad = Number((db.prepare(`SELECT COUNT(*) AS count FROM note_sources n
    WHERE n.source_key=? AND NOT EXISTS(SELECT 1 FROM records r WHERE r.source_key=n.source_key AND r.table_name=n.table_name AND r.record_key=n.record_key)`)
    .get(sourceKey) as { count: number }).count);
  if (bad || actual < expected) throw new Error('导入来源计数或引用覆盖检查失败');
  return { sourceRecords: expected, preservedRecords: actual, missingReferences: bad };
}
