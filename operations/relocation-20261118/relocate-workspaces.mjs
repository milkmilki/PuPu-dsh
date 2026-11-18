import assert from 'node:assert/strict';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { loadSdk, rewriteSession, sha256 } from './sdk-tools.mjs';
export { loadSdk, rewriteSession, sha256 };

const operationRoot = dirname(fileURLToPath(import.meta.url));
const destinationRoot = resolve(operationRoot, '..', '..');
const normalize = path => resolve(path).toLowerCase();
const same = (a, b) => normalize(a) === normalize(b);
const json = value => JSON.stringify(value, null, 2) + '\n';
const fileHash = path => sha256(readFileSync(path));
function within(root, path) {
  const part = relative(resolve(root), resolve(path));
  assert(part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part), 'Path escaped the declared root');
}
function noLinks(path) {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) assert(!lstatSync(current).isSymbolicLink(), `Linked path refused: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function inventory(root) {
  noLinks(root);
  assert(lstatSync(root).isDirectory(), 'Expected a plain directory');
  const rows = [];
  function walk(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name), path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      assert(!stat.isSymbolicLink(), `Linked entry refused: ${path}`);
      if (stat.isDirectory()) { rows.push({ path, directory: true }); walk(absolute, path); }
      else {
        assert(stat.isFile(), 'Special files cannot be relocated');
        rows.push({ path, bytes: stat.size, sha256: fileHash(absolute) });
      }
    }
  }
  walk(root, '');
  return rows;
}
const treeHash = path => sha256(JSON.stringify(inventory(path)));
function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx');
  try { writeFileSync(fd, json(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function metadataWitness(config, sessionIds) {
  const witness = {}, idSet = new Set(sessionIds);
  const notesPath = join(config.home, 'data', 'pupu-notes', 'catalog.sqlite');
  if (existsSync(notesPath)) {
    const db = new DatabaseSync(notesPath, { readOnly: true });
    try {
      const bindings = db.prepare('SELECT session_id,data FROM bindings ORDER BY session_id').all()
        .filter(row => idSet.has(row.session_id));
      witness.notesBindingsSha256 = sha256(JSON.stringify(bindings));
      const roleIds = new Set(bindings.map(row => JSON.parse(row.data).roleId));
      const roles = db.prepare('SELECT id,data FROM roles ORDER BY id').all().filter(row => roleIds.has(row.id));
      witness.notesRolesSha256 = sha256(JSON.stringify(roles));
      witness.personas = roles.map(row => {
        const role = JSON.parse(row.data);
        const path = join(config.home, 'data', 'pupu-notes', 'roles', role.id, 'notes', role.roleCardPath);
        within(join(config.home, 'data', 'pupu-notes', 'roles', role.id), path);
        return { roleId: role.id, sha256: fileHash(path) };
      });
    } finally { db.close(); }
  }
  const bridgePath = join(config.home, 'data', 'dsh-qq', 'bridge.db');
  if (existsSync(bridgePath)) {
    const db = new DatabaseSync(bridgePath, { readOnly: true });
    try {
      const routes = db.prepare('SELECT session,value FROM routes ORDER BY session').all()
        .filter(row => idSet.has(row.session));
      witness.qqRoutesSha256 = sha256(JSON.stringify(routes));
      const configRow = db.prepare("SELECT value FROM settings WHERE key='config'").get();
      witness.qqConfigSha256 = sha256(configRow?.value ?? '');
    } finally { db.close(); }
  }
  return witness;
}
function duplicateIds(config, sessions) {
  const root = join(config.home, 'sessions'), counts = new Map(sessions.map(s => [s.id, 0]));
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    noLinks(projectPath);
    for (const session of sessions)
      if (existsSync(join(projectPath, session.encodedId))) counts.set(session.id, counts.get(session.id) + 1);
  }
  for (const [id, count] of counts) assert.equal(count, 1, `Session storage is ambiguous: ${id}`);
}
export function liveConfig() {
  return {
    home: 'C:/Users/57859/.dsh', destinationRoot, operationRoot,
    mappings: [
      { from: 'C:/Users/57859/Projects/pupu-qq-workspaces/pupu', to: join(destinationRoot, 'workspaces', 'qq', 'pupu') },
      { from: 'C:/Users/57859/Projects/pupu-qq-workspaces/lulu', to: join(destinationRoot, 'workspaces', 'qq', 'lulu') },
      { from: 'C:/Users/57859/Projects/pupu-notes-chat', to: join(destinationRoot, 'workspaces', 'web') },
    ],
  };
}
export async function createPlan(config = liveConfig()) {
  const sdk = await loadSdk(config.sdkManifest);
  const registryPath = join(config.home, 'storages', 'workspace.json');
  noLinks(registryPath);
  const beforeText = readFileSync(registryPath, 'utf8'), registry = JSON.parse(beforeText);
  assert.deepEqual(registry.unit, { name: 'workspace', version: 2 });
  assert(!registry.global.pendingMutation, 'Finish pending registry mutations first');
  const workspaces = [], sessions = [], paths = new Set();
  for (const mapping of config.mappings) {
    const from = resolve(mapping.from), to = resolve(mapping.to);
    within(config.destinationRoot, to); noLinks(from); noLinks(to);
    assert(!existsSync(to), `Workspace destination already exists: ${to}`);
    const matching = Object.entries(registry.tables.workspaces).filter(([, record]) => same(record.path, from));
    assert.equal(matching.length, 1, 'Source workspace must have exactly one existing registry identity');
    const [id, record] = matching[0];
    assert(!Object.entries(registry.tables.workspaces).some(([otherId, other]) => otherId !== id && same(other.path, to)),
      'Destination workspace path is already registered');
    assert(!paths.has(normalize(to)), 'Repeated destination'); paths.add(normalize(to));
    const sourceProject = sdk.projectDir(join(config.home, 'sessions'), record.path);
    const expectedIds = new Set(record.sessionIds.map(sdk.encodeSegment));
    assert(existsSync(sourceProject), 'Source session project directory missing');
    const entries = readdirSync(sourceProject, { withFileTypes: true });
    assert(entries.every(entry => entry.isDirectory() && expectedIds.has(entry.name)),
      'Unaccounted session directory or artifact in source project; review before migration');
    workspaces.push({ id, from: record.path, to, treeSha256: treeHash(from), sourceProject });
    for (const sessionId of record.sessionIds) {
      const source = sdk.generationLogPath(join(config.home, 'sessions'), record.path, sessionId, 4, 'zstd');
      const sourceDirectory = dirname(source);
      assert.deepEqual(readdirSync(sourceDirectory).sort(), ['session.v4.jsonl.zstd'],
        'Unexpected session generations, leases or local artifacts; refuse partial relocation');
      noLinks(source);
      const bytes = readFileSync(source);
      const rewritten = await rewriteSession(sdk, bytes, to, sessionId);
      assert(same(rewritten.oldIdentity.cwd, record.path), 'Session header does not match its workspace');
      const target = sdk.generationLogPath(join(config.home, 'sessions'), to, sessionId, 4, 'zstd');
      assert(!existsSync(dirname(target)), 'Session destination already exists');
      sessions.push({
        id: sessionId, encodedId: sdk.encodeSegment(sessionId), workspaceId: id, from: record.path, to,
        source, target, beforeSha256: sha256(bytes), afterSha256: sha256(rewritten.bytes),
        bodySha256: rewritten.bodySha256, eventCount: rewritten.eventCount, eventsSha256: rewritten.eventsSha256,
      });
    }
    registry.tables.workspaces[id] = { ...record, path: to };
  }
  duplicateIds(config, sessions);
  const id = `relocation-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const plan = {
    format: 'pupu-workspace-relocation', version: 1, id, createdAt: new Date().toISOString(),
    config, sdk: sdk.provenance, workspaces, sessions,
    registry: { path: registryPath, beforeText, afterText: json(registry),
      beforeSha256: sha256(beforeText), afterSha256: sha256(json(registry)) },
    metadata: metadataWitness(config, sessions.map(s => s.id)),
    backupRoot: join(config.home, 'backups', id),
    stageRoot: join(config.home, `.pupu-${id}`),
    workspaceStageRoot: join(config.operationRoot, '.staging', id),
    journalPath: join(config.operationRoot, `${id}.journal.json`),
  };
  plan.planSha256 = sha256(JSON.stringify(plan));
  return plan;
}
async function validatePlan(plan) {
  const { planSha256, ...body } = plan;
  assert.equal(sha256(JSON.stringify(body)), planSha256, 'Plan changed since dry-run');
  const sdk = await loadSdk(plan.config.sdkManifest);
  assert.deepEqual(sdk.provenance, plan.sdk, 'Installed SDK changed since dry-run');
  assert.equal(plan.format, 'pupu-workspace-relocation');
  for (const session of plan.sessions) {
    assert.equal(resolve(session.source), resolve(sdk.generationLogPath(join(plan.config.home, 'sessions'), session.from, session.id, 4, 'zstd')));
    assert.equal(resolve(session.target), resolve(sdk.generationLogPath(join(plan.config.home, 'sessions'), session.to, session.id, 4, 'zstd')));
    within(plan.config.destinationRoot, session.to);
  }
  return sdk;
}
function assertOffline(plan, options) {
  assert(options?.offlineConfirmed === true, 'Apply/rollback requires --offline-confirmed after stopping DSH');
  if (plan.config.synthetic) {
    assert(!same(plan.config.home, 'C:/Users/57859/.dsh'), 'Synthetic mode cannot bypass live offline checks');
    return;
  }
  const lock = join(plan.config.home, 'data', 'dsh-qq', 'bridge.lock');
  if (existsSync(lock)) {
    const owner = JSON.parse(readFileSync(lock, 'utf8'));
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    assert(!alive, 'The QQ bridge writer is still running');
  }
  if (process.platform === 'win32') {
    const command = String.raw`@((Get-CimInstance Win32_Process -Filter "Name='node.exe'") | Where-Object { $_.CommandLine -match '(?i)@deepseek-ai[\\/]+dsh[\\/]' -and $_.CommandLine -match '(?i)(?:^|\s)(?:web|desktop)(?:\s|$)' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
    assert(!output || output === '[]', 'A DSH web/desktop process is still running');
  }
}
function unchangedMetadata(plan) {
  assert.deepEqual(metadataWitness(plan.config, plan.sessions.map(s => s.id)), plan.metadata,
    'Identity, QQ route or persona metadata changed');
}
export async function verifyPlan(plan) {
  const sdk = await validatePlan(plan);
  assert.equal(fileHash(plan.registry.path), plan.registry.afterSha256, 'Registry target mismatch');
  for (const workspace of plan.workspaces) {
    assert(!existsSync(workspace.from), 'Old workspace remains active');
    assert.equal(treeHash(workspace.to), workspace.treeSha256, 'Workspace content changed');
  }
  for (const session of plan.sessions) {
    assert(!existsSync(dirname(session.source)), 'Old session is still discoverable');
    assert.equal(fileHash(session.target), session.afterSha256, 'Relocated session changed');
    const checked = await rewriteSession(sdk, readFileSync(session.target), session.to, session.id);
    assert.equal(checked.bodySha256, session.bodySha256);
    assert.equal(checked.eventsSha256, session.eventsSha256);
    assert.equal(checked.eventCount, session.eventCount);
  }
  duplicateIds(plan.config, plan.sessions);
  unchangedMetadata(plan);
  return { workspaces: plan.workspaces.length, sessions: plan.sessions.length,
    events: plan.sessions.reduce((sum, s) => sum + s.eventCount, 0), eventBytesUnchanged: true,
    identityMetadataUnchanged: true, sdk: plan.sdk.version };
}
function writeJournal(plan, journal) { atomicJson(plan.journalPath, journal); }
export async function applyPlan(plan, options = {}) {
  const sdk = await validatePlan(plan);
  assertOffline(plan, options);
  assert(!existsSync(plan.journalPath), 'A journal already exists; verify or roll it back before applying again');
  assert.equal(fileHash(plan.registry.path), plan.registry.beforeSha256, 'Registry changed since dry-run');
  unchangedMetadata(plan);
  for (const workspace of plan.workspaces) {
    assert.equal(treeHash(workspace.from), workspace.treeSha256, 'Workspace source changed since dry-run');
    assert(!existsSync(workspace.to), 'Workspace destination appeared after dry-run');
  }
  for (const session of plan.sessions) {
    assert.equal(fileHash(session.source), session.beforeSha256, 'Session source changed since dry-run');
    assert(!existsSync(dirname(session.target)), 'Session destination appeared after dry-run');
    assert.deepEqual(readdirSync(dirname(session.source)).sort(), ['session.v4.jsonl.zstd']);
  }
  duplicateIds(plan.config, plan.sessions);
  for (const workspace of plan.workspaces) {
    const expected = plan.sessions.filter(s => s.workspaceId === workspace.id).map(s => s.encodedId).sort();
    assert.deepEqual(readdirSync(workspace.sourceProject).sort(), expected, 'Unaccounted session appeared after dry-run');
  }
  for (const path of [plan.backupRoot, plan.stageRoot, plan.workspaceStageRoot]) {
    noLinks(path); assert(!existsSync(path), 'Staging or backup directory already exists');
    mkdirSync(path, { recursive: true });
  }
  copyFileSync(plan.registry.path, join(plan.backupRoot, 'workspace.original.json'));
  const actions = [];
  for (const session of plan.sessions) {
    const staged = join(plan.stageRoot, 'sessions', session.encodedId);
    mkdirSync(staged, { recursive: true });
    const rewritten = await rewriteSession(sdk, readFileSync(session.source), session.to, session.id);
    assert.equal(sha256(rewritten.bytes), session.afterSha256);
    writeFileSync(join(staged, 'session.v4.jsonl.zstd'), rewritten.bytes, { flag: 'wx' });
    const backup = join(plan.backupRoot, 'original-session-dirs', session.encodedId);
    actions.push({ kind: 'move', from: dirname(session.source), to: backup, treeSha256: treeHash(dirname(session.source)) });
    actions.push({ kind: 'move', from: staged, to: dirname(session.target), treeSha256: treeHash(staged) });
  }
  for (const [index, workspace] of plan.workspaces.entries()) {
    const staged = join(plan.workspaceStageRoot, String(index));
    cpSync(workspace.from, staged, { recursive: true, errorOnExist: true, force: false });
    assert.equal(treeHash(staged), workspace.treeSha256);
    actions.push({ kind: 'move', from: staged, to: workspace.to, treeSha256: workspace.treeSha256 });
    actions.push({ kind: 'move', from: workspace.from, to: join(plan.backupRoot, 'original-workspaces', String(index)),
      treeSha256: workspace.treeSha256 });
  }
  actions.push({ kind: 'registry', path: plan.registry.path });
  const journal = { format: 'pupu-relocation-journal', version: 1, planSha256: plan.planSha256,
    phase: 'prepared', actions, next: 0 };
  writeJournal(plan, journal);
  for (const [index, action] of actions.entries()) {
    journal.phase = 'applying'; journal.next = index; writeJournal(plan, journal);
    if (action.kind === 'move') {
      noLinks(action.from); noLinks(action.to);
      assert(!existsSync(action.to), 'Move destination collision');
      assert.equal(treeHash(action.from), action.treeSha256, 'Move source changed');
      mkdirSync(dirname(action.to), { recursive: true });
      renameSync(action.from, action.to);
    } else atomicJson(plan.registry.path, JSON.parse(plan.registry.afterText));
    action.done = true; journal.next = index + 1; writeJournal(plan, journal);
    if (options.failAfterActions === index + 1) throw new Error('synthetic interruption');
  }
  journal.verification = await verifyPlan(plan);
  journal.phase = 'completed'; writeJournal(plan, journal);
  return journal;
}
export async function rollbackPlan(plan, options = {}) {
  await validatePlan(plan); assertOffline(plan, options);
  const journal = JSON.parse(readFileSync(plan.journalPath, 'utf8'));
  assert.equal(journal.planSha256, plan.planSha256, 'Journal belongs to another plan');
  unchangedMetadata(plan);
  // Validate all existing outputs before the first reversal; refuse new user work.
  for (const action of journal.actions) if (action.kind === 'move' && existsSync(action.to))
    assert.equal(treeHash(action.to), action.treeSha256, 'Relocated content changed; automatic rollback refused');
  for (const action of [...journal.actions].reverse()) {
    if (action.kind === 'registry') {
      const current = fileHash(plan.registry.path);
      assert([plan.registry.beforeSha256, plan.registry.afterSha256].includes(current), 'Registry has external changes');
      if (current === plan.registry.afterSha256) {
        const bytes = readFileSync(join(plan.backupRoot, 'workspace.original.json'));
        assert.equal(sha256(bytes), plan.registry.beforeSha256);
        const temp = `${plan.registry.path}.${randomUUID()}.tmp`;
        writeFileSync(temp, bytes, { flag: 'wx' }); renameSync(temp, plan.registry.path);
      }
    } else if (existsSync(action.to)) {
      assert(!existsSync(action.from), 'Rollback source collision');
      mkdirSync(dirname(action.from), { recursive: true }); renameSync(action.to, action.from);
    }
    action.done = false; writeJournal(plan, journal);
  }
  for (const session of plan.sessions) assert.equal(fileHash(session.source), session.beforeSha256);
  assert.equal(fileHash(plan.registry.path), plan.registry.beforeSha256);
  duplicateIds(plan.config, plan.sessions); unchangedMetadata(plan);
  journal.phase = 'rolled-back'; writeJournal(plan, journal);
  return { rolledBack: true, sessions: plan.sessions.length };
}
async function main() {
  const [mode = 'dry-run', path, ...flags] = process.argv.slice(2);
  if (mode === 'dry-run') {
    const plan = await createPlan();
    const output = resolve(path || join(operationRoot, 'workspace-relocation.plan.json'));
    assert(!existsSync(output), 'Plan already exists; choose a new output path');
    writeFileSync(output, json(plan), { flag: 'wx' });
    console.log(json({ dryRun: true, plan: output, planSha256: plan.planSha256,
      workspaces: plan.workspaces.map(w => ({ id: w.id, from: w.from, to: w.to })),
      sessions: plan.sessions.length, events: plan.sessions.reduce((sum, s) => sum + s.eventCount, 0),
      sdk: plan.sdk, backupRoot: plan.backupRoot, journalPath: plan.journalPath }));
    return;
  }
  assert(path && ['apply', 'verify', 'rollback'].includes(mode), 'Use dry-run [plan], apply|verify|rollback <plan>');
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const options = { offlineConfirmed: flags.includes('--offline-confirmed') };
  const result = mode === 'apply' ? await applyPlan(plan, options)
    : mode === 'rollback' ? await rollbackPlan(plan, options) : await verifyPlan(plan);
  console.log(json(mode === 'apply' ? { applied: true, journalPath: plan.journalPath, verification: result.verification } : result));
}
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url)))
  main().catch(error => { console.error(`Relocation refused: ${error.message}`); process.exitCode = 1; });
