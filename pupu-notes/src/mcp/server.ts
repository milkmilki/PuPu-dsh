import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AdminMethod, JsonObject, OperationContext, RoleEngine } from '../contracts.js';
import { notesSchema, notesCommandSchema, NOTES_DESCRIPTION } from './schema.js';
import { modelResult } from './model-view.js';

const contextSchema = z.object({
  operationId: z.string().min(1).optional(), taskId: z.string().min(1).optional(), actor: z.string().min(1).optional(),
}).strict().optional();
const taskArgs = z.object({ taskId: z.string().min(1) }).strict();
const adminSchemas: Record<AdminMethod, z.ZodType> = {
  roleCard: z.object({}).strict(), stats: z.object({}).strict(),
  captureDialogue: z.object({ input: z.object({
    sessionId: z.string().min(1), messageId: z.string().min(1),
    party: z.enum(['human', 'assistant']), speaker: z.string().min(1), text: z.string(),
    attachments: z.array(z.json()).optional(), at: z.string().datetime({ offset: true }),
  }).strict() }).strict(),
  registerTrigger: z.object({ trigger: z.object({
    triggerId: z.string().min(1), sessionId: z.string().min(1),
    reason: z.enum(['compaction', 'manual', 'import']),
    upperBound: z.number().int().nonnegative().optional(),
  }).strict() }).strict(),
  registerDaily: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  listTasks: z.object({}).strict(), nextTask: z.object({}).strict(),
  getTask: taskArgs, retryTask: taskArgs, stopTask: taskArgs, finishTask: taskArgs, transcript: taskArgs,
  failTask: taskArgs.extend({ error: z.string() }).strict(),
  appendTranscript: taskArgs.extend({ entry: z.object({
    kind: z.enum(['request', 'response', 'tool', 'error']),
    payload: z.json(), at: z.string().datetime({ offset: true }),
  }).strict() }).strict(),
  versions: z.object({ path: z.string() }).strict(),
  undo: z.object({ versionId: z.number().int().positive(), context: contextSchema }).strict(),
};
export function createNotesServer(engine: RoleEngine, privateHost = false) {
  const server = new McpServer({ name: 'pupu-notes', version: '0.1.0' });
  const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value ?? null) }] });
  server.registerTool('notes', {
    description: NOTES_DESCRIPTION,
    inputSchema: notesSchema,
  }, async args => {
    try { return reply(modelResult(await engine.execute(args, { actor: 'standalone-model' }))); }
    catch (error) {
      const value = { error: String(error), ...(typeof error === 'object' && error && 'code' in error ? { code: String((error as { code: unknown }).code) } : {}) };
      return { ...reply(value), isError: true };
    }
  });
  if (privateHost) {
    server.registerTool('_host', {
      description: 'Private host control. Never expose to a conversation model.',
      inputSchema: z.object({
        method: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
    }, async ({ method, args = {} }) => {
      try {
        if (method === 'notes') return reply(await engine.execute(notesCommandSchema.parse(args.command), contextSchema.parse(args.context)));
        if (!(method in adminSchemas)) throw new Error(`Unknown private method: ${method}`);
        adminSchemas[method as AdminMethod].parse(args);
        return reply(await invokeAdmin(engine, method as AdminMethod, args as JsonObject));
      } catch (error) {
        const value = { error: String(error), ...(typeof error === 'object' && error && 'code' in error ? { code: String((error as { code: unknown }).code) } : {}) };
        return { ...reply(value), isError: true };
      }
    });
  }
  return server;
}

export function invokeAdmin(engine: RoleEngine, method: AdminMethod, a: JsonObject): unknown {
  switch (method) {
    case 'roleCard': return engine.roleCard();
    case 'captureDialogue': return engine.captureDialogue(a.input as unknown as Parameters<RoleEngine['captureDialogue']>[0]);
    case 'registerTrigger': return engine.registerTrigger(a.trigger as unknown as Parameters<RoleEngine['registerTrigger']>[0]);
    case 'registerDaily': return engine.registerDaily(String(a.day));
    case 'listTasks': return engine.listTasks();
    case 'nextTask': return engine.nextTask();
    case 'getTask': return engine.getTask(String(a.taskId));
    case 'retryTask': return engine.retryTask(String(a.taskId));
    case 'stopTask': return engine.stopTask(String(a.taskId));
    case 'finishTask': return engine.finishTask(String(a.taskId));
    case 'failTask': return engine.failTask(String(a.taskId), String(a.error));
    case 'transcript': return engine.transcript(String(a.taskId));
    case 'appendTranscript': return engine.appendTranscript(String(a.taskId), a.entry as unknown as Parameters<RoleEngine['appendTranscript']>[1]);
    case 'versions': return engine.versions(String(a.path));
    case 'undo': return engine.undo(Number(a.versionId), a.context as OperationContext);
    case 'stats': return engine.stats();
    default: throw new Error(`Unknown private method: ${method}`);
  }
}
