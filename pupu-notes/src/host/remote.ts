import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import '@deepseek-ai/dsh-typert-registry';
import { TYPERT_REMOTE, UiRequestSchema } from '../remote.js';
import type { Json, UiRequest } from '../contracts.js';

declare module '@deepseek-ai/cordis' {
  interface Context { pupuNotes: PupuNotesRemote }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'pupu-notes/denied': {} }
}

/** Global memory administration belongs to the authenticated installation owner. */
export class PupuNotesRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly dispatch: (request: UiRequest) => Promise<Json>) {
    super(ctx, 'pupuNotes');
    ctx.effect(() => ctx.typert.register({
      package: 'dsh-pupu-notes',
      face: 'host',
      schemas: [{ name: 'UiRequest', create: () => UiRequestSchema }],
      model: { services: [], events: [], objects: [] },
      invocations: TYPERT_REMOTE.descriptors,
    }), 'pupuNotes.remote');
  }

  @Remote
  async invoke(request: UiRequest): Promise<Json> {
    const principal = this.ctx.invocation?.peer.principal;
    if (principal !== undefined && principal.kind !== 'owner') {
      throw new RemoteError('pupu-notes/denied', '此操作需要本机记忆库的管理权限。', {});
    }
    return this.dispatch(UiRequestSchema.parse(request));
  }
}
