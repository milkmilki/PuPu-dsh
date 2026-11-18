import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { EngineClient, Json, JsonObject, Role, TranscriptEntry } from '../src/contracts.js';
import { NotesEngine } from '../src/engine/index.js';
import { invokeAdmin } from '../src/mcp/server.js';
import { TaskRunner, type Generate, type GenerateResult } from '../src/runner.js';

let callSequence = 0;
const tool = (command: JsonObject, finish: GenerateResult['finish'] = 'tool-calls'): GenerateResult => ({
  finish,
  message: createAssistantMessage({
    source: { provider: 'test', model: 'memory', replayState: { token: 'lossless-test-metadata' } },
    content: [{ type: 'tool-call', id: ToolCallId(`tool-${++callSequence}`), name: 'notes', arguments: JSON.stringify(command) }],
  }),
});
const stop = (): GenerateResult => ({
  finish: 'stop',
  message: createAssistantMessage({ source: { provider: 'test', model: 'memory' }, content: [{ type: 'text', text: '整理完成。' }] }),
});
const setup = () => {
  const engine = new NotesEngine(mkdtempSync(join(tmpdir(), 'notes-runner-')), { roleName: '璐璐' });
  const role: Role = { id: 'role-a', name: '璐璐', speakerName: '小夫', roleCardPath: '角色.md', createdAt: new Date().toISOString(), lastModel: { provider: 'test', model: 'memory' } };
  const client: EngineClient = {
    notes: (command, context) => engine.execute(command, context),
    admin: async <T>(method: Parameters<EngineClient['admin']>[0], args: JsonObject = {}) => await invokeAdmin(engine, method, args) as T,
    close: async () => { engine.close(); },
  };
  engine.captureDialogue({ sessionId: 'a', messageId: '1', party: 'human', speaker: '小夫', text: '我喜欢热茶。', at: new Date().toISOString() });
  const task = engine.registerTrigger({ triggerId: 'compaction:a', sessionId: 'a', reason: 'compaction' });
  return { engine, role, client, task };
};
test('real source reading and natural note writing finish the fixed range, retaining later dialogue', async () => {
  const { engine, role, client, task } = setup();
  let requests = 0;
  const generate: Generate = async input => {
    assert.deepEqual(input.route, role.lastModel);
    assert.deepEqual(input.tools.map(schema => schema.name), ['notes']);
    requests++;
    if (requests === 1) {
      engine.captureDialogue({ sessionId: 'a', messageId: 'later', party: 'human', speaker: '小夫', text: '现在改喝温水。', at: new Date().toISOString() });
      return tool({ action: 'sources' });
    }
    if (requests === 2) {
      const source = input.messages.find(message => message.role === 'tool')!;
      assert.match(JSON.stringify(source), /热茶/);
      assert.doesNotMatch(JSON.stringify(source), /温水/);
      return tool({ action: 'create', path: '人物/小夫.md', content: '小夫喜欢热茶。' });
    }
    return stop();
  };
  const runner = new TaskRunner(() => role, async () => client, generate);
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'completed');
  assert.equal((await engine.execute({ action: 'view', path: '人物/小夫.md' })).content, '小夫喜欢热茶。');
  assert.equal(engine.stats().unprocessedMessages, 1);
  const stored = engine.transcript(task.id);
  assert.match(JSON.stringify(stored), /lossless-test-metadata/);
  await runner.close(); engine.close();
});
test('normal early stop receives actual missing coverage feedback and continues', async () => {
  const { engine, role, client, task } = setup();
  let requests = 0;
  const runner = new TaskRunner(() => role, async () => client, async input => {
    requests++;
    if (requests === 1) return stop();
    if (requests === 2) {
      assert.match(JSON.stringify(input.messages.at(-1)), /sourceMessages/);
      assert.match(JSON.stringify(input.messages.at(-1)), /readMessages/);
      return tool({ action: 'sources' });
    }
    return stop();
  });
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'completed');
  assert.equal(requests, 3);
  await runner.close(); engine.close();
});
test('accepted tool response resumes after write-before-tool-result crash exactly once', async () => {
  const { engine, role, client, task } = setup();
  const originalAdmin = client.admin;
  let simulatedCrash = false;
  client.admin = async <T>(method: Parameters<EngineClient['admin']>[0], args: JsonObject = {}) => {
    if (method === 'appendTranscript' && (args.entry as unknown as TranscriptEntry)?.kind === 'tool' &&
      JSON.stringify(args.entry).includes('saved') && !simulatedCrash) {
      simulatedCrash = true;
      throw new Error('模拟写入后进程中断');
    }
    return originalAdmin<T>(method, args);
  };
  let requests = 0;
  const generate: Generate = async () => {
    requests++;
    if (requests === 1) return tool({ action: 'sources' });
    if (requests === 2) return tool({ action: 'create', path: '人物/小夫.md', content: '喜欢热茶。' });
    return stop();
  };
  const runner = new TaskRunner(() => role, async () => client, generate);
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'failed');
  assert.equal(engine.versions('人物/小夫.md').length, 2);
  engine.retryTask(task.id);
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'completed');
  assert.equal(engine.versions('人物/小夫.md').length, 2);
  assert.equal(requests, 3);
  await runner.close(); engine.close();
});
test('max-token tool parameters are retained in trace but never executed', async () => {
  const { engine, role, client, task } = setup();
  const runner = new TaskRunner(() => role, async () => client, async () =>
    tool({ action: 'create', path: '随记/错误.md', content: '不应写入' }, 'max-tokens'));
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'failed');
  assert.equal((await engine.execute({ action: 'search', query: '不应写入' })).total, 0);
  assert.match(JSON.stringify(engine.transcript(task.id)), /max-tokens/);
  assert.equal(engine.stats().unprocessedMessages, 1);
  await runner.close(); engine.close();
});
test('non-cooperative provider is cut off at request timeout and failure blocks later sessions', async () => {
  const { engine, role, client, task } = setup();
  engine.captureDialogue({ sessionId: 'b', messageId: '1', party: 'human', speaker: '知夏姐姐', text: '另一会话', at: new Date().toISOString() });
  const later = engine.registerTrigger({ triggerId: 'later', sessionId: 'b', reason: 'manual' });
  const runner = new TaskRunner(() => role, async () => client, async () => new Promise<GenerateResult>(() => {}), 20);
  const keepAlive = setInterval(() => {}, 1000);
  try { runner.wake(role.id); await runner.idle(); } finally { clearInterval(keepAlive); }
  assert.equal(engine.getTask(task.id).status, 'failed');
  assert.equal(engine.getTask(later.id).status, 'queued');
  assert.equal(engine.nextTask(), null);
  await runner.close(); engine.close();
});
test('manual stop interrupts an independent model request and preserves applied writes', async () => {
  const { engine, role, client, task } = setup();
  let reachedRequest!: () => void;
  const waiting = new Promise<void>(resolve => { reachedRequest = resolve; });
  let requests = 0;
  const runner = new TaskRunner(() => role, async () => client, async () => {
    requests++;
    if (requests === 1) return tool({ action: 'sources' });
    if (requests === 2) return tool({ action: 'create', path: '随记/已应用.md', content: '保留已经写下的内容。' });
    reachedRequest();
    return new Promise<GenerateResult>(() => {});
  });
  runner.wake(role.id); await waiting;
  await runner.stop(role.id, task.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'stopped');
  assert.equal((await engine.execute({ action: 'view', path: '随记/已应用.md' })).content, '保留已经写下的内容。');
  assert.equal(engine.stats().unprocessedMessages, 1);
  await runner.close(); engine.close();
});
test('independent memory model overrides chat model without a cumulative turn cutoff', async () => {
  const { engine, role, client, task } = setup();
  role.memoryModel = { provider: 'other', model: 'notebook' };
  let requests = 0;
  const runner = new TaskRunner(() => role, async () => client, async input => {
    assert.deepEqual(input.route, role.memoryModel);
    requests++;
    if (requests < 202) return tool({ action: 'view' });
    if (requests === 202) return tool({ action: 'sources' });
    return stop();
  });
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'completed');
  assert.equal(requests, 203);
  await runner.close(); engine.close();
});
test('suspend and close preserve queued work for safe export and restart without showing a false failure', async () => {
  const { engine, role, client, task } = setup();
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let requests = 0;
  const runner = new TaskRunner(() => role, async () => client, async () => {
    requests++;
    if (requests === 1) { began(); return new Promise<GenerateResult>(() => {}); }
    if (requests === 2) return tool({ action: 'sources' });
    return stop();
  });
  runner.wake(role.id); await started;
  await runner.suspend(role.id);
  assert.equal(engine.getTask(task.id).status, 'queued');
  assert.equal(engine.stats().unprocessedMessages, 1);
  runner.wake(role.id); await runner.idle();
  assert.equal(requests, 1);
  runner.resume(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'completed');
  await runner.close(); engine.close();
});
test('stopping a queued future task does not cancel the currently running model request', async () => {
  const { engine, role, client, task } = setup();
  engine.captureDialogue({ sessionId: 'b', messageId: '1', party: 'human', speaker: '小夫', text: '未来任务', at: new Date().toISOString() });
  const future = engine.registerTrigger({ triggerId: 'future', sessionId: 'b', reason: 'manual' });
  let reached!: () => void, finishRequest!: (output: GenerateResult) => void;
  const pending = new Promise<void>(resolve => { reached = resolve; });
  let requests = 0;
  const runner = new TaskRunner(() => role, async () => client, async () => {
    requests++;
    if (requests === 1) return tool({ action: 'sources' });
    reached();
    return new Promise<GenerateResult>(resolve => { finishRequest = resolve; });
  });
  runner.wake(role.id); await pending;
  await runner.stop(role.id, future.id);
  assert.equal(engine.getTask(task.id).status, 'running');
  finishRequest(stop()); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'completed');
  assert.equal(engine.getTask(future.id).status, 'stopped');
  await runner.close(); engine.close();
});
test('tasks with no configured route stay queued and can start when a model becomes available', async () => {
  const { engine, role, client, task } = setup();
  delete role.lastModel;
  let requests = 0;
  const runner = new TaskRunner(() => role, async () => client, async () => {
    requests++;
    return requests === 1 ? tool({ action: 'sources' }) : stop();
  });
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'queued');
  assert.equal(requests, 0);
  role.lastModel = { provider: 'test', model: 'memory' };
  runner.wake(role.id); await runner.idle();
  assert.equal(engine.getTask(task.id).status, 'completed');
  await runner.close(); engine.close();
});
