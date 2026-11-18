import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogueFromEvent } from '../src/host/dialogue.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { Binding, Role } from '../src/contracts.js';

const role: Role = { id: 'a', name: '璐璐', speakerName: '小夫', roleCardPath: '角色.md', createdAt: '' };
const binding: Binding = { sessionId: 'session-a', roleId: 'a', speakerName: '知夏姐姐', createdAt: '' };
function event(type: string, data: unknown): SessionEvent {
  return { seq: 7, type, data, time: Date.UTC(2026, 10, 17) } as SessionEvent;
}

test('capture filters injected context, reasoning, tools, failed attempts and compaction', () => {
  const mixed = [
    event('user/message', { id: 'human', source: { kind: 'user' }, content: [{ type: 'text', text: '今天去看海' }] }),
    event('user/message', { id: 'harness', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'cwd secret' }] }),
    event('user/message', { id: 'summary', source: { kind: 'compaction' }, content: [{ type: 'text', text: '压缩摘要' }] }),
    event('assistant/message', { message: { id: 'assistant', content: [
      { type: 'reasoning', text: '思考内容' }, { type: 'text', text: '好呀，我们一起去。' },
      { type: 'tool-call', name: 'shell', arguments: '{}', id: 'call' },
    ] } }),
    event('assistant/attempt', { stream: [] }),
    event('tool/result', { message: { content: [{ type: 'text', text: '结果' }] } }),
    event('compaction/start', { compactionId: 'compact' }),
  ];
  const actual = mixed.map(item => dialogueFromEvent(item, binding, role)).filter(Boolean);
  assert.equal(actual.length, 2);
  assert.deepEqual(actual.map(item => [item!.speaker, item!.text]), [
    ['知夏姐姐', '今天去看海'], ['璐璐', '好呀，我们一起去。'],
  ]);
  assert.deepEqual(actual.map(item => item!.messageId), ['human', 'assistant']);
});

test('capture retains existing attachment references and committed interrupted visible text', () => {
  const attachment = { type: 'file', attachment: { name: '合照', path: '/readonly/photo' } };
  const actual = dialogueFromEvent(event('assistant/message', {
    interrupted: true, message: { id: 'prefix', content: [{ type: 'text', text: '我记得' }, attachment] },
  }), binding, role)!;
  assert.equal(actual.text, '我记得');
  assert.deepEqual(actual.attachments, [attachment]);
  assert.equal(actual.sessionId, binding.sessionId);
});
