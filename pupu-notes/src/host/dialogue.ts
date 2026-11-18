import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { Binding, DialogueInput, Json, Role } from '../contracts.js';

/** Only accepted, human-authored input and committed visible assistant text enter memory. */
export function dialogueFromEvent(
  event: SessionEvent,
  binding: Binding,
  role: Role,
): DialogueInput | null {
  let party: DialogueInput['party'];
  let message: { id: string; content: readonly ContentBlock[] };
  if (event.type === 'user/message') {
    if (event.data.source.kind !== 'user') return null;
    party = 'human';
    message = event.data;
  } else if (event.type === 'assistant/message') {
    party = 'assistant';
    message = event.data.message;
  } else {
    return null;
  }
  const text = message.content
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n');
  const attachments = message.content
    .filter(block => block.type === 'file' || block.type === 'image')
    .map(block => JSON.parse(JSON.stringify(block)) as Json);
  if (!text.trim() && attachments.length === 0) return null;
  return {
    sessionId: binding.sessionId,
    messageId: message.id,
    party,
    speaker: party === 'human' ? binding.speakerName : role.name,
    text,
    ...(attachments.length ? { attachments } : {}),
    at: new Date(event.time).toISOString(),
  };
}
