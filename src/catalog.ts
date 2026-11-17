import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Binding, ModelRoute, Role } from './contracts.js';

export class Catalog {
  readonly db: DatabaseSync;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'roles'), { recursive: true });
    this.db = new DatabaseSync(join(root, 'catalog.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(session_id TEXT PRIMARY KEY,role_id TEXT NOT NULL REFERENCES roles(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(source_key TEXT PRIMARY KEY,role_id TEXT NOT NULL REFERENCES roles(id),data TEXT NOT NULL);`);
  }
  roles(): Role[] { return (this.db.prepare('SELECT data FROM roles ORDER BY rowid').all() as { data: string }[]).map(x => JSON.parse(x.data)); }
  role(id: string): Role {
    const row = this.db.prepare('SELECT data FROM roles WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new Error('角色不存在');
    return JSON.parse(row.data);
  }
  create(name: string, speakerName: string): Role {
    if (!name.trim() || !speakerName.trim()) throw new Error('请填写双方名称');
    const role: Role = { id: randomUUID(), name: name.trim(), speakerName: speakerName.trim(), roleCardPath: '角色.md', createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO roles VALUES(?,?)').run(role.id, JSON.stringify(role));
    return role;
  }
  save(role: Role) {
    this.role(role.id);
    this.db.prepare('UPDATE roles SET data=? WHERE id=?').run(JSON.stringify(role), role.id);
  }
  rememberModel(id: string, route: ModelRoute) { this.save({ ...this.role(id), lastModel: route }); }
  rootFor(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('角色路径标识无效');
    this.role(id);
    const directory = join(this.root, 'roles', id);
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory).toLowerCase() !== directory.toLowerCase()) throw new Error('角色目录不能是链接');
    return directory;
  }
  bindings(): Binding[] { return (this.db.prepare('SELECT data FROM bindings').all() as { data: string }[]).map(x => JSON.parse(x.data)); }
  binding(sessionId: string): Binding | undefined {
    const row = this.db.prepare('SELECT data FROM bindings WHERE session_id=?').get(sessionId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  bind(sessionId: string, roleId: string, speakerName: string) {
    this.role(roleId);
    const existing = this.binding(sessionId);
    if (existing) throw new Error('会话已绑定；请创建新会话来改变身份');
    const binding: Binding = { sessionId, roleId, speakerName, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO bindings VALUES(?,?,?)').run(sessionId, roleId, JSON.stringify(binding));
    return binding;
  }
  importRecord(sourceKey: string): { roleId: string; data: unknown } | undefined {
    const row = this.db.prepare('SELECT role_id,data FROM imports WHERE source_key=?').get(sourceKey) as { role_id: string; data: string } | undefined;
    return row ? { roleId: row.role_id, data: JSON.parse(row.data) } : undefined;
  }
  saveImport(sourceKey: string, roleId: string, data: unknown) {
    this.db.prepare('INSERT INTO imports VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET data=excluded.data').run(sourceKey, roleId, JSON.stringify(data));
  }
  close() { this.db.close(); }
}
