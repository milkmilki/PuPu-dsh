import type { Agent } from '@deepseek-ai/dsh-agent';

const changing = new WeakSet<Agent>();

/** Pending human input already belongs to its current identity, even before a turn opens. */
export function selectionState(agent: Agent): { locked: boolean; running: boolean } {
  const hasConversation = agent.session.snapshotEvents().some(event =>
    event.type === 'assistant/message' ||
    event.type === 'user/message' && event.data.source.kind === 'user');
  return {
    locked: hasConversation || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0,
    running: agent.status === 'running' || changing.has(agent),
  };
}

/**
 * Claim the official idle maintenance phase before checking or changing identity.
 * Racing input stays in DSH's inbox until the complete operation settles. The
 * caller must restore its prior scopes on failure and check signal immediately
 * before its synchronous persistent-binding commit.
 */
export async function changeBlankSession<T>(
  agent: Agent,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { sameIdentityRepair?: boolean } = {},
): Promise<T> {
  if (agent.status === 'running' || changing.has(agent)) {
    throw new Error('会话正在处理消息或修改身份，请稍后重试。');
  }
  let task: Promise<T>;
  try {
    task = agent.runMaintenance(async signal => {
      // Only the trusted Host may request repair after proving the durable
      // role and speaker are unchanged. Existing history and queued input stay
      // intact while the SDK holds admission for the restored scopes.
      if (selectionState(agent).locked && !options.sameIdentityRepair)
        throw new Error('开聊后双方身份固定，请新建会话来改变角色或说话者。');
      signal.throwIfAborted();
      changing.add(agent);
      try { return await operation(signal); }
      finally { changing.delete(agent); }
    });
  } catch (cause) {
    // Another maintenance owner also keeps public status idle. The SDK phase
    // claim is authoritative; a read of agent.status alone cannot guard it.
    throw new Error('会话正在处理消息或维护任务，请稍后重试。', { cause });
  }
  return task;
}
