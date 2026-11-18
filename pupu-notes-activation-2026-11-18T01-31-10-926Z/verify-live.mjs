import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

const root = 'D:/ProjectICreate/PuPuBot/pupu_20260425_105129/operations/pupu-notes-activation-2026-11-18T01-31-10-926Z';
const origin = 'http://127.0.0.1:3090';
const text = readFileSync(`${root}/web.stdout.log`, 'utf8');
const launchUrl = text.match(/http:\/\/127\.0\.0\.1:3090\/\?token=[^\s)]+/)?.[0];
assert(launchUrl, 'Waiting for official DSH readiness URL');
const launch = await fetch(launchUrl, { redirect: 'manual' });
const cookie = launch.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert(cookie, 'Official browser authentication failed');
async function rpc(method, args) {
  const response = await fetch(`${origin}/api/${method}`, {
    signal: AbortSignal.timeout(60_000),
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  });
  assert.equal(response.status, 200, `${method} HTTP status`);
  const envelope = await response.json();
  assert(envelope.result?.ok, JSON.stringify(envelope.result?.error ?? envelope));
  return envelope.result.value;
}
const notes = (action, input = {}, roleId) => rpc('pupuNotes/invoke', { request: { action, input, ...(roleId ? { roleId } : {}) } });
const qq = (action, args = {}) => rpc('qqBridge/request', { input: { action, args } });
let bridge = await qq('status');
if (process.argv.includes('--resume-qq')) {
  for (const route of bridge.routes) {
    if (route.status === 'active') continue;
    assert.equal(route.status, 'paused');
    assert.equal(route.error, '会话尚未载入，请打开这个会话后重试。', 'Inspect unexpected pause reason before resuming');
    await qq('resume', { account: route.account, peer: route.peer });
  }
  bridge = await qq('status');
}
if (process.argv.includes('--repair-workspaces')) {
  assert(bridge.routes.length === 2 && bridge.routes.every(route => route.status === 'paused'));
  assert.equal(bridge.outbox.length, 0, 'Pending sends require inspection');
  await qq('create_workspaces', { root: 'D:\\ProjectICreate\\PuPuBot\\pupu_20260425_105129\\workspaces\\qq' });
  for (const route of bridge.routes) await qq('new_chat', { account: route.account, peer: route.peer });
  bridge = await qq('status');
}
const state = await notes('state');
if (process.argv.includes('--prepare-web-ui')) {
  const manifestPath = `${root}/web-sessions.json`;
  const sessions = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
  const cwd = 'D:/ProjectICreate/PuPuBot/pupu_20260425_105129/workspaces/web';
  mkdirSync(cwd, { recursive: true });
  const { workspace } = await rpc('workspace/create', { request: { path: cwd } });
  assert.equal(typeof workspace.workspaceId, 'string');
  await rpc('workspace/rename', { request: { workspaceId: workspace.workspaceId, title: '蒲蒲笔记' } });
  for (const role of state.roles) {
    let prepared = sessions.find(session => session.roleId === role.id);
    if (!prepared) {
      prepared = { sessionId: randomUUID(), roleId: role.id, name: role.name, workspaceId: workspace.workspaceId };
      sessions.push(prepared);
      writeFileSync(manifestPath, JSON.stringify(sessions, null, 2));
      await rpc('session/create', { request: { sessionId: prepared.sessionId, workspaceId: workspace.workspaceId } });
    }
    await rpc('session/rename', { request: { sessionId: prepared.sessionId, title: `${role.name} · 新版笔记` } });
    await notes('bindSession', { sessionId: prepared.sessionId, roleId: role.id, speakerName: role.speakerName });
  }
}
const roleResults = [];
for (const role of state.roles) {
  const detail = await notes('state', {}, role.id);
  const card = await notes('notes', { action: 'view', path: '角色.md' }, role.id);
  roleResults.push({ id: role.id, name: role.name, stats: detail.stats, tasks: detail.tasks.map(task => ({
    reason: task.reason, status: task.status, progress: task.progress, error: task.error,
  })), roleCardPresent: typeof card.content === 'string' && card.content.length > 0 });
}
const routes = [];
for (const route of bridge.routes) {
  const bound = route.status === 'active' ? await notes('sessionState', { sessionId: route.sessionId }) : null;
  const workspace = bridge.workspaces.find(workspace => workspace.id === route.workspaceId);
  routes.push({ roleId: route.roleId, sessionId: route.sessionId, status: route.status, speakerName: route.speakerName,
    error: route.error, binding: bound?.binding ?? null, busy: bound?.busy,
    workspaceExists: !!workspace, workspaceId: route.workspaceId, workspacePath: workspace?.path });
}
const baseline = JSON.parse(readFileSync(`${root}/activation-state.json`, 'utf8'));
const changedNotes = [];
for (const [path, expected] of Object.entries(baseline.notesBefore)) {
  const current = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (current !== expected) changedNotes.push(path);
}
const result = {
  verifiedAt: new Date().toISOString(), origin,
  roles: roleResults, routes, connections: bridge.connections.map(({ enabled, connected, error }) => ({ enabled, connected, error })),
  bridgeError: bridge.error, pendingOutbox: bridge.outbox.length,
  checkedNotes: Object.keys(baseline.notesBefore).length, changedNotes,
  activeBundles: JSON.parse(readFileSync('C:/Users/57859/.dsh/profiles/web/package.json', 'utf8')).dsh.profile.bundles.filter(name => /pupu|qq/.test(name)),
  versions: Object.fromEntries(['dsh-pupu-notes', 'dsh-qq'].map(name => [
    name, JSON.parse(readFileSync(`C:/Users/57859/.dsh/profiles/web/node_modules/${name}/package.json`, 'utf8')).version,
  ])),
};
if (process.argv.includes('--assert-ready')) {
  assert.equal(result.roles.length, 2);
  assert(result.roles.every(role => role.roleCardPresent));
  assert.equal(result.checkedNotes, 501);
  assert.equal(result.changedNotes.length, 0);
  assert.equal(result.routes.length, 2);
  for (const route of result.routes) {
    assert.equal(route.status, 'active');
    assert.equal(route.binding?.sessionId, route.sessionId);
    assert.equal(route.binding?.roleId, route.roleId);
    assert.equal(route.binding?.speakerName, route.speakerName);
    assert(route.workspaceExists);
  }
  assert(result.connections.every(connection => connection.enabled && connection.connected));
  assert(!result.activeBundles.includes('dsh-pupu'));
}
if (process.argv.includes('--assert-workspaces-on-d')) {
  const expected = 'D:/ProjectICreate/PuPuBot/pupu_20260425_105129/workspaces/qq/';
  for (const route of result.routes) {
    assert(route.workspacePath?.replaceAll('\\', '/').startsWith(expected), 'QQ workspace has not moved to D');
  }
}
writeFileSync(`${root}/live-verification.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  ...result, roles: result.roles.map(role => ({
    id: role.id, name: role.name, stats: role.stats, roleCardPresent: role.roleCardPresent,
  })),
}, null, 2));
