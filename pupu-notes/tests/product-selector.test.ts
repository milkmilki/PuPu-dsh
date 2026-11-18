import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductService, type ProductAdapter } from '../src/product.js';
import type { SessionSelection } from '../src/contracts.js';

function fixture() {
  const states = new Map<string, { locked: boolean; busy: boolean; needsRepair?: boolean }>();
  let failChange = false;
  const adapter: ProductAdapter = {
    createSession: async () => 'new-session',
    generate: async () => { throw new Error('Selection must not call a model'); },
    sessionState: async sessionId => states.get(sessionId) ?? { locked: false, busy: false },
    configureSession: async (sessionId, _binding, commit) => {
      const state = states.get(sessionId);
      if (state?.locked || state?.busy) throw new Error('会话已开始，请新建会话');
      if (failChange) throw new Error('角色卡暂时不可读');
      commit();
    },
  };
  const root = mkdtempSync(join(tmpdir(), 'notes-session-selection-'));
  const product = new ProductService(root, adapter, {
    engineFactory: async () => { throw new Error('Selection state must not access a memory library'); },
  });
  return { product, adapter, root, states, fail: (value: boolean) => { failChange = value; } };
}

test('an empty native session selects its own role and speaker, persists, and can return to ordinary assistant', async () => {
  const { product } = fixture();
  try {
    const a = product.catalog.create('仆仆', '小夫');
    const b = product.catalog.create('璐璐', '小夫');
    const initial = await product.dispatch({ action: 'sessionState', input: { sessionId: 'native-a' } }) as SessionSelection;
    assert.equal(initial.binding, null);
    assert.equal(initial.locked, false);
    assert.deepEqual(initial.speakers, ['小夫']);
    const selected = await product.dispatch({ action: 'bindSession', input: {
      sessionId: 'native-a', roleId: a.id, speakerName: '知夏姐姐',
    } }) as SessionSelection;
    assert.equal(selected.binding?.roleId, a.id);
    assert.equal(selected.binding?.speakerName, '知夏姐姐');
    assert.equal(product.binding('native-b'), undefined);
    await product.dispatch({ action: 'bindSession', input: {
      sessionId: 'native-b', roleId: b.id, speakerName: '小夫',
    } });
    await product.dispatch({ action: 'bindSession', input: {
      sessionId: 'native-a', roleId: b.id, speakerName: '另一个名字',
    } });
    assert.equal(product.binding('native-b')?.speakerName, '小夫');
    assert.equal(product.catalog.binding('native-a')?.speakerName, '另一个名字');
    const ordinary = await product.dispatch({ action: 'bindSession', input: {
      sessionId: 'native-a', roleId: null, speakerName: '',
    } }) as SessionSelection;
    assert.equal(ordinary.binding, null);
    assert.equal(product.binding('native-a'), undefined);
    assert.equal(product.binding('native-b')?.roleId, b.id);
  } finally { await product.dispose(); }
});

test('repairing the same locked identity preserves its durable binding timestamp', async () => {
  const { product, adapter, states } = fixture();
  try {
    const role = product.catalog.create('璐璐', '小夫');
    const input = { sessionId: 'repair', roleId: role.id, speakerName: '知夏姐姐' };
    await product.dispatch({ action: 'bindSession', input });
    const original = product.binding('repair')!;
    states.set('repair', { locked: true, busy: false, needsRepair: true });
    adapter.configureSession = async (sessionId, binding, commit) => {
      assert.deepEqual(binding, original);
      commit();
      states.set(sessionId, { locked: true, busy: false, needsRepair: false });
    };
    const state = await product.dispatch({ action: 'bindSession', input }) as SessionSelection;
    assert.equal(state.locked, true);
    assert.equal(state.needsRepair, false);
    assert.deepEqual(product.binding('repair'), original);
  } finally { await product.dispose(); }
});

test('started conversations reject role, speaker and ordinary-mode changes without moving history', async () => {
  const { product, states } = fixture();
  try {
    const a = product.catalog.create('仆仆', '小夫');
    const b = product.catalog.create('璐璐', '小夫');
    await product.dispatch({ action: 'bindSession', input: { sessionId: 'started', roleId: a.id, speakerName: '小夫' } });
    states.set('started', { locked: true, busy: false });
    for (const input of [
      { sessionId: 'started', roleId: b.id, speakerName: '小夫' },
      { sessionId: 'started', roleId: a.id, speakerName: '知夏姐姐' },
      { sessionId: 'started', roleId: null, speakerName: '' },
    ]) await assert.rejects(product.dispatch({ action: 'bindSession', input }), /已开始/);
    assert.equal(product.binding('started')?.roleId, a.id);
    assert.equal(product.binding('started')?.speakerName, '小夫');
    const state = await product.dispatch({ action: 'sessionState', input: { sessionId: 'started' } }) as SessionSelection;
    assert.equal(state.locked, true);
  } finally { await product.dispose(); }
});

test('failed native scope installation leaves the durable session selection unchanged', async () => {
  const { product, fail } = fixture();
  try {
    const a = product.catalog.create('仆仆', '小夫');
    const b = product.catalog.create('璐璐', '小夫');
    await product.dispatch({ action: 'bindSession', input: { sessionId: 'empty', roleId: a.id, speakerName: '小夫' } });
    fail(true);
    await assert.rejects(product.dispatch({ action: 'bindSession', input: {
      sessionId: 'empty', roleId: b.id, speakerName: '知夏姐姐',
    } }), /不可读/);
    assert.equal(product.binding('empty')?.roleId, a.id);
    assert.equal(product.binding('empty')?.speakerName, '小夫');
    await assert.rejects(product.dispatch({ action: 'bindSession', input: {
      sessionId: 'empty', roleId: 'unknown', speakerName: '小夫',
    } }), /角色不存在/);
  } finally { await product.dispose(); }
});

test('conflicting selection writes fail rather than overwrite a newer session binding', async () => {
  const { product, adapter } = fixture();
  const commits: (() => void)[] = [];
  let bothReady!: () => void;
  const ready = new Promise<void>(done => { bothReady = done; });
  adapter.configureSession = async (_sessionId, _binding, commit) => {
    await new Promise<void>((resolve, reject) => {
      commits.push(() => { try { commit(); resolve(); } catch (error) { reject(error); } });
      if (commits.length === 2) bothReady();
    });
  };
  try {
    const a = product.catalog.create('仆仆', '小夫');
    const b = product.catalog.create('璐璐', '小夫');
    const first = product.dispatch({ action: 'bindSession', input: { sessionId: 'race', roleId: a.id, speakerName: '小夫' } });
    const second = product.dispatch({ action: 'bindSession', input: { sessionId: 'race', roleId: b.id, speakerName: '知夏姐姐' } });
    const results = Promise.allSettled([first, second]);
    await ready;
    commits[0]!(); commits[1]!();
    const settled = await results;
    assert.equal(settled[0]!.status, 'fulfilled');
    assert.equal(settled[1]!.status, 'rejected');
    assert.equal(product.binding('race')?.roleId, a.id);
  } finally { await product.dispose(); }
});
