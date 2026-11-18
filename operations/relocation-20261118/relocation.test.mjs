import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSdk, createPlan, applyPlan, rollbackPlan, verifyPlan, rewriteSession, sha256,
} from './relocate-workspaces.mjs';

async function fixture() {
  const sdk = await loadSdk();
  const root = mkdtempSync(join(tmpdir(), 'pupu-relocation-synthetic-'));
  const home = join(root, 'home'), destinationRoot = join(root, 'destination');
  mkdirSync(join(home, 'storages'), { recursive: true });
  const mappings = ['pupu', 'lulu', 'web'].map((name, index) => ({
    from: join(root, 'source', name),
    to: join(destinationRoot, 'workspaces', name === 'web' ? 'web' : `qq/${name}`),
    id: `workspace-${index}`,
  }));
  const registry = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: mappings.map(w => w.id), archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  };
  const originalFiles = [];
  for (const [index, mapping] of mappings.entries()) {
    mkdirSync(mapping.from, { recursive: true });
    writeFileSync(join(mapping.from, 'synthetic.txt'), `synthetic-workspace-${index}`);
    const ids = index === 2 ? ['session-web-a', 'session-web-b', 'session-web-c'] : [`session-qq-${index}`];
    registry.tables.workspaces[mapping.id] = {
      path: mapping.from, title: mapping.id, sessionIds: ids,
      createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:01.000Z',
    };
    for (const id of ids) {
      const header = sdk.toHeaderLine({
        id, version: 4, createdAt: 1000 + index, cwd: mapping.from,
        isSeeded: false, delegationDepth: 0, agentPreset: 'synthetic-preset',
      }, 0);
      const events = [0, 1].map(seq => ({
        type: 'session/title', seq, time: 2000 + seq,
        data: { title: `synthetic-${seq}`, messageSeqs: [], source: { kind: 'user' } },
      }));
      const bytes = Buffer.concat([
        await sdk.compressZstdFrame(JSON.stringify(header) + '\n'),
        await sdk.compressZstdFrame(sdk.eventLines(events) + '\n'),
      ]);
      const path = sdk.generationLogPath(join(home, 'sessions'), mapping.from, id, 4, 'zstd');
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, bytes);
      originalFiles.push({ path, id, bytes });
    }
  }
  writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify(registry, null, 2) + '\n');
  const config = {
    home, destinationRoot, operationRoot: join(root, 'operations'),
    mappings: mappings.map(({ from, to }) => ({ from, to })), synthetic: true,
  };
  return { root, sdk, config, mappings, registry, originalFiles,
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test('dry-run and apply preserve five session identities and event bytes, with reversible registry moves', async () => {
  const f = await fixture();
  try {
    const plan = await createPlan(f.config);
    assert.equal(plan.sessions.length, 5);
    assert.equal(plan.workspaces.length, 3);
    assert(!existsSync(plan.backupRoot), 'planning must not create live backups');
    for (const file of f.originalFiles) assert.deepEqual(readFileSync(file.path), file.bytes);
    for (const mapping of f.mappings) assert(!existsSync(mapping.to));
    await assert.rejects(applyPlan(plan), /offline/i);
    const journal = await applyPlan(plan, { offlineConfirmed: true });
    assert.equal(journal.phase, 'completed');
    const verified = await verifyPlan(plan);
    assert.equal(verified.sessions, 5);
    const updated = JSON.parse(readFileSync(join(f.config.home, 'storages', 'workspace.json'), 'utf8'));
    assert.deepEqual(updated.global, f.registry.global);
    assert.deepEqual(Object.keys(updated.tables.workspaces), Object.keys(f.registry.tables.workspaces));
    for (const workspace of plan.workspaces) {
      const before = f.registry.tables.workspaces[workspace.id];
      assert.deepEqual(updated.tables.workspaces[workspace.id], { ...before, path: workspace.to });
    }
    for (const session of plan.sessions) {
      const rewritten = await rewriteSession(f.sdk, readFileSync(session.target), session.to, session.id);
      assert.equal(rewritten.identity.id, session.id);
      assert.equal(rewritten.bodySha256, session.bodySha256);
      assert.equal(rewritten.eventCount, 2);
      const original = f.originalFiles.find(file => file.id === session.id);
      const a = f.sdk.scanZstdFrames(original.bytes).frames[0].end;
      const moved = readFileSync(session.target), b = f.sdk.scanZstdFrames(moved).frames[0].end;
      assert.deepEqual(moved.subarray(b), original.bytes.subarray(a));
    }
    await rollbackPlan(plan, { offlineConfirmed: true });
    assert.deepEqual(JSON.parse(readFileSync(join(f.config.home, 'storages', 'workspace.json'), 'utf8')), f.registry);
    for (const file of f.originalFiles) assert.deepEqual(readFileSync(file.path), file.bytes);
    for (const mapping of f.mappings) {
      assert(existsSync(mapping.from));
      assert(!existsSync(mapping.to));
    }
  } finally { f.close(); }
});

test('a source changed after dry-run is refused before mutation', async () => {
  const f = await fixture();
  try {
    const plan = await createPlan(f.config);
    writeFileSync(join(f.mappings[0].from, 'late.txt'), 'synthetic late change');
    await assert.rejects(applyPlan(plan, { offlineConfirmed: true }), /changed|变化/i);
    for (const file of f.originalFiles) assert.equal(sha256(readFileSync(file.path)), sha256(file.bytes));
    assert(!existsSync(plan.backupRoot));
  } finally { f.close(); }
});

test('unknown session directories and destination collisions fail preflight', async () => {
  const f = await fixture();
  try {
    const extra = join(f.sdk.projectDir(join(f.config.home, 'sessions'), f.mappings[0].from), 'unaccounted-child');
    mkdirSync(extra);
    await assert.rejects(createPlan(f.config), /unaccounted|未登记/i);
    rmdirSync(extra);
    mkdirSync(f.mappings[0].to, { recursive: true });
    await assert.rejects(createPlan(f.config), /destination|目标/i);
  } finally { f.close(); }
});

test('a staged multi-file interruption rolls back without touching event content', async () => {
  const f = await fixture();
  try {
    const plan = await createPlan(f.config);
    await assert.rejects(applyPlan(plan, { offlineConfirmed: true, failAfterActions: 3 }), /synthetic interruption/i);
    await rollbackPlan(plan, { offlineConfirmed: true });
    for (const file of f.originalFiles) assert.deepEqual(readFileSync(file.path), file.bytes);
    assert.deepEqual(JSON.parse(readFileSync(join(f.config.home, 'storages', 'workspace.json'), 'utf8')), f.registry);
  } finally { f.close(); }
});

test('a torn compressed source is refused without silently repairing history', async () => {
  const f = await fixture();
  try {
    const file = f.originalFiles[0];
    writeFileSync(file.path, file.bytes.subarray(0, file.bytes.length - 2));
    await assert.rejects(createPlan(f.config), /torn|完整|corrupt/i);
  } finally { f.close(); }
});
