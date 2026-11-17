import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-system-prompt';
import '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-session-persistence';
import '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-compaction/types';
import { ProductService } from '../product.js';
import { notesSchema, notesToolSchema } from '../mcp/schema.js';
import { modelResult } from '../mcp/model-view.js';
import type { Binding, Json, Role } from '../contracts.js';
import { dialogueFromEvent } from './dialogue.js';
import { assertDispatchedPersona, installPersona } from './persona.js';
import { generateMemoryResponse } from './generate.js';
import { PupuNotesRemote } from './remote.js';
import { ReplayBarrier } from './replay.js';

export const name = 'pupu-notes';
export const inject = ['agents', 'sessionPersistence', 'sessionController', 'systemPrompt', 'tools', 'llm', 'typert'];
export interface Config { dataDirectory?: string }

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const dataDirectory = path.resolve(config.dataDirectory || path.join(resolveDshHome(), 'data', 'pupu-notes'));
  const chains = new Map<string, Promise<void>>();
  const installed = new Map<Agent, { dispose: () => void }>();
  const installing = new Map<Agent, Promise<void>>();
  const temporaryBindings = new Map<string, Binding>();
  let closing = false;
  let product: ProductService;

  function bindingFor(sessionId: string): Binding | undefined {
    return product.binding(sessionId) ?? temporaryBindings.get(sessionId);
  }
  function report(sessionId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    product.reportHostError(sessionId, message);
    console.error(`[pupu-notes] ${sessionId}: ${message}`);
  }
  function enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation);
    // A failed capture blocks later observations until startup replay or explicit
    // retry; silently proceeding would let a cursor skip missing source dialogue.
    chains.set(sessionId, next);
    void next.catch(error => report(sessionId, error));
    return next;
  }
  async function observe(binding: Binding, event: SessionEvent): Promise<void> {
    const role = product.role(binding.roleId);
    const engine = await product.engine(role.id);
    const dialogue = dialogueFromEvent(event, binding, role);
    if (dialogue) {
      await engine.admin('captureDialogue', { input: dialogue as unknown as { [key: string]: Json } });
    } else if (event.type === 'request/header') {
      const route = event.data.header.config;
      await product.rememberModel(role.id, { provider: route.provider, model: route.model });
    } else if (event.type === 'compaction/start') {
      const data = event.data as unknown as { compactionId: string };
      await product.notifyTrigger(role.id, {
        triggerId: `compaction:${binding.sessionId}:${data.compactionId}`,
        sessionId: binding.sessionId,
        reason: 'compaction',
      });
    }
  }
  async function attach(agent: Agent, binding: Binding): Promise<void> {
    if (installed.has(agent)) return;
    const pending = installing.get(agent);
    if (pending) return pending;
    const installation = (async () => {
      const role = product.role(binding.roleId);
      const engine = await product.engine(role.id);
      const disposePersona = await installPersona(agent, role, binding.speakerName,
        () => engine.admin<{ path: string; content: string | null }>('roleCard'),
        () => product.role(role.id));
      const disposers: (() => void)[] = [disposePersona];
      try {
        disposers.push(agent.ctx.tools.register({
          ...notesToolSchema,
          name: 'pupu_notes',
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (raw, exec) => {
            exec.signal.throwIfAborted();
            const command = notesSchema.parse(raw);
            return modelResult(await engine.notes(command, {
              operationId: `chat:${binding.sessionId}:${exec.callId}`,
              actor: `chat:${binding.sessionId}`,
            }));
          },
        }));
        disposers.push(agent.ctx.on('llm/stream', async function* (options, next) {
          if (options.sessionId === agent.id) {
            assertDispatchedPersona(options.messages, product.role(role.id).name, binding.speakerName);
          }
          yield* next();
        }));
        installed.set(agent, { dispose: () => { for (const dispose of disposers.reverse()) dispose(); } });
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose();
        throw error;
      }
    })();
    installing.set(agent, installation);
    try { await installation; } finally { installing.delete(agent); }
  }

  product = new ProductService(dataDirectory, {
    flushSession: async sessionId => { await chains.get(sessionId); },
    generate: request => generateMemoryResponse(options => ctx.llm.stream(options), request),
    createSession: async request => {
      const sessionId = SessionId(randomUUID());
      const created = await ctx.sessionController.create({
        sessionId,
        ...(request.workspaceId ? { workspaceId: request.workspaceId as never } : { cwd: request.cwd ?? process.cwd() }),
      });
      const binding: Binding = {
        sessionId: created.sessionId,
        roleId: request.roleId,
        speakerName: request.speakerName,
        createdAt: new Date().toISOString(),
      };
      temporaryBindings.set(created.sessionId, binding);
      const agent = ctx.agents.get(created.sessionId);
      if (!agent) throw new Error('DSH 未发布新建会话的 Agent。');
      await attach(agent, binding);
      if (request.model) {
        await ctx.sessionController.selectModel({ sessionId: created.sessionId, ...request.model });
        await product.rememberModel(request.roleId, request.model);
      } else {
        const catalog = await ctx.sessionController.modelCatalog();
        await product.rememberModel(request.roleId, catalog.default);
      }
      await ctx.sessionController.rename({ sessionId: created.sessionId, title: `${request.name} · ${request.speakerName}` });
      return created.sessionId;
    },
  });
  ctx.effect(() => async () => {
    closing = true;
    for (const item of installed.values()) item.dispose();
    installed.clear();
    await Promise.allSettled([...installing.values(), ...chains.values()]);
    await product.dispose();
  });
  new PupuNotesRemote(ctx, async request => {
    const value = await product.dispatch(request);
    return JSON.parse(JSON.stringify(value)) as Json;
  });

  const startupBindings = product.bindings();
  const replayBarrier = new ReplayBarrier<SessionEvent>(startupBindings.map(binding => binding.sessionId));
  // Subscribe before reading replay so every racing event is captured. Stable
  // message and trigger identities make the overlapping prefix idempotent.
  ctx.on('session/event', (session, event) => {
    if (closing) return;
    const binding = bindingFor(session.id);
    if (!binding) return;
    if (replayBarrier.buffer(session.id, event)) return;
    void enqueue(session.id, () => observe(binding, event));
  });
  ctx.on('agent/created', async ({ agent }) => {
    const binding = bindingFor(agent.id);
    if (!binding) return;
    try { await attach(agent, binding); } catch (error) {
      report(agent.id, error);
      throw error;
    }
  });
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.dispose();
    installed.delete(agent);
  });

  // Reserve every chain synchronously before awaiting the first cold read.
  // Otherwise a later session's live tail could overtake its old compaction.
  const startupReplay = startupBindings.map(binding =>
    enqueue(binding.sessionId, async () => {
      const inspection = await ctx.sessionController.inspect(SessionId(binding.sessionId));
      for (const event of inspection.events) await observe(binding, event);
      const lastSeq = inspection.events.at(-1)?.seq ?? -1;
      // Events in the inspected prefix were already applied in original order.
      // Keep only the live suffix, preserving the order Session accepted it.
      const suffix = replayBarrier.release(binding.sessionId).filter(event => event.seq > lastSeq);
      for (const event of suffix) await observe(binding, event);
    }).catch(() => {})
  );
  await Promise.all(startupReplay);
  for (const agent of ctx.agents.list()) {
    const binding = bindingFor(agent.id);
    if (binding) await attach(agent, binding).catch(error => report(agent.id, error));
  }
  await product.initialize();
}
