import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import LlmRuntime, {
  LlmAdapter, createUserMessage, type GenerateOptions,
  type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { installPersona, assertDispatchedPersona } from '../src/host/persona.js';
import { changeBlankSession, selectionState } from '../src/host/session-selector.js';
import type { Role } from '../src/contracts.js';

class SelectorAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  override providerInfo(provider: string) { return { id: provider, name: provider }; }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }
  override async* stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '你好。' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
async function runtime() {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new SelectorAdapter();
  ctx.llm.registerAdapter(['selector'], adapter);
  const agent = await ctx.agentLoop.create(SessionId('selector-session'), { provider: 'selector', model: 'memory' });
  return { ctx, adapter, agent };
}
const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test('session selection distinguishes an untouched session from pending or committed dialogue', async () => {
  const { ctx, agent } = await runtime();
  try {
    assert.deepEqual(selectionState(agent), { locked: false, running: false });
    const pending = message('已经排队的第一句话。');
    agent.inbox.append('next-turn', pending);
    assert.deepEqual(selectionState(agent), { locked: true, running: false });
    let called = false;
    await assert.rejects(changeBlankSession(agent, async () => { called = true; }), /开聊后/);
    assert.equal(called, false);
    agent.inbox.clear();
    assert.equal(selectionState(agent).locked, false);
    agent.followup(message('正式开始。'));
    await agent.whenIdle();
    assert.equal(selectionState(agent).locked, true);
    await assert.rejects(changeBlankSession(agent, async () => {}), /开聊后/);
  } finally { await ctx.fiber.dispose(); }
});

test('real maintenance admission holds a racing first message until the selected persona and tools are installed', async () => {
  const { ctx, agent, adapter } = await runtime();
  const entered = deferred(), release = deferred();
  try {
    const role: Role = { id: 'lulu', name: '璐璐', speakerName: '知夏姐姐', roleCardPath: '角色.md', createdAt: '' };
    const change = changeBlankSession(agent, async signal => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
      await installPersona(agent, role, role.speakerName, async () => ({ path: '角色.md', content: '喜欢看海。' }));
      agent.ctx.tools.register({
        name: 'pupu_notes', description: '璐璐的笔记', parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] },
        execute: async () => ({}),
      });
    });
    await entered.promise;
    assert.deepEqual(selectionState(agent), { locked: false, running: true });
    agent.followup(message('你好，璐璐。'));
    assert.equal(adapter.requests.length, 0);
    release.resolve();
    await change;
    await agent.whenIdle();
    assert.equal(adapter.requests.length, 1);
    assertDispatchedPersona(adapter.requests[0]!.messages, '璐璐', '知夏姐姐');
    assert.ok(adapter.requests[0]!.tools?.some(tool => tool.name === 'pupu_notes'));
    assert.deepEqual(selectionState(agent), { locked: true, running: false });
  } finally { release.resolve(); await ctx.fiber.dispose(); }
});

test('concurrent selections cannot interleave or release the first selection admission', async () => {
  const { ctx, agent } = await runtime();
  const entered = deferred(), release = deferred();
  try {
    const first = changeBlankSession(agent, async () => { entered.resolve(); await release.promise; return 'first'; });
    await entered.promise;
    let secondCalled = false;
    await assert.rejects(changeBlankSession(agent, async () => { secondCalled = true; }), /正在/);
    assert.equal(secondCalled, false);
    assert.equal(selectionState(agent).running, true);
    release.resolve();
    assert.equal(await first, 'first');
    assert.deepEqual(selectionState(agent), { locked: false, running: false });
  } finally { release.resolve(); await ctx.fiber.dispose(); }
});

test('another SDK maintenance owner rejects selection even while public Agent status is idle', async () => {
  const { ctx, agent } = await runtime();
  const entered = deferred(), release = deferred();
  try {
    const maintenance = agent.runMaintenance(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    assert.equal(agent.status, 'idle');
    let changed = false;
    await assert.rejects(changeBlankSession(agent, async () => { changed = true; }), /维护任务/);
    assert.equal(changed, false);
    release.resolve();
    await maintenance;
    assert.equal(await changeBlankSession(agent, async () => 'available'), 'available');
  } finally { release.resolve(); await ctx.fiber.dispose(); }
});

test('a failed or cancelled selection releases admission and keeps a blank session recoverable', async () => {
  const { ctx, agent } = await runtime();
  const entered = deferred(), release = deferred();
  try {
    await assert.rejects(changeBlankSession(agent, async () => { throw new Error('角色卡不可读'); }), /角色卡不可读/);
    assert.deepEqual(selectionState(agent), { locked: false, running: false });
    const change = changeBlankSession(agent, async signal => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
    });
    await entered.promise;
    agent.cancel({ kind: 'user' });
    release.resolve();
    await assert.rejects(change);
    assert.deepEqual(selectionState(agent), { locked: false, running: false });
    assert.equal(await changeBlankSession(agent, async () => 'retried'), 'retried');
  } finally { release.resolve(); await ctx.fiber.dispose(); }
});

test('a trusted same-identity repair preserves history and holds later input until the persona is restored', async () => {
  const { ctx, agent, adapter } = await runtime();
  const entered = deferred(), release = deferred();
  let disposePersona: (() => void) | undefined;
  let removeGate: (() => void) | undefined;
  try {
    const role: Role = { id: 'lulu', name: '璐璐', speakerName: '知夏姐姐', roleCardPath: '角色.md', createdAt: '' };
    disposePersona = await installPersona(agent, role, role.speakerName,
      async () => ({ path: '角色.md', content: '喜欢看海。' }));
    agent.followup(message('我们已经开始了这次对话。'));
    await agent.whenIdle();
    const originalEvents = agent.session.snapshotEvents();
    assert.equal(adapter.requests.length, 1);
    assert.equal(selectionState(agent).locked, true);
    await assert.rejects(changeBlankSession(agent, async () => {}), /开聊后/);
    removeGate = agent.ctx.on('llm/stream', async function* () {
      throw new Error('角色身份等待恢复');
    });
    const repair = changeBlankSession(agent, async signal => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
      disposePersona?.();
      disposePersona = await installPersona(agent, role, role.speakerName,
        async () => ({ path: '角色.md', content: '喜欢看海，正在继续这次对话。' }));
      removeGate?.();
      removeGate = undefined;
    }, { sameIdentityRepair: true });
    await entered.promise;
    assert.equal(selectionState(agent).running, true);
    agent.followup(message('还是我们两个人，继续聊吧。'));
    assert.equal(adapter.requests.length, 1);
    release.resolve();
    await repair;
    await agent.whenIdle();
    assert.equal(adapter.requests.length, 2);
    assertDispatchedPersona(adapter.requests[1]!.messages, '璐璐', '知夏姐姐');
    const finalEvents = agent.session.snapshotEvents();
    assert.deepEqual(finalEvents.slice(0, originalEvents.length), originalEvents);
    assert.equal(finalEvents.filter(event => event.type === 'user/message').length, 2);
    assert.equal(selectionState(agent).locked, true);
  } finally {
    release.resolve();
    removeGate?.();
    disposePersona?.();
    await ctx.fiber.dispose();
  }
});
