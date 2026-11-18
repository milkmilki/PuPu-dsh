import { basename } from 'node:path';
import type { Json } from '../contracts.js';
import {
  hash, readOnly, recordKey, safeName, tableSnapshot,
  type Projection, type RecordRef, type Row, type Snapshot,
} from './shared.js';

const LEGACY_TABLES = new Set([
  'messages', 'archived_messages', 'familiarity', 'events', 'summaries',
  'person_facts', 'scheduled_tasks', 'maintenance_runs', 'memory_mutations',
  'event_threads', 'event_thread_aliases', 'event_thread_rollups', 'event_steps',
  'people', 'event_people', 'fact_evidence', 'engine_meta', 'message_receipts',
  'memory_jobs', 'model_requests', 'review_triggers', 'engine_audit', 'memory_conflicts',
  'summary_rollups', 'archived_summaries',
]);
export function readLegacySnapshot(path: string): Snapshot {
  const db = readOnly(path);
  try {
    // One SQLite read transaction keeps every table on the same WAL snapshot.
    db.exec('BEGIN');
    const result = tableSnapshot(db, LEGACY_TABLES);
    if (!result.person_facts || !result.event_threads || !result.messages) throw new Error('不是支持的 PuPu 记忆库');
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
export function legacySourceIdentity(path: string, snapshot: Snapshot): string {
  const key = snapshot.engine_meta?.find(row => row.key === 'character_id' || row.key === 'role_id')?.value;
  let parsed = key;
  try { if (typeof key === 'string') parsed = JSON.parse(key) as string; } catch { /* raw legacy metadata is also supported */ }
  return hash(parsed ? `legacy-role:${parsed}` : `legacy-path:${path.toLowerCase()}`);
}
export function referenceWarnings(snapshot: Snapshot): string[] {
  const links = [
    ['event_steps', 'thread_id', 'event_threads', 'id'],
    ['event_thread_rollups', 'thread_id', 'event_threads', 'id'],
    ['fact_evidence', 'fact_id', 'person_facts', 'id'],
    ['event_people', 'person_key', 'people', 'person_key'],
  ];
  return links.flatMap(([from, field, to, key]) => {
    const known = new Set((snapshot[to!] ?? []).map(row => String(row[key!])));
    const missing = (snapshot[from!] ?? []).filter(row => row[field!] != null && !known.has(String(row[field!]))).length;
    return missing ? [`${from} 有 ${missing} 条历史引用缺少目标，原样保留供核查。`] : [];
  });
}
function relatedRecords(snapshot: Snapshot, initial: RecordRef[]): RecordRef[] {
  const selected = new Map<string, RecordRef>();
  const index = new Map<string, Row>();
  for (const [table, rows] of Object.entries(snapshot))
    rows.forEach((row, number) => index.set(`${table}:${recordKey(row, number)}`, row));
  const add = (table: string, row: Row, number: number) => {
    const ref = { table, key: recordKey(row, number) };
    selected.set(`${table}:${ref.key}`, ref);
  };
  const ranges: { session: string; start: number; end: number }[] = [];
  for (const ref of initial) {
    selected.set(`${ref.table}:${ref.key}`, ref);
    const row = index.get(`${ref.table}:${ref.key}`);
    if (!row) continue;
    if (ref.table === 'person_facts') {
      (snapshot.fact_evidence ?? []).forEach((evidence, number) => {
        if (String(evidence.fact_id) !== String(row.id)) return;
        add('fact_evidence', evidence, number);
        ranges.push({
          session: String(evidence.source_context_session ?? row.source_context_session ?? ''),
          start: Number(evidence.source_msg_start_id), end: Number(evidence.source_msg_end_id),
        });
      });
    }
    if (ref.table === 'event_threads') {
      for (const table of ['event_people', 'event_thread_aliases', 'scheduled_tasks']) {
        (snapshot[table] ?? []).forEach((linked, number) => {
          if (String(linked.thread_id) === String(row.id) || String(linked.id) === String(row.linked_task_id))
            add(table, linked, number);
        });
      }
    }
    const session = row.source_context_session ?? row.session_id;
    const start = row.source_msg_start_id ?? row.start_msg_id;
    const end = row.source_msg_end_id ?? row.end_msg_id;
    if (start !== undefined && start !== null && end !== undefined && end !== null)
      ranges.push({ session: String(session ?? ''), start: Number(start), end: Number(end) });
  }
  for (const table of ['messages', 'archived_messages']) (snapshot[table] ?? []).forEach((message, number) => {
    if (ranges.some(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
      Number(message.id) >= range.start && Number(message.id) <= range.end &&
      (!range.session || String(message.session_id) === range.session))) add(table, message, number);
  });
  const selectedMessages = new Set([...selected.values()]
    .filter(ref => ref.table === 'messages' || ref.table === 'archived_messages')
    .map(ref => index.get(`${ref.table}:${ref.key}`))
    .filter((row): row is Row => !!row)
    .map(row => JSON.stringify([String(row.session_id), Number(row.id)])));
  (snapshot.message_receipts ?? []).forEach((receipt, number) => {
    if (receipt.message_id !== null && receipt.message_id !== undefined &&
      selectedMessages.has(JSON.stringify([String(receipt.session_id), Number(receipt.message_id)])))
      add('message_receipts', receipt, number);
  });
  return [...selected.values()];
}

/** Lossless first projection; the model may later rewrite the natural notes. */
export function projectLegacy(
  snapshot: Snapshot, mapping: Record<string, string>, roleName: string, persona = '',
): Map<string, Projection> {
  const notes = new Map<string, Projection>();
  const names = new Map((snapshot.people ?? []).map(person => [
    String(person.person_key), mapping[String(person.person_key)] || String(person.display_name || '未命名人物'),
  ]));
  const naturalSession = (value: unknown): string => {
    const raw = String(value ?? '');
    const normalized = raw.replace(/^(?:private_|group_)/, '');
    const matched = (snapshot.people ?? []).find(person =>
      String(person.person_key) === raw || (person.qq_id != null && String(person.qq_id) === normalized));
    return matched ? names.get(String(matched.person_key))! : raw === 'owner' || raw === 'desktop_owner'
      ? '当时的对话者' : '旧对话中的关系';
  };
  const personPaths = new Map<string, string>(), used = new Set<string>();
  const unique = (base: string): string => {
    let path = base, number = 2;
    while (used.has(path.toLocaleLowerCase('en-US'))) path = base.replace(/\.md$/, `（同名资料${number++}）.md`);
    used.add(path.toLocaleLowerCase('en-US')); return path;
  };
  const add = (path: string, content: string, table?: string, key?: string) => {
    const note = notes.get(path) ?? { content: '', records: [] };
    note.content += content;
    if (table && key !== undefined) note.records.push({ table, key });
    notes.set(path, note);
  };
  for (const [number, person] of (snapshot.people ?? []).entries()) {
    const key = String(person.person_key), name = names.get(key) ?? '未命名人物';
    const path = unique(`人物/${safeName(name)}.md`);
    personPaths.set(key, path);
    add(path, `# ${name}\n\n${person.aliases ? `称呼：${person.aliases}\n\n` : ''}`, 'people', recordKey(person, number));
  }
  for (const [number, fact] of (snapshot.person_facts ?? []).entries()) {
    const personKey = String(fact.subject_person_key), name = names.get(personKey) ?? '旧资料中的人物';
    let path = personPaths.get(personKey);
    if (!path) {
      path = unique(`人物/${safeName(name)}.md`); personPaths.set(personKey, path); add(path, `# ${name}\n\n`);
    }
    const related = names.get(String(fact.object_person_key));
    const history = fact.status && fact.status !== 'active' ? `（历史资料：${fact.status}）` : '';
    add(path, `## ${fact.fact_key || '记下的事'}${history}\n\n${related ? `涉及${related}。\n\n` : ''}${fact.fact_value ?? ''}\n\n`,
      'person_facts', recordKey(fact, number));
  }
  const assignedSteps = new Set<string>(), assignedRollups = new Set<string>();
  for (const [number, thread] of (snapshot.event_threads ?? []).entries()) {
    const path = unique(`经历/${safeName(String(thread.title || '往事'))}.md`);
    add(path, `# ${thread.title || '往事'}\n\n${thread.time_text || thread.event_time || ''}\n\n${thread.status ? `进展：${thread.status}\n\n` : ''}${thread.rollup_summary || ''}\n\n${thread.followup_hint ? `接下来：${thread.followup_hint}\n\n` : ''}`,
      'event_threads', recordKey(thread, number));
    for (const [i, rollup] of (snapshot.event_thread_rollups ?? []).entries()) if (String(rollup.thread_id) === String(thread.id)) {
      assignedRollups.add(recordKey(rollup, i));
      add(path, `## 之前的经历\n\n${rollup.summary || ''}\n\n${rollup.open_loops || ''}\n\n${rollup.stable_outcomes || ''}\n\n`,
        'event_thread_rollups', recordKey(rollup, i));
    }
    for (const [i, step] of (snapshot.event_steps ?? []).entries()) if (String(step.thread_id) === String(thread.id)) {
      assignedSteps.add(recordKey(step, i));
      add(path, `## ${step.occurred_at || '事情的经过'}\n\n${step.summary || ''}\n\n${step.cause ? `缘由：${step.cause}\n\n` : ''}${step.reflection ? `当时的感受：${step.reflection}\n\n` : ''}`,
        'event_steps', recordKey(step, i));
    }
  }
  for (const [table, assigned] of [['event_steps', assignedSteps], ['event_thread_rollups', assignedRollups]] as const)
    (snapshot[table] ?? []).forEach((row, number) => {
      if (!assigned.has(recordKey(row, number))) add('经历/尚未关联的往事.md',
        `## 尚未关联的片段\n\n${row.summary ?? ''}\n\n${row.cause ?? ''}\n\n${row.reflection ?? ''}\n\n${row.open_loops ?? ''}\n\n${row.stable_outcomes ?? ''}\n\n`,
      table, recordKey(row, number));
    });
  for (const table of ['summaries', 'archived_summaries', 'summary_rollups'])
    (snapshot[table] ?? []).forEach((row, number) => {
      const day = String(row.created_at || '旧日随记').slice(0, 10), path = `随记/${safeName(day)}.md`;
      if (!notes.has(path)) add(path, `# ${day}\n\n`);
      add(path, `${row.summary || ''}\n\n`, table, recordKey(row, number));
    });
  (snapshot.events ?? []).forEach((row, number) => add('随记/关系变化.md',
    `## ${row.date || '曾经'}\n\n${row.description || ''}\n\n`, 'events', recordKey(row, number)));
  (snapshot.familiarity ?? []).forEach((row, number) => add('人物/过去的关系.md',
    `## ${naturalSession(row.session_id)}\n\n${row.level || '过去的关系记录'}${row.updated_at ? `，记录于${row.updated_at}` : ''}。\n\n`,
    'familiarity', recordKey(row, number)));
  (snapshot.memory_conflicts ?? []).forEach((row, number) => add('随记/待核对的记忆.md',
    `## 曾经发现的分歧\n\n${row.explanation || ''}\n\n${row.status ? `处理情况：${row.status}\n\n` : ''}`,
    'memory_conflicts', recordKey(row, number)));
  (snapshot.scheduled_tasks ?? []).forEach((row, number) => add('随记/过去的提醒.md',
    `## ${row.title || '过去记下的安排'}\n\n${row.instruction || ''}\n\n${row.run_at ? `原定时间：${row.run_at}\n\n` : ''}这是一条历史资料，不会执行提醒。\n\n`,
    'scheduled_tasks', recordKey(row, number)));
  for (const table of ['maintenance_runs', 'memory_mutations', 'engine_audit', 'memory_jobs', 'model_requests', 'review_triggers', 'engine_meta']) {
    const rows = snapshot[table] ?? [];
    if (!rows.length) continue;
    const path = '随记/整理历史.md';
    if (!notes.has(path)) add(path, '# 整理历史\n\n旧库的整理报告、变更和任务历史保存在本页来源中。这里的任务不会在新的宿主上执行。\n');
    rows.forEach((row, number) => notes.get(path)!.records.push({ table, key: recordKey(row, number) }));
  }
  for (const table of ['messages', 'archived_messages']) (snapshot[table] ?? []).forEach((row, number) => {
    const day = String(row.timestamp || '旧日对话').slice(0, 10), path = `随记/原始对话/${safeName(day)}.md`;
    if (!notes.has(path)) add(path, `# ${day}的原始对话\n\n这里保留了当天的原话。需要核对细节时，可以查看这页笔记的来源。\n`);
    notes.get(path)!.records.push({ table, key: recordKey(row, number) });
  });
  notes.set('角色.md', { content: `# ${roleName}\n\n${persona || `你是${roleName}。`}\n`, records: [] });
  notes.set('目录.md', { content: `# ${roleName}的笔记\n\n## 人物\n\n${[...personPaths.values()].map(path => `- [${basename(path, '.md')}](${path})`).join('\n')}\n\n## 经历\n\n${[...notes.keys()].filter(path => path.startsWith('经历/')).map(path => `- [${basename(path, '.md')}](${path})`).join('\n')}\n\n## 随记\n\n过去的摘要和关系变化在随记里；[原始对话](随记/原始对话/)保留了逐字资料。\n`, records: [] });
  for (const note of notes.values()) note.records = relatedRecords(snapshot, note.records);
  return notes;
}

/** Only reviewed high-water marks prove which old dialogue was already handled. */
export function legacyDialoguePlan(snapshot: Snapshot, sourceKey: string) {
  const cursors = new Map<string, number>();
  for (const row of snapshot.engine_meta ?? []) if (String(row.key).startsWith('review:')) {
    let decoded = row.value;
    try { if (typeof decoded === 'string') decoded = JSON.parse(decoded) as string | number | null; } catch { /* accept plain numeric values */ }
    const value = Number(decoded);
    if (Number.isSafeInteger(value) && value >= 0) cursors.set(String(row.key).slice('review:'.length), value);
  }
  const messages = new Map<string, Row>();
  const receiptAttachments = new Map<string, Map<string, Json>>();
  for (const receipt of snapshot.message_receipts ?? []) {
    if (receipt.message_id === null || receipt.message_id === undefined ||
      !Number.isSafeInteger(Number(receipt.message_id)) || typeof receipt.attachments !== 'string') continue;
    try {
      const attachments: unknown = JSON.parse(receipt.attachments);
      if (!Array.isArray(attachments)) continue;
      const key = JSON.stringify([String(receipt.session_id), Number(receipt.message_id)]);
      const values = receiptAttachments.get(key) ?? new Map<string, Json>();
      for (const attachment of attachments) values.set(JSON.stringify(attachment), attachment as Json);
      receiptAttachments.set(key, values);
    } catch { /* Malformed attachment metadata stays intact in the original source archive. */ }
  }
  for (const table of ['archived_messages', 'messages']) for (const row of snapshot[table] ?? []) {
    if (!['user', 'assistant'].includes(String(row.role)) || !cursors.has(String(row.session_id))) continue;
    if (!Number.isSafeInteger(Number(row.id)) || typeof row.content !== 'string' || !Number.isFinite(Date.parse(String(row.timestamp)))) continue;
    messages.set(`${row.session_id}:${row.id}`, row);
  }
  return {
    cursors,
    messages: [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id)),
    attachments: (row: Row): Json[] => [...(receiptAttachments.get(
      JSON.stringify([String(row.session_id), Number(row.id)]),
    )?.values() ?? [])],
    session: (name: string) => `legacy:${sourceKey}:${name}`,
  };
}
