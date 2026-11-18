import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  renderPrompt,
  type PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt';
import type { Role } from '../contracts.js';

const STOCK_IDENTITY = /You are an AI agent powered by DeepSeek Harness\./i;
const GENERIC_IDENTITY_SENTENCE = /^(?:(?:You are|You're)\b[^.!?\n]*\b(?:AI|artificial intelligence|agent|assistant|DeepSeek|Codex|Claude|ChatGPT|GPT(?:-\w+)?|model)\b|(?:你是|你是一(?:个|名|位))[^。！？\n]*(?:助手|代理|智能体|人工智能|AI|模型)|(?:Your|The|The underlying)\s+(?:model|model name|identity)\s+is\b)/i;

/** Strip identity sentences while keeping the suffix's operational instructions. */
export function operationalSuffix(text: string): string {
  return text
    .split(/(?<=[。！？])|(?<=[.!?])(?:[ \t]+|(?=\n))|\n/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence && !GENERIC_IDENTITY_SENTENCE.test(sentence) && !STOCK_IDENTITY.test(sentence))
    .join('\n')
    .trim();
}

export function personaText(role: Pick<Role, 'name'>, speakerName: string, card: string | null): string {
  return [
    `你是${role.name}。`,
    card?.trim(),
    `现在与你交谈的是${speakerName}。`,
    '你可以通过 pupu_notes 查看目录、搜索和阅读自己的笔记，按需要写下、修改、移动或删除笔记。需要回忆时主动查找；不要将工具排队或失败说成已经保存。',
  ].filter(Boolean).join('\n\n');
}

export function assertPersonaPrompt(assembly: PromptAssembly, role: Role, speakerName: string): void {
  const rendered = renderPrompt(assembly);
  if (!rendered.startsWith(`你是${role.name}。`) || !rendered.includes(`现在与你交谈的是${speakerName}。`)) {
    throw new Error('人物身份替换被其他 complete 提示词或插件覆盖。请停用冲突提示词后重试。');
  }
  if (STOCK_IDENTITY.test(rendered)) throw new Error('最终提示词仍含 DSH 默认身份，已停止发送。');
}

/**
 * All contributions are owned by the Agent scope. The waterfall refreshes the
 * Markdown card before admission; it never changes the provider/model variables.
 */
export async function installPersona(
  agent: Agent,
  role: Role,
  speakerName: string,
  readCard: () => Promise<{ path: string; content: string | null }>,
  readRole: () => Role = () => role,
): Promise<() => void> {
  const scoped = agent.ctx;
  let current = await readCard();
  const prior = await scoped.systemPrompt.assemble({ scope: agent, agent });
  const priorPrefix = prior.sections.find(section => section.name === PERSONA_PREFIX_SECTION)?.text ?? '';
  const priorSuffix = prior.sections.find(section => section.name === PERSONA_SUFFIX_SECTION)?.text ?? '';
  const disposers: (() => void)[] = [];
  try {
    disposers.push(scoped.systemPrompt.section({
      name: 'harness:identity', order: -1000, interpolate: false,
      text: () => personaText(readRole(), speakerName, current.content),
    }));
    disposers.push(scoped.systemPrompt.section({
      name: PERSONA_PREFIX_SECTION, order: 0, text: operationalSuffix(priorPrefix),
    }));
    disposers.push(scoped.systemPrompt.section({
      name: PERSONA_SUFFIX_SECTION, order: 10200,
      text: operationalSuffix(priorSuffix),
    }));
    disposers.push(scoped.on('system-prompt/assemble', async (assembly, context, next) => {
      current = await readCard();
      const identity = assembly.sections.find(section => section.name === 'harness:identity');
      if (identity) identity.text = personaText(readRole(), speakerName, current.content);
      return next();
    }));
    const verification = await scoped.systemPrompt.assemble({ scope: agent, agent });
    assertPersonaPrompt(verification, readRole(), speakerName);
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

/** Last system node is effective for routes that support in-history updates. */
export function assertDispatchedPersona(
  messages: readonly { role: string; content: readonly { type: string; text?: string }[] }[],
  name: string,
  speakerName: string,
): void {
  const systems = messages.filter(message => message.role === 'system')
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'))
    .filter(Boolean);
  const latest = systems.at(-1);
  if (!latest?.startsWith(`你是${name}。`) || !latest.includes(`现在与你交谈的是${speakerName}。`)) {
    throw new Error('即将发送的系统消息未包含绑定人物身份；已停止请求。');
  }
  if (systems.some(system => STOCK_IDENTITY.test(system))) {
    throw new Error('即将发送的系统消息仍含 DSH 默认身份；已停止请求。');
  }
}
