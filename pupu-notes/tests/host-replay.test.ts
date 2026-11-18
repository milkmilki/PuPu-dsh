import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayBarrier } from '../src/host/replay.js';

test('startup live suffix cannot overtake old compaction boundary or another session replay', async () => {
  type Event = { seq: number; type: 'message' | 'compaction'; content?: string };
  const gate = new ReplayBarrier<Event>(['a', 'b']);
  const captures: string[] = [], boundaries: string[][] = [];
  const inspectPrefix: Event[] = [
    { seq: 0, type: 'message', content: 'old' },
    { seq: 1, type: 'compaction' },
  ];
  assert.equal(gate.buffer('b', { seq: 2, type: 'message', content: 'later' }), true);
  assert.equal(gate.buffer('b', { seq: 1, type: 'compaction' }), true);
  for (const event of inspectPrefix) {
    if (event.type === 'message') captures.push(event.content!);
    else boundaries.push([...captures]);
  }
  const suffix = gate.release('b').filter(event => event.seq > inspectPrefix.at(-1)!.seq);
  for (const event of suffix) if (event.type === 'message') captures.push(event.content!);
  assert.deepEqual(boundaries, [['old']]);
  assert.deepEqual(captures, ['old', 'later']);
  assert.equal(gate.buffer('b', { seq: 3, type: 'message' }), false);
  assert.equal(gate.buffer('a', { seq: 4, type: 'message' }), true);
});
