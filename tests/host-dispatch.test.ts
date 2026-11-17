import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import LlmRuntime, {
  LlmAdapter, ToolCallId, createUserMessage,
  type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { installPersona, assertDispatchedPersona } from '../src/host/persona.js';
import type { Role } from '../src/contracts.js';

class CapturingAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(private responses: StreamChunk[][]) { super(); }
  override providerInfo(provider: string) { return { id: provider, name: provider }; }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }
  override async* stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('Unexpected model request');
    yield* response;
  }
}
const text = (value: string): StreamChunk[] => [
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const readNotes: StreamChunk[] = [
  { type: 'block-end', index: 0, block: {
    type: 'tool-call', id: ToolCallId('read-own-notes'), name: 'pupu_notes', arguments: '{"action":"view","path":"经历/看海.md"}',
  } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
];

test('real AgentLoop dispatch replaces identity on first call, tool continuation and changed-card turn', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, {
      personaPrefix: 'You are a coding agent powered by the {{model}} model.',
      personaSuffix: 'You are a helpful AI assistant. Keep tool permissions.',
    });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    const adapter = new CapturingAdapter([readNotes, text('我想起来了，我们说好一起去海边。'), text('现在我喜欢山林。'), text('ordinary')]);
    ctx.llm.registerAdapter(['capture'], adapter);
    ctx.systemPrompt.section({ name: 'native-tool-guidance', order: 100, text: 'Keep native tool guidance, including subagent operations.' });
    ctx.systemPrompt.context({ name: 'required-cwd', order: 100, text: 'Working directory: D:\\isolated', required: true });
    const agent = await ctx.agentLoop.create(SessionId('notes-persona'), { provider: 'capture', model: 'memory-model' });
    const role: Role = { id: 'role-a', name: '璐璐', speakerName: '小夫', roleCardPath: '角色.md', createdAt: '' };
    let card = '璐璐喜欢看海。';
    await installPersona(agent, role, '小夫', async () => ({ path: '角色.md', content: card }));
    let reads = 0;
    agent.ctx.tools.register({
      name: 'pupu_notes', description: '自己的笔记',
      parameters: { type: 'object', properties: { action: { type: 'string' }, path: { type: 'string' } }, required: ['action'] },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '小夫和璐璐约定一起去海边。' }] },
      execute: async () => { reads++; return {}; },
    });
    agent.ctx.on('llm/stream', async function* (request, next) {
      if (request.sessionId === agent.id) assertDispatchedPersona(request.messages, role.name, '小夫');
      yield* next();
    });
    async function send(subject: Agent, value: string) {
      subject.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }));
      await subject.whenIdle();
    }
    await send(agent, '你还记得我们约好去哪儿吗？');
    assert.equal(reads, 1);
    assert.equal(adapter.requests.length, 2);
    for (const request of adapter.requests) {
      assert.equal(request.system, undefined);
      assert.equal(request.provider, 'capture');
      assert.equal(request.model, 'memory-model');
      assertDispatchedPersona(request.messages, '璐璐', '小夫');
      const system = request.messages.find(message => message.role === 'system')!;
      const prompt = system.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.equal(prompt.match(/璐璐喜欢看海/g)?.length, 1);
      assert.doesNotMatch(prompt, /coding agent|You are an AI agent powered|helpful AI assistant/);
      assert.match(prompt, /Keep native tool guidance, including subagent operations/);
      assert.match(prompt, /Keep tool permissions/);
      assert.ok(request.tools?.some(tool => tool.name === 'pupu_notes'));
      assert.ok(request.messages.some(message => message.content.some(block =>
        block.type === 'text' && block.text.includes('Working directory: D:\\isolated'))));
    }
    const continuation = adapter.requests[1]!;
    assert.ok(continuation.messages.some(message => message.role === 'tool' &&
      message.content.some(block => block.type === 'text' && block.text.includes('约定一起去海边'))));
    card = '璐璐现在更喜欢山林。';
    await send(agent, '你现在喜欢哪里？');
    const changed = adapter.requests[2]!;
    const changedPrompt = changed.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.match(changedPrompt, /璐璐现在更喜欢山林/);
    assert.doesNotMatch(changedPrompt, /璐璐喜欢看海/);
    const ordinary = await ctx.agentLoop.create(SessionId('ordinary-session'), { provider: 'capture', model: 'memory-model' });
    await send(ordinary, '你好');
    const plain = adapter.requests[3]!;
    assert.ok(plain.messages.some(message => message.role === 'system' &&
      message.content.some(block => block.type === 'text' && block.text.includes('You are an AI agent powered by DeepSeek Harness.'))));
    assert.equal(plain.tools?.some(tool => tool.name === 'pupu_notes') ?? false, false);
  } finally {
    await ctx.fiber.dispose();
  }
});
