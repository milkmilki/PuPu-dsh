import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Store } from '../src/store'
import { Credentials } from '../src/config'
import { Gateway } from '../src/gateway'
export async function freePort() { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const port = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return port }
test('authenticated reverse WS and official MCP SDK: dedup, final send and uncertainty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qq-gateway-')), store = new Store(root), credentials = new Credentials(root)
  const port = await freePort(), wsport = await freePort()
  store.set('config', { port, accounts: [{ id: 'a', name: 'A', selfId: '111111', port: wsport, enabled: true, roleId: 'r', workspaceId: 'w' }] })
  credentials.setAccount('a', 'synthetic-secret-1234')
  const gateway = new Gateway(store, credentials, 100)
  let ws: WebSocket | undefined, client: Client | undefined
  try {
    await gateway.start()
    assert.throws(() => new Store(root), /已有/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/host/inbox`)).status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${port}/host/inbox`, { headers: { Authorization: `Bearer ${credentials.gateway}`, Origin: 'https://evil.test' } })).status, 403)
    ws = new WebSocket(`ws://127.0.0.1:${wsport}/onebot/v11/ws`, { headers: { Authorization: 'Bearer synthetic-secret-1234', 'X-Self-ID': '111111' } })
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject) })
    let received = 0
    gateway.on('inbox', () => received++)
    const event = { post_type: 'message', message_type: 'private', self_id: 111111, user_id: 222222, message_id: 1, message: [{ type: 'text', data: { text: 'hello' } }] }
    ws.send(JSON.stringify(event)); ws.send(JSON.stringify(event))
    await new Promise(r => setTimeout(r, 40))
    assert.equal(received, 1); assert.equal(store.pending().length, 0)
    store.admit('a', '222222', 'approved')
    store.saveRoute({ account: 'a', peer: '222222', sessionId: 's', workspaceId: 'w', roleId: 'r', speakerKey: 'owner', status: 'active', watermark: -1 })
    let actions = 0
    ws.on('message', raw => { const a = JSON.parse(raw.toString()); actions++; if (a.params.message[0].data.text !== 'timeout') ws!.send(JSON.stringify({ status: 'ok', retcode: 0, echo: a.echo, data: { message_id: 88 } })) })
    client = new Client({ name: 'synthetic-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${credentials.gateway}` } } }))
    assert.equal((await client.listTools()).tools.length, 3)
    const args = { account: 'a', peer: '222222', requestId: 'test1', text: 'reply' }
    await client.callTool({ name: 'qq_send_text', arguments: args })
    await client.callTool({ name: 'qq_send_text', arguments: args })
    assert.equal(actions, 1); assert.equal(store.outgoing()[0].status, 'sent')
    await client.callTool({ name: 'qq_send_text', arguments: { ...args, requestId: 'test2', text: 'timeout' } })
    assert.equal(store.outgoing()[0].status, 'uncertain')
    await gateway.flush(); assert.equal(actions, 2)
  } finally { await client?.close(); ws?.terminate(); await gateway.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})
