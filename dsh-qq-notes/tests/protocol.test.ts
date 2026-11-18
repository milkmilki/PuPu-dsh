import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePrivate, splitText } from '../src/protocol'
import { completedReply } from '../src/final-reply'

test('private messages only, identity validation and self echo exclusion', () => {
  const event = { post_type: 'message', message_type: 'private', self_id: 111111, user_id: 222222, message_id: 42, sender: { nickname: 'N' }, message: [{ type: 'text', data: { text: 'hello' } }] }
  assert.equal(parsePrivate('a', '111111', event)?.peer, '222222')
  assert.equal(parsePrivate('a', '999999', event), null)
  assert.equal(parsePrivate('a', '111111', { ...event, user_id: 111111 }), null)
  assert.equal(parsePrivate('a', '111111', { ...event, message_type: 'group' }), null)
  assert.equal(parsePrivate('a', '111111', { ...event, message: '[CQ:image,file=x]' }), null)
  assert.equal(splitText('😀'.repeat(2000)).join(''), '😀'.repeat(2000))
})

test('only last completed step text is forwarded, never thoughts, tool text or aborted output', () => {
  const events: any[] = [
    { type: 'assistant/message', seq: 1, data: { turn: 't', step: 's1', message: { id: 'm1', content: [{ type: 'text', text: 'intermediate' }, { type: 'tool-call', name: 'read_file' }] } } },
    { type: 'assistant/message', seq: 2, data: { turn: 't', step: 's2', message: { id: 'm2', content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'final' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 't', reason: { kind: 'completed' } } },
  ]
  assert.deepEqual(completedReply(events, events[2]), { id: 'm2', text: 'final' })
  assert.equal(completedReply(events, { ...events[2], data: { turn: 't', reason: { kind: 'cancelled' } } }), null)
  assert.equal(completedReply(events, events[0]), null)
})
