import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { UiRequest } from '../contracts.js';
import { TYPERT_REMOTE } from '../remote.js';
import { Dashboard } from './Dashboard.js';
import { styles } from './styles.js';

export const inject = ['slots', 'remote', 'uiWorkspace'];

/** One native settings page, with explicit Remote ownership and scoped CSS. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(TYPERT_REMOTE);
  // Each mounted namespace is a Cordis child service. Acquire it after mount so
  // descriptor invocation resolves through an explicit dependency owner.
  await ctx.inject(['remote.pupuNotes', 'slots', 'uiWorkspace'], registerPage);
}

function registerPage(ctx: Context): void {
  const api = async (request: UiRequest): Promise<unknown> => {
    const method = TYPERT_REMOTE.methods['pupuNotes/invoke'];
    if (!method || method.mode === 'stream') throw new Error('笔记管理接口不可用。');
    const result = await method.invoke(ctx.remote, { request });
    if (!result.ok) {
      const failure = result as { error?: { message?: string }; message?: string };
      throw new Error(failure.error?.message ?? failure.message ?? '笔记操作失败，请检查宿主连接。');
    }
    return result.value;
  };
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pupu-notes';
    tag.textContent = styles;
    document.head.appendChild(tag);
    return () => { tag.remove(); };
  }, 'pupu-notes: theme styles');
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'pupu-notes', order: 80,
    label: '蒲蒲笔记',
    inject: () => ({
      api,
      openSession: (id: string) => ctx.uiWorkspace.openSession(id as SessionId),
    }),
  }, Dashboard));
}
