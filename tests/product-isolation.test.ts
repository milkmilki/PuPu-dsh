import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductService } from '../src/product.js';
import { NotesEngine } from '../src/engine/index.js';
import { invokeAdmin } from '../src/mcp/server.js';
import type { EngineClient, JsonObject, Role } from '../src/contracts.js';

test('a failed source flush leaves initialization and other roles daily work available for recovery', async () => {
  const engines = new Map<string, NotesEngine>();
  let sourceFailed = true;
  let sequence = 0;
  const product = new ProductService(mkdtempSync(join(tmpdir(), 'notes-daily-isolation-')), {
    createSession: async () => `daily-session-${++sequence}`,
    generate: async () => { throw new Error('No configured model may be called in this recovery test'); },
    flushSession: async sessionId => {
      if (sessionId === 'daily-session-1' && sourceFailed) throw new Error('A dialogue capture needs replay');
    },
  }, {
    engineFactory: async (role, root) => {
      let engine = engines.get(role.id);
      if (!engine) {
        engine = new NotesEngine(root, { roleName: role.name });
        engines.set(role.id, engine);
      }
      const current = engine;
      return {
        notes: (command, context) => current.execute(command, context),
        admin: async <T>(method: Parameters<EngineClient['admin']>[0], args: JsonObject = {}) =>
          await invokeAdmin(current, method, args) as T,
        close: async () => {},
      };
    },
  });
  try {
    const a = await product.dispatch({ action: 'createRole', input: { name: 'Role A', speakerName: 'Speaker' } }) as Role;
    const b = await product.dispatch({ action: 'createRole', input: { name: 'Role B', speakerName: 'Speaker' } }) as Role;
    await product.dispatch({ action: 'createSession', roleId: a.id });
    await product.dispatch({ action: 'createSession', roleId: b.id });
    const originalTick = product.tick.bind(product);
    product.tick = () => originalTick(new Date(2026, 10, 18, 3, 1));
    await product.initialize();
    const engineA = await product.engine(a.id);
    const engineB = await product.engine(b.id);
    assert.equal((await engineA.admin<unknown[]>('listTasks')).length, 0);
    assert.equal((await engineB.admin<unknown[]>('listTasks')).length, 1);
    const state = await product.dispatch({ action: 'state', roleId: b.id }) as { error?: string };
    assert.match(state.error ?? '', /Role A/);
    assert.match(state.error ?? '', /capture needs replay/);
    sourceFailed = false;
    await product.tick();
    assert.equal((await engineA.admin<unknown[]>('listTasks')).length, 1);
    assert.equal((await engineB.admin<unknown[]>('listTasks')).length, 1);
  } finally {
    await product.dispose();
    for (const engine of engines.values()) engine.close();
  }
});

test('daily registration errors remain visible until a successful retry without blocking another role', async () => {
  const engines = new Map<string, NotesEngine>();
  let registrationFailed = true;
  const product = new ProductService(mkdtempSync(join(tmpdir(), 'notes-daily-register-retry-')), {
    createSession: async () => 'unused',
    generate: async () => { throw new Error('No configured model may be called in this recovery test'); },
  }, {
    engineFactory: async (role, root) => {
      let engine = engines.get(role.id);
      if (!engine) {
        engine = new NotesEngine(root, { roleName: role.name });
        engines.set(role.id, engine);
      }
      const current = engine;
      return {
        notes: (command, context) => current.execute(command, context),
        admin: async <T>(method: Parameters<EngineClient['admin']>[0], args: JsonObject = {}) => {
          if (method === 'registerDaily' && role.name === 'Role A' && registrationFailed)
            throw new Error('Daily storage temporarily unavailable');
          return await invokeAdmin(current, method, args) as T;
        },
        close: async () => {},
      };
    },
  });
  try {
    const a = await product.dispatch({ action: 'createRole', input: { name: 'Role A', speakerName: 'Speaker' } }) as Role;
    const b = await product.dispatch({ action: 'createRole', input: { name: 'Role B', speakerName: 'Speaker' } }) as Role;
    const originalTick = product.tick.bind(product);
    product.tick = () => originalTick(new Date(2026, 10, 18, 3, 1));
    await product.initialize();
    const engineA = await product.engine(a.id);
    const engineB = await product.engine(b.id);
    assert.equal((await engineA.admin<unknown[]>('listTasks')).length, 0);
    assert.equal((await engineB.admin<unknown[]>('listTasks')).length, 1);
    let state = await product.dispatch({ action: 'state', roleId: b.id }) as { error?: string };
    assert.match(state.error ?? '', /Role A/);
    assert.match(state.error ?? '', /Daily storage temporarily unavailable/);
    const failedRetry = await product.dispatch({ action: 'retry', input: { capture: true } }) as { pendingErrors: number };
    assert.equal(failedRetry.pendingErrors, 1);
    state = await product.dispatch({ action: 'state', roleId: b.id }) as { error?: string };
    assert.match(state.error ?? '', /Daily storage temporarily unavailable/);
    registrationFailed = false;
    const recoveredRetry = await product.dispatch({ action: 'retry', input: { capture: true } }) as { pendingErrors: number };
    assert.equal(recoveredRetry.pendingErrors, 0);
    state = await product.dispatch({ action: 'state', roleId: b.id }) as { error?: string };
    assert.equal(state.error, undefined);
    assert.equal((await engineA.admin<unknown[]>('listTasks')).length, 1);
    assert.equal((await engineB.admin<unknown[]>('listTasks')).length, 1);
  } finally {
    await product.dispose();
    for (const engine of engines.values()) engine.close();
  }
});
