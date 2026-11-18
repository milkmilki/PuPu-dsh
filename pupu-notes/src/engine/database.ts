import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(roleRoot: string): DatabaseSync {
  mkdirSync(roleRoot, { recursive: true });
  const db = new DatabaseSync(join(roleRoot, 'state.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS engine_owner (slot INTEGER PRIMARY KEY CHECK(slot=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dialogue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, message_id TEXT NOT NULL, party TEXT NOT NULL,
      speaker TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL,
      at TEXT NOT NULL, UNIQUE(session_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS cursors (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL, lower_bound INTEGER NOT NULL,
      upper_bound INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      error TEXT, progress TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS task_sources (
      task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL REFERENCES dialogue(seq),
      read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,seq)
    );
    CREATE TABLE IF NOT EXISTS task_manifest (
      task_id TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL,
      revision TEXT NOT NULL, line_count INTEGER NOT NULL, read_lines TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      PRIMARY KEY(task_id,path)
    );
    CREATE TABLE IF NOT EXISTS task_reads (
      task_id TEXT NOT NULL REFERENCES tasks(id), source_key TEXT NOT NULL,
      PRIMARY KEY(task_id,source_key)
    );
    CREATE TABLE IF NOT EXISTS actor_reads (
      actor TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY(actor,source_key)
    );
    CREATE TABLE IF NOT EXISTS read_revisions (
      scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL,
      PRIMARY KEY(scope,path)
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
      kind TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, plan TEXT NOT NULL, result TEXT NOT NULL,
      task_id TEXT, actor TEXT, at TEXT NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT,
      operation TEXT NOT NULL, at TEXT NOT NULL, operation_id TEXT NOT NULL,
      UNIQUE(operation_id,path)
    );
    CREATE TABLE IF NOT EXISTS provenance (
      path TEXT NOT NULL, source_key TEXT NOT NULL, operation_id TEXT NOT NULL,
      PRIMARY KEY(path,source_key,operation_id)
    );
    CREATE TABLE IF NOT EXISTS source_documents (
      source_key TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_aliases (
      path TEXT NOT NULL, original_path TEXT NOT NULL,
      PRIMARY KEY(path,original_path)
    );
    CREATE INDEX IF NOT EXISTS dialogue_session ON dialogue(session_id,seq);
    CREATE INDEX IF NOT EXISTS tasks_order ON tasks(created_at,id);
    CREATE INDEX IF NOT EXISTS versions_path ON versions(path,id);
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = callback(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
