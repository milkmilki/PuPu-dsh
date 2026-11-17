import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Dialogue, DialogueInput, JsonObject, Task, TaskReason, TranscriptEntry, Trigger } from '../contracts.js';
import { transaction } from './database.js';
import { digest, NotesError, NotesFiles, timestamp } from './files.js';

interface TaskRow {
  id: string; trigger_id: string; session_id: string; reason: TaskReason; status: Task['status'];
  lower_bound: number; upper_bound: number; created_at: string; updated_at: string;
  error: string | null; progress: string;
}
interface SourceRow {
  seq: number; session_id: string; message_id: string; party: 'human' | 'assistant';
  speaker: string; text: string; attachments: string; at: string;
}
interface ManifestRow { path: string; revision: string; line_count: number; read_lines: string; content: string }
export const pageNumber = (value: number | undefined, fallback: number, maximum: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum)
    throw new NotesError('INVALID_PAGE', '分页参数必须是允许范围内的非负整数。');
  return resolved;
};
export const sourceFromRow = (row: SourceRow): Dialogue => ({
  seq: Number(row.seq), sessionId: row.session_id, messageId: row.message_id,
  party: row.party, speaker: row.speaker, text: row.text,
  attachments: JSON.parse(row.attachments) as Dialogue['attachments'], at: row.at,
});

export class TaskStore {
  constructor(readonly db: DatabaseSync, readonly files: NotesFiles) {
    db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE status='running'").run(timestamp());
  }
  capture(input: DialogueInput): { seq: number; inserted: boolean } {
    if (!input.sessionId || !input.messageId || !['human', 'assistant'].includes(input.party) ||
      typeof input.text !== 'string' || typeof input.speaker !== 'string' || !Number.isFinite(Date.parse(input.at)))
      throw new NotesError('INVALID_DIALOGUE', '对话记录缺少稳定身份、说话者或有效时间。');
    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM dialogue WHERE session_id=? AND message_id=?')
        .get(input.sessionId, input.messageId) as unknown as SourceRow | undefined;
      if (previous) {
        if (previous.party !== input.party || (input.party !== 'assistant' && previous.speaker !== input.speaker) || previous.text !== input.text ||
          previous.attachments !== JSON.stringify(input.attachments ?? []))
          throw new NotesError('MESSAGE_CONFLICT', '同一消息标识的已保存内容不同，拒绝覆盖原始证据。');
        return { seq: Number(previous.seq), inserted: false };
      }
      const result = this.db.prepare('INSERT INTO dialogue(session_id,message_id,party,speaker,text,attachments,at) VALUES (?,?,?,?,?,?,?)')
        .run(input.sessionId, input.messageId, input.party, input.speaker, input.text, JSON.stringify(input.attachments ?? []), input.at);
      return { seq: Number(result.lastInsertRowid), inserted: true };
    });
  }
  cursor(sessionId: string): number {
    return Number((this.db.prepare('SELECT seq FROM cursors WHERE session_id=?').get(sessionId) as { seq: number } | undefined)?.seq ?? 0);
  }
  register(trigger: Trigger): Task {
    if (!trigger.triggerId || !trigger.sessionId || !['manual', 'compaction', 'import'].includes(trigger.reason))
      throw new NotesError('INVALID_TRIGGER', '对话触发必须有稳定标识、会话和有效原因。');
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT id FROM tasks WHERE trigger_id=?').get(trigger.triggerId) as { id: string } | undefined;
      if (existing) {
        const task = this.get(existing.id);
        if (task.sessionId !== trigger.sessionId || task.reason !== trigger.reason ||
          (trigger.upperBound !== undefined && task.upperBound !== trigger.upperBound))
          throw new NotesError('TRIGGER_CONFLICT', '同一触发标识不能用于不同的会话或边界。');
        return task;
      }
      const maximum = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS maximum FROM dialogue WHERE session_id=?')
        .get(trigger.sessionId) as { maximum: number }).maximum);
      const upper = trigger.upperBound === undefined ? maximum : pageNumber(trigger.upperBound, maximum, Number.MAX_SAFE_INTEGER);
      if (upper > maximum) throw new NotesError('INVALID_BOUNDARY', '触发上界超出已持久化对话。');
      const lower = this.cursor(trigger.sessionId);
      const id = randomUUID(), now = timestamp();
      const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM dialogue WHERE session_id=? AND seq>? AND seq<=?')
        .get(trigger.sessionId, lower, upper) as { count: number }).count);
      this.db.prepare('INSERT INTO tasks(id,trigger_id,session_id,reason,status,lower_bound,upper_bound,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, trigger.triggerId, trigger.sessionId, trigger.reason, count ? 'queued' : 'completed', lower, upper, now, now);
      this.db.prepare('INSERT INTO task_sources(task_id,seq) SELECT ?,seq FROM dialogue WHERE session_id=? AND seq>? AND seq<=?')
        .run(id, trigger.sessionId, lower, upper);
      return this.get(id);
    });
  }
  registerDaily(day: string): Task {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new NotesError('INVALID_DAY', '整理日期必须为本地 YYYY-MM-DD。');
    const existing = this.db.prepare('SELECT id FROM tasks WHERE trigger_id=?').get(`daily:${day}`) as { id: string } | undefined;
    if (existing) return this.get(existing.id);
    // Capture every session's fixed high water mark before the full-library pass.
    const sessions = this.db.prepare('SELECT session_id FROM dialogue GROUP BY session_id ORDER BY MIN(seq)').all() as { session_id: string }[];
    for (const row of sessions) {
      const maximum = Number((this.db.prepare('SELECT MAX(seq) AS maximum FROM dialogue WHERE session_id=?').get(row.session_id) as { maximum: number }).maximum);
      if (maximum > this.cursor(row.session_id))
        this.register({ triggerId: `daily:${day}:source:${row.session_id}`, sessionId: row.session_id, upperBound: maximum, reason: 'manual' });
    }
    return transaction(this.db, () => {
      const again = this.db.prepare('SELECT id FROM tasks WHERE trigger_id=?').get(`daily:${day}`) as { id: string } | undefined;
      if (again) return this.get(again.id);
      const id = randomUUID(), now = timestamp();
      this.db.prepare('INSERT INTO tasks(id,trigger_id,session_id,reason,status,lower_bound,upper_bound,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, `daily:${day}`, '', 'daily', 'queued', 0, 0, now, now);
      return this.get(id);
    });
  }
  progress(taskId: string): JsonObject {
    const source = this.db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(read),0) AS read FROM task_sources WHERE task_id=?')
      .get(taskId) as { total: number; read: number };
    const manifests = this.db.prepare('SELECT path,line_count,read_lines FROM task_manifest WHERE task_id=?')
      .all(taskId) as unknown as ManifestRow[];
    const completed = manifests.filter(row => (JSON.parse(row.read_lines) as number[]).length >= row.line_count).length;
    return {
      sourceMessages: Number(source.total), readMessages: Number(source.read),
      files: manifests.length, readFiles: completed,
      unreadPaths: manifests.filter(row => (JSON.parse(row.read_lines) as number[]).length < row.line_count).map(row => row.path),
    };
  }
  get(taskId: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as TaskRow | undefined;
    if (!row) throw new NotesError('TASK_NOT_FOUND', '找不到这个记忆任务。');
    return {
      id: row.id, triggerId: row.trigger_id, sessionId: row.session_id, reason: row.reason,
      status: row.status, lowerBound: Number(row.lower_bound), upperBound: Number(row.upper_bound),
      createdAt: row.created_at, updatedAt: row.updated_at, ...(row.error ? { error: row.error } : {}),
      progress: { ...(JSON.parse(row.progress) as JsonObject), ...this.progress(row.id) },
    };
  }
  list(): Task[] {
    return (this.db.prepare('SELECT id FROM tasks ORDER BY rowid').all() as { id: string }[]).map(row => this.get(row.id));
  }
  next(): Task | null {
    return transaction(this.db, () => {
      for (;;) {
        const row = this.db.prepare("SELECT * FROM tasks WHERE status!='completed' ORDER BY rowid LIMIT 1").get() as unknown as TaskRow | undefined;
        if (!row || row.status === 'failed' || row.status === 'stopped') return null;
        if (row.status === 'running') return this.get(row.id);
        if (row.reason !== 'daily') {
          const lower = Math.max(Number(row.lower_bound), this.cursor(row.session_id));
          this.db.prepare('UPDATE tasks SET lower_bound=? WHERE id=?').run(lower, row.id);
          this.db.prepare('DELETE FROM task_sources WHERE task_id=? AND seq<=?').run(row.id, lower);
          const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM task_sources WHERE task_id=?').get(row.id) as { count: number }).count);
          if (!count) {
            this.db.prepare("UPDATE tasks SET status='completed',updated_at=? WHERE id=?").run(timestamp(), row.id);
            continue;
          }
        } else {
          const initialized = (JSON.parse(row.progress) as JsonObject).manifestInitialized === true;
          if (!initialized) {
            const insert = this.db.prepare('INSERT INTO task_manifest(task_id,path,revision,line_count,content) VALUES (?,?,?,?,?)');
            for (const snapshot of this.files.walk())
              insert.run(row.id, snapshot.path, digest(snapshot.content!), snapshot.content!.split('\n').length, snapshot.content!);
            this.db.prepare('UPDATE tasks SET progress=? WHERE id=?').run(JSON.stringify({ manifestInitialized: true }), row.id);
          }
        }
        this.db.prepare("UPDATE tasks SET status='running',updated_at=?,error=NULL WHERE id=?").run(timestamp(), row.id);
        return this.get(row.id);
      }
    });
  }
  assertActive(taskId: string): Task {
    const task = this.get(taskId);
    if (task.status !== 'running') throw new NotesError('TASK_NOT_RUNNING', '任务不在运行中，不能继续读写。');
    return task;
  }
  sourcePage(taskId: string, offset = 0, limit = 30): JsonObject {
    this.assertActive(taskId);
    offset = pageNumber(offset, 0, Number.MAX_SAFE_INTEGER);
    limit = pageNumber(limit, 30, 100);
    if (!limit) throw new NotesError('INVALID_PAGE', '每页消息数量必须大于零。');
    const rows = this.db.prepare('SELECT d.* FROM task_sources s JOIN dialogue d ON d.seq=s.seq WHERE s.task_id=? ORDER BY d.seq LIMIT ? OFFSET ?')
      .all(taskId, limit, offset) as unknown as SourceRow[];
    const mark = this.db.prepare('UPDATE task_sources SET read=1 WHERE task_id=? AND seq=?');
    const read = this.db.prepare('INSERT OR IGNORE INTO task_reads(task_id,source_key) VALUES (?,?)');
    transaction(this.db, () => { for (const row of rows) { mark.run(taskId, row.seq); read.run(taskId, `dialogue:${row.seq}`); } });
    const total = Number((this.db.prepare('SELECT COUNT(*) AS total FROM task_sources WHERE task_id=?').get(taskId) as { total: number }).total);
    return { kind: 'dialogue', offset, total, nextOffset: offset + rows.length < total ? offset + rows.length : null,
      messages: rows.map(row => sourceFromRow(row)) as unknown as JsonObject['messages'] };
  }
  /** Snapshot reads guarantee that chat edits cannot fake daily start-manifest coverage. */
  manifestSnapshot(taskId: string, path: string): ManifestRow | undefined {
    this.assertActive(taskId);
    return this.db.prepare('SELECT * FROM task_manifest WHERE task_id=? AND path=?').get(taskId, path) as unknown as ManifestRow | undefined;
  }
  recordFileRead(taskId: string, path: string, content: string, startLine: number, count: number): void {
    this.assertActive(taskId);
    transaction(this.db, () => {
      const row = this.manifestSnapshot(taskId, path);
      if (row && row.revision === digest(content)) {
        const lines = new Set(JSON.parse(row.read_lines) as number[]);
        for (let line = startLine; line < Math.min(startLine + count, row.line_count + 1); line++) lines.add(line);
        this.db.prepare('UPDATE task_manifest SET read_lines=? WHERE task_id=? AND path=?')
          .run(JSON.stringify([...lines]), taskId, path);
      }
      this.db.prepare('INSERT OR IGNORE INTO task_reads(task_id,source_key) VALUES (?,?)')
        .run(taskId, `note:${path}@${digest(content)}`);
    });
  }
  finish(taskId: string): Task {
    return transaction(this.db, () => {
      const task = this.assertActive(taskId), progress = this.progress(taskId);
      if (Number(progress.readMessages) !== Number(progress.sourceMessages) || Number(progress.readFiles) !== Number(progress.files))
        throw new NotesError('INCOMPLETE_READ', '尚未通读本任务的对话或起始笔记清单，不能标为完成。');
      if (task.reason === 'daily' && task.progress.manifestInitialized !== true)
        throw new NotesError('INCOMPLETE_READ', '日常整理尚未建立笔记清单。');
      if (task.sessionId) this.db.prepare('INSERT INTO cursors(session_id,seq) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET seq=MAX(seq,excluded.seq)')
        .run(task.sessionId, task.upperBound);
      this.db.prepare("UPDATE tasks SET status='completed',updated_at=?,error=NULL WHERE id=?").run(timestamp(), taskId);
      return this.get(taskId);
    });
  }
  setStatus(taskId: string, status: Task['status'], error?: string): Task {
    const existing = this.get(taskId);
    if (existing.status === 'completed') return existing;
    this.db.prepare('UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?').run(status, error ?? null, timestamp(), taskId);
    return this.get(taskId);
  }
  retry(taskId: string): Task {
    const task = this.get(taskId);
    if (task.status === 'completed') return task;
    if (task.status === 'running') throw new NotesError('TASK_RUNNING', '请先停止正在运行的任务。');
    return this.setStatus(taskId, 'queued');
  }
  stop(taskId: string): Task {
    const task = this.get(taskId);
    return task.status === 'completed' ? task : this.setStatus(taskId, 'stopped', '已手动停止；保留已应用的笔记操作。');
  }
  transcript(taskId: string): TranscriptEntry[] {
    this.get(taskId);
    return (this.db.prepare('SELECT kind,payload,at FROM transcripts WHERE task_id=? ORDER BY seq').all(taskId) as
      { kind: TranscriptEntry['kind']; payload: string; at: string }[]).map(row => ({
        kind: row.kind, payload: JSON.parse(row.payload) as TranscriptEntry['payload'], at: row.at,
      }));
  }
  append(taskId: string, entry: TranscriptEntry): void {
    this.get(taskId);
    if (!['request', 'response', 'tool', 'error'].includes(entry.kind) || !Number.isFinite(Date.parse(entry.at)))
      throw new NotesError('INVALID_TRANSCRIPT', '模型轨迹记录无效。');
    this.db.prepare('INSERT INTO transcripts(task_id,kind,payload,at) VALUES (?,?,?,?)')
      .run(taskId, entry.kind, JSON.stringify(entry.payload), entry.at);
  }
}
