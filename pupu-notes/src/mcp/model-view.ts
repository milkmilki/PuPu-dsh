import type { Json, JsonObject } from '../contracts.js';

const INTERNAL_FIELD = /^(?:id|ids|seq|uuid|revision|fingerprint|operation|operation_id|operation_key|task_id|trigger_id|source_key|record_key|session_id|sessionId|messageId|message_id|person_key|speaker_key|speaker_qq|key|linked_task_id|origin_thread_id|source_context_session|source_msg_start_id|source_msg_end_id|start_msg_id|end_msg_id|source_start_id|source_end_id|imported_digest|last_indexed_at)$/i;
const INTERNAL_SUFFIX = /(?:^|_)(?:id|ids|uuid|fingerprint|digest|key)$/i;
const LABELS: Record<string, string> = {
  person_facts: '人物记事', fact_evidence: '记事的原始证据', event_threads: '往事',
  event_steps: '事情的经过', event_thread_rollups: '较早经历的整理',
  event_people: '经历中的人物关系', event_thread_aliases: '往事的其他称呼',
  people: '人物资料', messages: '原始对话', archived_messages: '归档对话',
  summaries: '过去的随记', archived_summaries: '归档随记', summary_rollups: '随记整理',
  familiarity: '关系资料', events: '关系变化', scheduled_tasks: '过去的约定或任务',
  fact_value: '内容', fact_key: '记下的事', title: '标题', summary: '摘要', content: '原话',
  text: '内容', description: '描述', display_name: '名称', speaker_name: '说话者',
  role: '发言方', party: '发言方', aliases: '其他称呼', status: '当时的状态',
  evidence_text: '证据原文', source: '来源说明', timestamp: '时间',
  created_at: '记录时间', updated_at: '修改时间', occurred_at: '发生时间', archived_at: '归档时间',
  cause: '缘由', reflection: '当时的感受', followup_hint: '后续打算',
  rollup_summary: '之前的经历', open_loops: '尚未完成的事', stable_outcomes: '已经确定的结果',
  time_text: '时间说明', event_time: '发生时间', date: '日期', confidence: '原资料的把握程度',
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function meaningful(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(meaningful);
  if (!isObject(value)) return null;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'fact_key' && (INTERNAL_FIELD.test(key) || INTERNAL_SUFFIX.test(key))) continue;
    if (key === 'metadata' && isObject(item)) {
      if (typeof item.path === 'string') result.path = item.path;
      continue;
    }
    if (['data', 'payload'].includes(key) && typeof item === 'string') {
      try { result[LABELS[key] ?? key] = meaningful(JSON.parse(item)); continue; } catch { /* ordinary evidence text remains literal */ }
    }
    result[LABELS[key] ?? key.replaceAll('_', ' ')] = meaningful(item);
  }
  return result;
}
function attachments(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const readable: JsonObject = {};
    const walk = (node: unknown) => {
      if (!isObject(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (['name', 'filename', 'fileName', 'displayName', 'mimeType', 'mediaType', 'size', 'bytes', 'width', 'height', 'type'].includes(key) &&
          (typeof value === 'string' || typeof value === 'number')) readable[key] = value;
        else if (isObject(value)) walk(value);
      }
    };
    walk(item);
    if (!Object.keys(readable).length) readable.description = '原消息附有附件，原始引用已保留。';
    return readable;
  });
}
function dialogue(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const key of ['party', 'speaker', 'text', 'at'])
    if (typeof value[key] === 'string') result[key] = value[key];
  const refs = attachments(value.attachments);
  if (refs.length) result.attachments = refs;
  return result;
}
function evidence(value: unknown): Json {
  if (!isObject(value)) return meaningful(value);
  if (value.kind === 'dialogue' || ('speaker' in value && 'text' in value)) return { kind: 'dialogue', ...dialogue(value) };
  if (value.kind === 'legacy' && typeof value.content === 'string') {
    try { return evidence(JSON.parse(value.content)); } catch { return { kind: 'evidence', content: value.content }; }
  }
  if (isObject(value.record)) return {
    kind: 'evidence',
    description: LABELS[String(value.table)] ?? '过去保存的资料',
    details: meaningful(value.record),
  };
  const result: JsonObject = { kind: typeof value.kind === 'string' ? value.kind : 'evidence' };
  for (const key of ['content', 'text', 'description', 'path', 'at'])
    if (typeof value[key] === 'string') result[key] = value[key];
  if (isObject(value.metadata) && typeof value.metadata.path === 'string') result.path = value.metadata.path;
  return result;
}

/** Projection only: the private engine response and original evidence stay intact. */
export function modelResult(value: JsonObject): JsonObject {
  const result: JsonObject = {};
  const simple = [
    'kind', 'path', 'query', 'content', 'startLine', 'totalLines', 'nextStartLine',
    'offset', 'total', 'nextOffset', 'saved', 'deleted', 'recoverable', 'restored',
    'moved', 'to', 'archived', 'explanation', 'error', 'status',
  ];
  for (const key of simple) if (value[key] !== undefined) result[key] = value[key]!;
  if (Array.isArray(value.entries)) result.entries = value.entries.map((item): JsonObject => {
    if (!isObject(item)) return {};
    return { path: String(item.path ?? ''), kind: String(item.kind ?? '') };
  });
  if (Array.isArray(value.matches)) result.matches = value.matches.map((item): JsonObject => {
    if (!isObject(item)) return {};
    return { path: String(item.path ?? ''), line: Number(item.line ?? 1), snippet: String(item.snippet ?? '') };
  });
  if (Array.isArray(value.messages)) result.messages = value.messages.map(item => isObject(item) ? dialogue(item) : {});
  if (Array.isArray(value.sources)) result.sources = value.sources.map(evidence);
  if (Array.isArray(value.updatedLinksIn)) result.updatedLinksIn = value.updatedLinksIn.filter(item => typeof item === 'string');
  return result;
}
