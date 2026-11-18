import { createServer, type Server, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { Credentials, secretMatches } from './config'
import { Store } from './store'
import { ActionError, OneBot } from './onebot'
import { imageType } from './images'
import { qq, splitText } from './protocol'
import type { Segment } from './types'

export class Gateway extends EventEmitter {
  readonly bots = new Map<string, OneBot>()
  private http?: Server
  private subscribers = new Set<ServerResponse>()
  private flushing?: Promise<void>
  private stopped = false
  constructor(readonly store: Store, readonly credentials: Credentials, readonly actionTimeout = 15000) { super() }
  async start() {
    const config = this.store.config()
    try {
      for (const account of config.accounts.filter(a => a.enabled)) {
        const token = this.credentials.account(account.id)
        if (!token) throw new Error(`${account.name} 未设置连接凭据`)
        const bot = new OneBot(account, token, incoming => {
          if (!this.stopped && this.store.receive(incoming)) {
            this.emit('inbox')
            for (const res of this.subscribers) res.write(`event: inbox\ndata: ${JSON.stringify({ account: incoming.account })}\n\n`)
          }
        }, this.actionTimeout)
        this.bots.set(account.id, bot); await bot.start()
      }
      const host = localhostHostValidation(), origin = localhostOriginValidation()
      this.http = createServer((req, res) => {
        void (async () => {
          if (!host(req, res) || !origin(req, res)) return
          if (!secretMatches(req.headers.authorization?.replace(/^Bearer /, '') ?? '', this.credentials.gateway)) { res.writeHead(401); res.end(); return }
          if (req.url === '/host/events' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
            res.write('event: ready\ndata: {}\n\n'); this.subscribers.add(res)
            const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000)
            req.on('close', () => { clearInterval(timer); this.subscribers.delete(res) }); return
          }
          if (req.url === '/host/inbox' && req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(this.store.inbox())); return }
          if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
          let size = 0; const chunks: Buffer[] = []
          for await (const chunk of req) { size += chunk.length; if (size > 24 * 1024 * 1024) { res.writeHead(413); res.end(); return } chunks.push(chunk) }
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
          const server = this.mcpServer(), transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
          res.on('close', () => { void transport.close(); void server.close() })
          await server.connect(transport); await transport.handleRequest(req, res, body)
        })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(JSON.stringify({ error: '请求无效或桥接操作失败；请在 DSH QQ 连接页检查状态' })) })
      })
      this.http.requestTimeout = 30000
      await new Promise<void>((resolve, reject) => { this.http!.once('error', () => reject(new Error(`QQ MCP 端口 ${config.port} 无法监听（可能已被占用）`))); this.http!.listen(config.port, '127.0.0.1', resolve) })
    } catch (e) { await this.close(); throw e }
  }
  status() { return this.store.config().accounts.map(a => ({ id: a.id, enabled: a.enabled, connected: !!this.bots.get(a.id)?.connected, error: this.bots.get(a.id)?.error })) }
  private mcpServer() {
    const server = new McpServer({ name: 'dsh-qq', version: '0.1.3' })
    const target = { account: z.string(), peer: z.string().regex(/^[1-9][0-9]{4,15}$/), requestId: z.string().min(1).max(200) }
    const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
    server.registerTool('qq_status', { description: '查看本机 QQ 账号连接状态，不包含凭据。', inputSchema: z.object({}).strict() }, async () => result(this.status()))
    server.registerTool('qq_send_text', { description: '向已批准且已绑定 DSH 会话的 QQ 私聊发送文字。requestId 必须在同一次发送重试中保持不变。', inputSchema: z.object({ ...target, text: z.string().min(1).max(12000) }).strict() }, async a => result(await this.sendText(a.account, a.peer, a.requestId, a.text)))
    server.registerTool('qq_send_image', { description: '向已批准的 QQ 私聊发送经宿主授权读取的图片内容。仅接受 base64 图片，不读取本地文件路径。', inputSchema: z.object({ ...target, data: z.string().min(1).max(20 * 1024 * 1024) }).strict() }, async a => result(await this.sendImage(a.account, a.peer, a.requestId, a.data)))
    return server
  }
  assertTarget(account: string, peer: string) {
    qq(peer)
    if (this.stopped || this.store.contact(account, peer)?.status !== 'approved' || this.store.route(account, peer)?.status !== 'active') throw new Error('联系人未批准或会话路由已暂停')
  }
  async sendText(account: string, peer: string, key: string, text: string) {
    this.assertTarget(account, peer)
    key = `send:${account}:${peer}:${key}`
    if (!text.trim() || text.length > 12000) throw new Error('发送文字为空或超限')
    const parts = splitText(text)
    this.store.transaction(() => parts.forEach((part, i) => this.store.enqueue(`${key}:${i}`, account, peer, [{ type: 'text', data: { text: part } }])))
    await this.flush(); return this.store.outgoing().filter(x => x.key.startsWith(`${key}:`)).map(({ key, status, receipt }) => ({ key, status, receipt }))
  }
  async sendImage(account: string, peer: string, key: string, data: string, signal?: AbortSignal) {
    this.assertTarget(account, peer)
    signal?.throwIfAborted()
    key = `image:${account}:${peer}:${key}`
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('无效的 base64 图片')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > 15 * 1024 * 1024) throw new Error('图片超限')
    imageType(bytes)
    this.store.enqueue(key, account, peer, [{ type: 'image', data: { file: `base64://${data}` } }])
    const cancel = () => { if (this.store.outStatus(key) === 'pending') this.store.outState(key, 'cancelled', undefined, 'DSH 调用取消，未开始发送') }
    signal?.addEventListener('abort', cancel, { once: true })
    try { await this.flush() } finally { signal?.removeEventListener('abort', cancel) }
    const row = this.store.outgoing().find(x => x.key === key)
    return { key, status: row?.status, receipt: row?.receipt }
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.drain().finally(() => { this.flushing = undefined }); return this.flushing
  }
  private async drain() {
    const blocked = new Set<string>()
    for (const row of this.store.unsent()) {
      if (this.stopped) break
      if (this.store.outStatus(row.key) !== 'pending') continue
      const target = `${row.account}:${row.peer}`
      if (blocked.has(target)) continue
      if (this.store.contact(row.account, row.peer)?.status !== 'approved' || this.store.route(row.account, row.peer)?.status !== 'active') continue
      try {
        this.assertTarget(row.account, row.peer)
        const bot = this.bots.get(row.account)
        if (!bot?.connected) { blocked.add(target); continue }
        this.store.outState(row.key, 'sending')
        const value = await bot.action('send_private_msg', { user_id: Number(row.peer), message: row.segments })
        if (!value?.message_id) throw new ActionError('动作没有返回消息 ID，结果未知', true)
        this.store.outState(row.key, 'sent', String(value.message_id))
      } catch (e) {
        this.store.outState(row.key, e instanceof ActionError && e.uncertain ? 'uncertain' : 'failed', undefined, e instanceof Error ? e.message : '发送失败')
        blocked.add(target)
      }
    }
  }
  async close() {
    this.stopped = true
    for (const res of this.subscribers) res.end(); this.subscribers.clear()
    await Promise.all([...this.bots.values()].map(b => b.close())); this.bots.clear()
    await this.flushing
    this.http?.closeAllConnections()
    if (this.http?.listening) await new Promise<void>(resolve => this.http!.close(() => resolve()))
  }
}
