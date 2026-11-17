import {
  BlockAssembler,
  createAssistantMessage,
  type AssistantMessage,
  type GenerateOptions,
  type Message,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm';
import type { Json, ModelRoute } from '../contracts.js';

export interface GenerateRequest {
  route: ModelRoute;
  messages: Message[];
  tools: ToolSchema[];
  signal: AbortSignal;
}
export interface GenerateResult {
  message: AssistantMessage;
  finish: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error';
  usage?: Json;
  error?: string;
}

/** A standalone, invisible model call through DSH's configured provider routing. */
export async function generateMemoryResponse(
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  request: GenerateRequest,
): Promise<GenerateResult> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]);
  signal.throwIfAborted();
  const assembler = new BlockAssembler();
  let terminal = false;
  for await (const chunk of stream({
    provider: request.route.provider,
    model: request.route.model,
    messages: request.messages,
    tools: request.tools,
    signal,
  })) {
    signal.throwIfAborted();
    if (terminal) throw new Error('记忆模型在结束标记之后继续返回内容。');
    assembler.push(chunk);
    if (chunk.type === 'finish') terminal = true;
  }
  signal.throwIfAborted();
  if (!terminal) throw new Error('记忆模型输出中断，缺少结束标记；未执行本次工具。');
  const reason = assembler.finish;
  const kind = reason.kind;
  const finish = kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens' || kind === 'aborted'
    ? kind
    : 'error';
  const content = finish === 'stop' || finish === 'tool-calls'
    ? assembler.blocks()
    : assembler.interruptedBlocks();
  const message = createAssistantMessage({
    content,
    source: {
      provider: request.route.provider,
      model: request.route.model,
      ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }),
    },
  });
  return {
    message,
    finish,
    ...(assembler.usage === undefined ? {} : { usage: JSON.parse(JSON.stringify(assembler.usage)) as Json }),
    ...('failure' in reason ? { error: reason.failure.message } : {}),
  };
}
