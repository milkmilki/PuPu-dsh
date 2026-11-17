import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { EnginePool } from '../src/mcp/client.js';
import type { Role } from '../src/contracts.js';

const entry = resolve('dist/mcp.mjs');
test('built standalone Node MCP handshakes without PATH and exposes only natural notes tool', async () => {
  assert.equal(existsSync(entry), true, 'Run build before subprocess tests');
  const root = mkdtempSync(join(tmpdir(), 'notes-mcp-'));
  const client = new Client({ name: 'notes-integration', version: '1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry, '--root', root, '--name', '璐璐'],
    env: { PATH: '' }, stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name), ['notes']);
    const created = await client.callTool({
      name: 'notes', arguments: { action: 'create', path: '人物/小夫.md', content: '小夫喜欢热茶。' },
    });
    assert.equal(created.isError, undefined);
    const found = await client.callTool({ name: 'notes', arguments: { action: 'search', query: '热茶' } });
    assert.match(JSON.stringify(found), /人物\/小夫.md/);
    const rejected = await client.callTool({ name: 'notes', arguments: { action: 'view', path: '../state.sqlite' } });
    assert.equal(rejected.isError, true);
    await assert.rejects(client.callTool({ name: '_host', arguments: { method: 'stats' } }), /not found/i);
  } finally { await client.close(); }
});

test('pool cached proxy survives explicit release and child crash without retrying ambiguous writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notes-mcp-pool-'));
  const roleRoot = join(root, 'role'); mkdirSync(roleRoot);
  const wrapper = join(root, 'worker.mjs');
  writeFileSync(wrapper, `import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const root=process.argv[process.argv.indexOf('--root')+1];writeFileSync(join(root,'worker.pid'),String(process.pid));
await import(${JSON.stringify(pathToFileURL(entry).href)});`);
  const role: Role = { id: 'test-role', name: '仆仆', speakerName: '小夫', roleCardPath: '角色.md', createdAt: new Date().toISOString() };
  const pool = new EnginePool(() => roleRoot, wrapper);
  try {
    const proxy = await pool.get(role);
    await proxy.notes({ action: 'create', path: '随记/持久.md', content: '重启后仍在。' }, { operationId: 'exactly-once' });
    const firstPid = Number(readFileSync(join(roleRoot, 'worker.pid'), 'utf8'));
    await pool.release(role.id);
    assert.equal((await proxy.notes({ action: 'view', path: '随记/持久.md' })).content, '重启后仍在。');
    const secondPid = Number(readFileSync(join(roleRoot, 'worker.pid'), 'utf8'));
    assert.notEqual(secondPid, firstPid);
    process.kill(secondPid, 'SIGKILL');
    await delay(150);
    assert.equal((await proxy.notes({ action: 'view', path: '随记/持久.md' })).content, '重启后仍在。');
    const thirdPid = Number(readFileSync(join(roleRoot, 'worker.pid'), 'utf8'));
    assert.notEqual(thirdPid, secondPid);
    // A caller may deliberately replay its stable mutation key after uncertainty.
    await proxy.notes({ action: 'create', path: '随记/持久.md', content: '重启后仍在。' }, { operationId: 'exactly-once' });
    const versions = await proxy.admin<unknown[]>('versions', { path: '随记/持久.md' });
    assert.equal(versions.length, 2);
    assert.equal(await pool.get(role), proxy);
  } finally { await pool.close(); }
});
