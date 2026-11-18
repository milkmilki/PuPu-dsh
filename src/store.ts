import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { messageKey } from './protocol'
import { DEFAULT_MERGE_SECONDS } from './batching'
import { defaultConfig, type BridgeConfig, type Contact, type Incoming, type Inbox, type InputBatch, type Outbox, type Route, type Segment } from './types'

export class Store {
  readonly db: DatabaseSync
  private readonly lock: string
  private readonly owner = { pid: process.pid, nonce: randomUUID() }
  constructor(readonly root: string, readonly now = Date.now) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.lock = join(root, 'bridge.lock')
    try { writeFileSync(this.lock, JSON.stringify(this.owner), { flag: 'wx', mode: 0o600 }) } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
      const old = JSON.parse(readFileSync(this.lock, 'utf8'))
      let alive = true
      try { process.kill(old.pid, 0) } catch (e: any) { if (e.code === 'ESRCH') alive = false }
      if (alive) throw new Error('此数据目录已有 QQ 网关实例运行；请先停止另一实例')
      unlinkSync(this.lock); writeFileSync(this.lock, JSON.stringify(this.owner), { flag: 'wx', mode: 0o600 })
    }
    this.db = new DatabaseSync(join(root, 'bridge.db'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (account TEXT, peer TEXT, nickname TEXT, status TEXT NOT NULL, PRIMARY KEY(account,peer));
      CREATE TABLE IF NOT EXISTS routes (account TEXT, peer TEXT, session TEXT UNIQUE NOT NULL, value TEXT NOT NULL, PRIMARY KEY(account,peer));
      CREATE TABLE IF NOT EXISTS inbox (key TEXT PRIMARY KEY, account TEXT, peer TEXT, value TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, account TEXT, peer TEXT, value TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS input_batches (key TEXT PRIMARY KEY, account TEXT, peer TEXT, session TEXT NOT NULL, message_keys TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS input_batch_members (message_key TEXT PRIMARY KEY, batch_key TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS input_batch_members_by_batch ON input_batch_members(batch_key);
      UPDATE outbox SET status='uncertain',error='发送中断，结果未知；重试前请检查 QQ' WHERE status='sending';`)
  }
  close() { this.db.close(); if (JSON.parse(readFileSync(this.lock, 'utf8')).nonce === this.owner.nonce) unlinkSync(this.lock) }
  config(): BridgeConfig { return { mergeWindowSeconds: this.setting('merge-window-seconds') ?? DEFAULT_MERGE_SECONDS, ...(this.setting('config') ?? structuredClone(defaultConfig)) } }
  setting(key: string): any { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) : undefined }
  set(key: string, value: any) {
    if (key === 'config' && Object.hasOwn(value, 'mergeWindowSeconds')) {
      const { mergeWindowSeconds, ...connections } = value
      this.transaction(() => { this.set('merge-window-seconds', mergeWindowSeconds); this.set('config', connections) }); return
    }
    this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  }
  contacts(): Contact[] { return this.db.prepare('SELECT * FROM contacts ORDER BY account,peer').all() as unknown as Contact[] }
  contact(account: string, peer: string) { return this.contacts().find(c => c.account === account && c.peer === peer) }
  admit(account: string, peer: string, status: Contact['status']) {
    if (!this.contact(account, peer)) throw new Error('联系人不存在')
    this.db.prepare('UPDATE contacts SET status=? WHERE account=? AND peer=?').run(status, account, peer)
  }
  receive(message: Incoming): boolean {
    this.db.prepare(`INSERT INTO contacts VALUES (?,?,?,'pending') ON CONFLICT(account,peer) DO UPDATE SET nickname=excluded.nickname`).run(message.account, message.peer, message.nickname)
    if (this.contact(message.account, message.peer)?.status === 'rejected') return false
    const key = messageKey(message.account, message.id)
    if (this.db.prepare('SELECT 1 FROM inbox WHERE key=?').get(key)) return false
    const count = this.db.prepare("SELECT count(*) AS n FROM inbox WHERE account=? AND peer=? AND status='received'").get(message.account, message.peer)!
    if (Number(count.n) >= 100) throw new Error('该联系人待处理消息达到 100 条，请先处理队列')
    return !!this.db.prepare("INSERT OR IGNORE INTO inbox (key,account,peer,value,status,error) VALUES (?,?,?,?,'received',NULL)").run(key, message.account, message.peer, JSON.stringify({ ...message, receivedAt: this.now() })).changes
  }
  pending(): Inbox[] {
    return this.db.prepare("SELECT i.* FROM inbox i JOIN contacts c USING(account,peer) WHERE i.status='received' AND NOT EXISTS (SELECT 1 FROM input_batch_members m WHERE m.message_key=i.key) AND c.status='approved' AND NOT EXISTS (SELECT 1 FROM inbox p WHERE p.account=i.account AND p.peer=i.peer AND p.status='error' AND p.rowid<i.rowid) ORDER BY i.rowid").all().map(r => this.input(r))
  }
  private input(r: any): Inbox { return { ...JSON.parse(String(r.value)), key: String(r.key), status: String(r.status), error: r.error ?? undefined, batchKey: r.batch_key ?? undefined, batchSize: r.batch_size ? Number(r.batch_size) : undefined } }
  inbox(): Inbox[] { return this.db.prepare("SELECT i.*, m.batch_key, (SELECT COUNT(*) FROM input_batch_members b WHERE b.batch_key=m.batch_key) AS batch_size FROM inbox i LEFT JOIN input_batch_members m ON m.message_key=i.key WHERE status NOT IN ('accepted','discarded') ORDER BY i.rowid").all().map(r => this.input(r)) }
  sealBatch(items: Inbox[], sessionId: string): InputBatch {
    if (!items.length || items.some(i => i.account !== items[0].account || i.peer !== items[0].peer)) throw new Error('合并批次必须属于同一账号和联系人')
    const keys = items.map(i => i.key), key = keys.length === 1 ? keys[0] : `batch:${createHash('sha256').update(JSON.stringify(keys)).digest('hex')}`
    this.transaction(() => {
      this.db.prepare("INSERT INTO input_batches VALUES (?,?,?,?,?,'received')").run(key, items[0].account, items[0].peer, sessionId, JSON.stringify(keys))
      for (const member of keys) if (this.db.prepare("INSERT INTO input_batch_members SELECT key,? FROM inbox WHERE key=? AND status='received'").run(key, member).changes !== 1) throw new Error('来信状态已变化，未创建合并批次')
    })
    return { key, account: items[0].account, peer: items[0].peer, sessionId, items }
  }
  pendingBatches(): InputBatch[] {
    return this.db.prepare("SELECT b.* FROM input_batches b JOIN contacts c USING(account,peer) WHERE b.status='received' AND c.status='approved' AND NOT EXISTS (SELECT 1 FROM inbox p WHERE p.account=b.account AND p.peer=b.peer AND p.status='error' AND p.rowid<(SELECT MIN(i.rowid) FROM inbox i JOIN input_batch_members m ON m.message_key=i.key WHERE m.batch_key=b.key)) ORDER BY b.rowid").all().map(r => ({ key: String(r.key), account: String(r.account), peer: String(r.peer), sessionId: String(r.session), items: JSON.parse(String(r.message_keys)).map((key: string) => this.input(this.db.prepare('SELECT * FROM inbox WHERE key=?').get(key))) }))
  }
  inState(key: string, status: string, error?: string) {
    const batch = this.db.prepare('SELECT batch_key FROM input_batch_members WHERE message_key=?').get(key)?.batch_key
    if (!batch) { this.db.prepare('UPDATE inbox SET status=?,error=? WHERE key=?').run(status, error ?? null, key); return }
    this.transaction(() => {
      this.db.prepare('UPDATE input_batches SET status=? WHERE key=?').run(status, batch)
      this.db.prepare('UPDATE inbox SET status=?,error=? WHERE key IN (SELECT message_key FROM input_batch_members WHERE batch_key=?)').run(status, error ?? null, batch)
    })
  }
  routes(): Route[] { return this.db.prepare('SELECT value FROM routes').all().map(r => JSON.parse(String(r.value))) }
  route(account: string, peer: string) { return this.routes().find(r => r.account === account && r.peer === peer) }
  session(id: string) { return this.routes().find(r => r.sessionId === id) }
  saveRoute(route: Route) { this.db.prepare('INSERT INTO routes VALUES (?,?,?,?) ON CONFLICT(account,peer) DO UPDATE SET session=excluded.session,value=excluded.value').run(route.account, route.peer, route.sessionId, JSON.stringify(route)) }
  enqueue(key: string, account: string, peer: string, segments: Segment[]) {
    return !!this.db.prepare("INSERT OR IGNORE INTO outbox VALUES (?,?,?,?,'pending',NULL,NULL)").run(key, account, peer, JSON.stringify(segments)).changes
  }
  outgoing(): Outbox[] { return this.db.prepare('SELECT key,account,peer,status,receipt,error FROM outbox ORDER BY rowid DESC LIMIT 200').all().map(r => ({ key: String(r.key), account: String(r.account), peer: String(r.peer), segments: [], status: String(r.status), receipt: r.receipt ? String(r.receipt) : undefined, error: r.error ? String(r.error) : undefined })) }
  outStatus(key: string) { return this.db.prepare('SELECT status FROM outbox WHERE key=?').get(key)?.status }
  unsent(): Outbox[] { return this.db.prepare("SELECT o.* FROM outbox o WHERE o.status='pending' AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.account=o.account AND p.peer=o.peer AND p.rowid<o.rowid AND p.status IN ('failed','uncertain','sending')) ORDER BY o.rowid").all().map(r => ({ key: String(r.key), account: String(r.account), peer: String(r.peer), segments: JSON.parse(String(r.value)), status: String(r.status) })) }
  outState(key: string, status: string, receipt?: string, error?: string) { this.db.prepare('UPDATE outbox SET status=?,receipt=?,error=? WHERE key=?').run(status, receipt ?? null, error ?? null, key) }
  transaction(fn: () => void) { this.db.exec('BEGIN IMMEDIATE'); try { fn(); this.db.exec('COMMIT') } catch (e) { this.db.exec('ROLLBACK'); throw e } }
}
