import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { generateMemoryResponse } from '../src/host/generate.js';

const request = {
  route: { provider: 'test', model: 'note-model' }, messages: [], tools: [],
  signal: new AbortController().signal,
};
function stream(chunks: StreamChunk[], observe?: (options: GenerateOptions) => void) {
  return async function* (options: GenerateOptions) {
    observe?.(options);
    yield* chunks;
  };
}

test('background model call preserves assistant blocks and route without using visible session', async () => {
  const result = await generateMemoryResponse(stream([
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'internal replay' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call-a'), name: 'notes', arguments: '{"action":"view","path":"/"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ], options => {
    assert.equal(options.provider, 'test');
    assert.equal(options.model, 'note-model');
    assert.equal(options.sessionId, undefined);
    assert.equal(options.system, undefined);
  }), request);
  assert.equal(result.finish, 'tool-calls');
  assert.equal(result.message.content.length, 2);
  assert.equal(result.message.source.provider, 'test');
});

test('truncated response cannot expose any executable tool call', async () => {
  const result = await generateMemoryResponse(stream([
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('partial'), name: 'notes', arguments: '{"action":"delete","path":"角色.md"}' } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]), request);
  assert.equal(result.finish, 'max-tokens');
  assert.equal(result.message.content.some(block => block.type === 'tool-call'), false);
});

test('missing terminal and cancelled requests do not become normal completion', async () => {
  await assert.rejects(generateMemoryResponse(stream([
    { type: 'text-delta', index: 0, text: 'incomplete' },
  ]), request), /缺少结束标记/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateMemoryResponse(stream([]), { ...request, signal: controller.signal }));
});
