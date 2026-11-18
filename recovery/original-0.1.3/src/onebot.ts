import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { secretMatches } from './config'
import { parsePrivate } from './protocol'
import type { Account, Incoming } from './types'
export class ActionError extends Error { constructor(message: string, readonly uncertain = false) { super(message) } }
export class OneBot {
  private http?: Server
  private wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 })
  private socket?: WebSocket
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  error?: string
  constructor(readonly account: Account, readonly token: string, readonly receive: (message: Incoming) => void, readonly timeout = 15000) {}
  get connected() { return this.socket?.readyState === WebSocket.OPEN }
  async start() {
    this.http = createServer((_req, res) => { res.writeHead(404); res.end() })
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('access_token') ?? ''
      const self = String(req.headers['x-self-id'] ?? url.searchParams.get('self_id') ?? '')
      if (url.pathname !== '/onebot/v11/ws' || req.headers.origin || self !== this.account.selfId || !secretMatches(token, this.token) || this.connected) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.socket = ws; this.error = undefined
        let alive = true
        ws.on('pong', () => { alive = true })
        const heartbeat = setInterval(() => {
          if (!alive) { ws.terminate(); return }
          alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping()
        }, 30000)
        heartbeat.unref()
        ws.on('message', raw => {
          try {
            const data = JSON.parse(raw.toString())
            if (typeof data.echo === 'string' && this.pending.has(data.echo)) {
              const pending = this.pending.get(data.echo)!; clearTimeout(pending.timer); this.pending.delete(data.echo)
              if (data.status === 'ok' && data.retcode === 0) pending.resolve(data.data)
              else pending.reject(new ActionError('OneBot 动作未确认成功', data.status === 'async' || data.retcode === 1))
            } else {
              const incoming = parsePrivate(this.account.id, this.account.selfId, data)
              if (incoming) this.receive(incoming)
            }
          } catch { this.error = '消息格式无效或收件箱已满，请检查 QQ 连接页' }
        })
        ws.on('error', () => { this.error = 'OneBot 连接错误' })
        ws.on('close', () => {
          clearInterval(heartbeat)
          if (this.socket === ws) this.socket = undefined
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ActionError('连接中断，动作结果未知', true)) }
          this.pending.clear()
        })
      })
    })
    await new Promise<void>((resolve, reject) => { this.http!.once('error', () => reject(new Error(`${this.account.name} 端口 ${this.account.port} 无法监听（可能已被占用）`))); this.http!.listen(this.account.port, '127.0.0.1', resolve) })
  }
  action(action: string, params: unknown): Promise<any> {
    if (!this.connected) return Promise.reject(new ActionError('QQ 账号未连接'))
    const echo = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new ActionError('动作超时，结果未知', true)) }, this.timeout)
      this.pending.set(echo, { resolve, reject, timer })
      this.socket!.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new ActionError('发送中断，结果未知', true)) }
      })
    })
  }
  async close() {
    this.socket?.terminate()
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ActionError('网关停止，结果未知', true)) }
    this.pending.clear()
    this.wss.close()
    if (this.http?.listening) await new Promise<void>(resolve => this.http!.close(() => resolve()))
  }
}
