import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { unzipSync } from 'fflate';
import { validateZip } from './zip.js';

export type Row = Record<string, string | number | null>;
export type Snapshot = Record<string, Row[]>;
export interface RecordRef { table: string; key: string }
export interface Projection { content: string; records: RecordRef[] }
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const canonical = (row: Row): string => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])));
export const safeName = (name: string): string => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 100) || '未命名';
export function recordKey(row: Row, index: number): string {
  for (const key of ['id', 'person_key', 'key', 'source_key', 'session_id'])
    if (row[key] !== undefined && row[key] !== null) return String(row[key]);
  return String(index);
}
export function within(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('路径超出产品目录');
}
export function entryPath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').some(component =>
    component === '..' || component === '.' || !component || /[<>:"|?*\x00-\x1f]/.test(component) ||
    /[. ]$/.test(component) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(component)))
    throw new Error('数据包含非法路径');
  return path;
}
export function ensurePlainDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  let current = resolve(path);
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('数据路径不能经过符号链接或目录联接');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function atomicJson(path: string, value: unknown): void {
  ensurePlainDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx');
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
export function readZip(path: string): Record<string, Uint8Array> {
  const bytes = readFileSync(path);
  if (bytes.length > 512 * 1024 * 1024) throw new Error('数据包过大');
  validateZip(bytes);
  let total = 0;
  const names = new Set<string>();
  return unzipSync(bytes, { filter: entry => {
    const name = entryPath(entry.name.replace(/\/$/, ''));
    const normalized = name.toLocaleLowerCase('en-US');
    if (names.has(normalized)) throw new Error('数据包含重复或大小写冲突的路径');
    names.add(normalized);
    total += entry.originalSize;
    if (total > 1024 * 1024 * 1024 || entry.originalSize > 512 * 1024 * 1024) throw new Error('数据包解压内容过大');
    return !entry.name.endsWith('/');
  } });
}
export function readOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
  if ((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') {
    db.close(); throw new Error('数据库完整性检查失败');
  }
  return db;
}
export async function snapshotDatabase(sourcePath: string, target: string): Promise<void> {
  const source = readOnly(sourcePath);
  try { await backup(source, target); } finally { source.close(); }
}
/** Copy live database files through SQLite backup, never a WAL-oblivious file copy. */
export async function copyRole(source: string, target: string): Promise<void> {
  ensurePlainDirectory(target);
  for (const name of readdirSync(source)) {
    if (name === '.notes-write.lock' || name === '.notes-engine.lock' || name.endsWith('-wal') || name.endsWith('-shm')) continue;
    const from = join(source, name), to = join(target, name), stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('角色资料不能含有链接');
    if (stat.isDirectory()) await copyRole(from, to);
    else if (name.endsWith('.sqlite')) await snapshotDatabase(from, to);
    else if (stat.isFile()) writeFileSync(to, readFileSync(from), { flag: 'wx' });
  }
}
export function removeStage(root: string, directory: string): void {
  within(root, directory);
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
}
export function tableSnapshot(db: DatabaseSync, names?: ReadonlySet<string>): Snapshot {
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  const result: Snapshot = {};
  for (const { name, sql } of tables) {
    if (names && !names.has(name)) continue;
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql)) throw new Error('来源库的记忆表不能是虚拟表');
    result[name] = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(raw => {
      const row: Row = {};
      for (const [key, value] of Object.entries(raw)) row[key] = value instanceof Uint8Array
        ? Buffer.from(value).toString('base64') : value as string | number | null;
      return row;
    });
  }
  return result;
}
export const fingerprints = (snapshot: Snapshot): Record<string, string> => Object.fromEntries(
  Object.entries(snapshot).map(([table, rows]) => [table, hash(rows.map(canonical).sort().join('\n'))]),
);
