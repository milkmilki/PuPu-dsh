import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createScope } from '@deepseek-ai/dsh-scope';
import { installPersona, operationalSuffix, assertDispatchedPersona } from '../src/host/persona.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Role } from '../src/contracts.js';

const role: Role = { id: 'a', name: '璐璐', speakerName: '小夫', roleCardPath: '角色.md', createdAt: '' };
async function mint(ctx: Context, key: Agent) {
  let scope!: ReturnType<typeof createScope>;
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key); }, { inject: ['systemPrompt'] }));
  return scope;
}

test('suffix strips identity sentences and preserves operational content', () => {
  assert.equal(operationalSuffix('You are a coding agent. Keep file permissions intact.\nUse the supplied tools.'), 'Keep file permissions intact.\nUse the supplied tools.');
  assert.equal(operationalSuffix('你是编程助手。请在项目目录工作。保留工具权限。'), '请在项目目录工作。\n保留工具权限。');
});

test('real DSH registry replaces scoped identity, preserves runtime/tools and refreshes role card', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {
    personaPrefix: 'You are an AI coding agent. Your model is {{model}}. Preserve file permissions.',
    personaSuffix: 'You are a helpful AI assistant. Keep permissions intact.',
  });
  ctx.systemPrompt.variable('model', () => 'test-model');
  ctx.systemPrompt.section({ name: 'tool:keep', order: 100, text: 'Keep native tool instructions.' });
  ctx.systemPrompt.context({ name: 'cwd', order: 100, text: 'D:\\debug', required: true });
  ctx.systemPrompt.tools(() => ({ schemas: [{ name: 'shell', description: 'native', parameters: { type: 'object' } }] }));
  const key = {} as Agent;
  const scope = await mint(ctx, key);
  const agent = Object.assign(key, { ctx: scope.ctx });
  let card = '# 角色\n喜欢看海。';
  const dispose = await installPersona(agent, role, '小夫', async () => ({ path: '角色.md', content: card }));
  const first = await ctx.systemPrompt.assemble({ scope: agent, agent });
  const text = renderPrompt(first);
  assert.match(text, /^你是璐璐。/);
  assert.equal(text.match(/喜欢看海/g)?.length, 1);
  assert.doesNotMatch(text, /AI agent|coding agent|helpful AI assistant/);
  assert.match(text, /Keep native tool instructions/);
  assert.match(text, /Preserve file permissions/);
  assert.match(text, /Keep permissions intact/);
  assert.equal(first.contexts[0]?.text, 'D:\\debug');
  assert.equal(first.tools[0]?.name, 'shell');
  const ordinary = renderPrompt(await ctx.systemPrompt.assemble());
  assert.match(ordinary, /You are an AI agent powered by DeepSeek Harness/);
  card = '喜欢山林。';
  const next = renderPrompt(await ctx.systemPrompt.assemble({ scope: agent, agent }));
  assert.match(next, /喜欢山林/);
  assert.doesNotMatch(next, /喜欢看海/);
  assert.equal(next.match(/喜欢山林/g)?.length, 1);
  assertDispatchedPersona([
    { role: 'system', content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'tool-call' }] },
    { role: 'tool', content: [{ type: 'text', text: 'tool result' }] },
    { role: 'system', content: [{ type: 'text', text: next }] },
  ], '璐璐', '小夫');
  dispose();
  await scope.dispose();
  await ctx.fiber.dispose();
});

test('fresh Agent scope after restart re-reads persisted card and preserves model variables', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a coding agent.' });
  ctx.systemPrompt.variable('provider', () => 'deepseek');
  ctx.systemPrompt.variable('model', () => 'deepseek-chat');
  const key = {} as Agent;
  const scope = await mint(ctx, key);
  await installPersona(Object.assign(key, { ctx: scope.ctx }), role, '知夏姐姐',
    async () => ({ path: '人物设定.md', content: '重启后仍喜欢山林。' }));
  const assembly = await ctx.systemPrompt.assemble({ scope: key, agent: key });
  assert.equal(assembly.variables.model, 'deepseek-chat');
  assert.equal(assembly.variables.provider, 'deepseek');
  assertDispatchedPersona([{ role: 'system', content: [{ type: 'text', text: renderPrompt(assembly) }] }], '璐璐', '知夏姐姐');
  assert.match(renderPrompt(assembly), /重启后仍喜欢山林/);
  await scope.dispose();
  await ctx.fiber.dispose();
});

test('complete prompt conflict fails replacement instead of appending a persona', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {});
  ctx.systemPrompt.section({ name: 'conflict', order: 100, text: 'You are another identity.', complete: true });
  const key = {} as Agent;
  const scope = await mint(ctx, key);
  await assert.rejects(installPersona(Object.assign(key, { ctx: scope.ctx }), role, '小夫',
    async () => ({ path: '角色.md', content: '卡片' })), /complete/);
  await scope.dispose();
  await ctx.fiber.dispose();
});

test('dispatch guard catches missing and leaked stock identity in actual system messages', () => {
  assertDispatchedPersona([{ role: 'system', content: [{ type: 'text', text: '你是璐璐。\n现在与你交谈的是小夫。' }] }], '璐璐', '小夫');
  assert.throws(() => assertDispatchedPersona([{ role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }] }], '璐璐', '小夫'));
});
