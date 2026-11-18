import { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-attachment'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Store } from './store'
import { Credentials, configSchema } from './config'
import { Gateway } from './gateway'
import { Adapter } from './adapter'
import remote, { requestSchema } from './remote'
export const name = 'qq-bridge'
export const inject = ['sessionController', 'workspaceRegistry', 'agents', 'tools', 'attachments', 'llm', 'typert']
export interface Config { dataDir?: string }

export class QqBridge extends TypertRemoteService {
  readonly store: Store
  readonly credentials: Credentials
  gateway: Gateway
  adapter: Adapter
  private scopes = new Map<string, Scope>()
  private tickPromise?: Promise<void>
  private error?: string
  private stopped = false
  private updating = false
  private administration: Promise<unknown> = Promise.resolve()
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'qqBridge')
    this.store = new Store(config.dataDir ?? join(resolveDshHome(), 'data', 'dsh-qq'))
    try { this.credentials = new Credentials(this.store.root) } catch (e) { this.store.close(); throw e }
    this.gateway = new Gateway(this.store, this.credentials)
    this.adapter = new Adapter(ctx, this.store, this.gateway, a => this.install(a))
  }
  async start() {
    configSchema.parse(this.store.config())
    try { await this.gateway.start(); this.error = undefined } catch (e) { this.error = String(e instanceof Error ? e.message : e); throw e }
    const crashed = this.store.setting('host-running') === true
    this.store.set('host-running', true)
    await this.adapter.recover(crashed)
  }
  install(agent: any) {
    if (this.scopes.has(agent.id) || !this.store.session(agent.id)) return
    const scope = createScope(this.ctx, agent); this.scopes.set(agent.id, scope)
    scope.ctx.tools.register({ name: 'qq_send_image',
      description: '把图片发给当前 QQ 私聊联系人。提供本对话已出现的 attachment_id，或提供图片 file_path 让 DSH 的 read_image 按此对话现有文件权限读取。只发你明确选择的图片，不自动发送工具产物；最终文字回复已经由桥接自动转发。',
      parameters: { type: 'object', properties: { attachment_id: { type: 'string', description: '本对话已有的图片附件 ID；与 file_path 二选一。' }, file_path: { type: 'string', description: '按当前对话文件系统和权限读取的图片路径；与 attachment_id 二选一。' } }, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      execute: async (args: any, exec) => {
        if (!exec.agent || exec.agent.id !== agent.id || this.stopped) throw new Error('当前会话不可用')
        const route = this.store.session(agent.id)
        if (!route || route.status !== 'active') throw new Error('QQ 路由已暂停')
        await this.adapter.validate(route)
        if (!!args.attachment_id === !!args.file_path) throw new Error('请只提供 attachment_id 或 file_path 其中一项')
        let data: string
        if (args.attachment_id) data = (await this.ctx.sessionController.attachment({ sessionId: agent.id, attachmentId: args.attachment_id })).data
        else {
          const read: any = await this.ctx.tools.execute({ name: 'read_image', callId: `${exec.callId}:read` as any, rootCallId: exec.rootCallId, parent: exec.token, arguments: { file_path: args.file_path }, agent: exec.agent, signal: exec.signal })
          if (read.isError) throw new Error(`DSH 图片读取失败：${read.error?.message ?? '未允许读取图片'}；未发送`)
          const ref = read.content?.find((p: any) => p.type === 'image')?.attachment
          if (!ref) throw new Error('read_image 未返回图片附件；未发送')
          data = Buffer.from((await this.ctx.attachments.readImage(ref, exec.signal)).data).toString('base64')
        }
        exec.signal.throwIfAborted()
        return this.gateway.sendImage(route.account, route.peer, `tool:${agent.id}:${exec.callId}`, data, exec.signal)
      },
    })
  }
  async removeScope(id: string) { await this.scopes.get(id)?.dispose(); this.scopes.delete(id) }
  tick() {
    if (this.stopped || this.updating) return Promise.resolve()
    if (!this.tickPromise) this.tickPromise = (async () => { await this.adapter.processInbox(); await this.gateway.flush() })().catch(e => { this.error = e instanceof Error ? e.message : '桥接处理失败' }).finally(() => { this.tickPromise = undefined })
    return this.tickPromise
  }
  @Remote async request(input: unknown): Promise<any> {
    const next = this.administration.catch(() => {}).then(() => this.perform(input))
    this.administration = next; return next
  }
  private async perform(input: unknown): Promise<any> {
    const { action, args } = requestSchema.parse(input)
    if (this.stopped) throw new Error('插件已停止')
    if (action === 'status') {
      let roles: any[] = []; try { roles = (await this.adapter.pupu('list')).roles.map((r: any) => ({ id: r.id, name: r.name })) } catch {}
      return { config: this.store.config(), credentialsSet: Object.fromEntries(this.store.config().accounts.map(a => [a.id, !!this.credentials.account(a.id)])), connections: this.gateway.status(), contacts: this.store.contacts(), routes: this.store.routes(), outbox: this.store.outgoing().filter(r => r.status !== 'sent').map(({ segments, ...r }) => r), inbox: this.store.inbox().map(({ segments, ...r }) => r), roles, workspaces: this.ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path })), error: this.error ?? null }
    }
    if (action === 'save') {
      const config = configSchema.parse(args.config)
      const secrets = args.secrets as Record<string, string> | undefined
      const previousConfig = this.store.config()
      if (!Object.values(secrets ?? {}).some(Boolean) && config.port === previousConfig.port && isDeepStrictEqual(config.accounts, previousConfig.accounts)) {
        this.store.set('config', config); return { saved: true }
      }
      for (const a of config.accounts) {
        if (secrets?.[a.id]) this.credentials.setAccount(a.id, secrets[a.id])
        if (a.enabled && !this.credentials.account(a.id)) throw new Error(`${a.name} 缺少连接凭据`)
        if (a.enabled && (!this.ctx.workspaceRegistry.get(a.workspaceId as any) || !(await this.adapter.pupu('list')).roles.some((r: any) => r.id === a.roleId))) throw new Error('工作区或角色不存在')
        const previous = this.store.config().accounts.find(p => p.id === a.id)
        if (previous && ['workspaceId', 'roleId', 'ownerQQ'].some(k => (previous as any)[k] !== (a as any)[k])) {
          for (const route of this.store.routes().filter(r => r.account === a.id)) this.adapter.pause(route, new Error('账号绑定或主人映射变更；请开始新聊天'))
        }
      }
      this.updating = true
      await this.adapter.dispose()
      await this.tickPromise
      await this.gateway.close()
      this.store.set('config', config)
      this.gateway = new Gateway(this.store, this.credentials); this.adapter = new Adapter(this.ctx, this.store, this.gateway, a => this.install(a))
      try { await this.gateway.start(); this.error = undefined } catch (e) { this.error = e instanceof Error ? e.message : '监听失败'; throw e } finally { this.updating = false }
      await this.adapter.recover()
      return { saved: true }
    }
    if (action === 'create_workspaces') {
      if (typeof args.root !== 'string' || !isAbsolute(args.root)) throw new Error('请提供工作区根目录的绝对路径')
      for (const account of this.store.config().accounts) {
        const path = join(args.root, account.id); await mkdir(path, { recursive: true })
        const workspace = await this.ctx.workspaceRegistry.create(path, account.name)
        if (account.workspaceId && account.workspaceId !== workspace.id) for (const route of this.store.routes().filter(r => r.account === account.id)) this.adapter.pause(route, new Error('工作区绑定变更；请开始新聊天'))
        const config = this.store.config(); config.accounts.find(a => a.id === account.id)!.workspaceId = workspace.id; this.store.set('config', config)
      }
      return { created: true }
    }
    const account = String(args.account ?? ''), peer = String(args.peer ?? '')
    if (action === 'approve') {
      if (args.sharedMemoryConfirmed !== true) throw new Error('请确认此联系人可以共享角色整库记忆')
      this.store.admit(account, peer, 'approved'); await this.adapter.serial(`${account}:${peer}`, () => this.adapter.ensureRoute(account, peer)); void this.tick(); return { approved: true }
    }
    if (action === 'reject') { this.store.admit(account, peer, 'rejected'); const r = this.store.route(account, peer); if (r) this.adapter.pause(r, new Error('联系人已拒绝')); return { rejected: true } }
    if (action === 'pause' || action === 'resume' || action === 'new_chat') {
      const route = this.store.route(account, peer); if (!route) throw new Error('会话路由不存在')
      if (action === 'pause') this.adapter.pause(route, new Error('手动暂停'))
      else if (action === 'resume') { await this.adapter.validate(route); this.store.saveRoute({ ...route, status: 'active', error: undefined }) }
      else { if (this.store.contact(account, peer)?.status !== 'approved') throw new Error('联系人未批准'); await this.removeScope(route.sessionId); await this.adapter.serial(`${account}:${peer}`, () => this.adapter.ensureRoute(account, peer, true)) }
      return { updated: true }
    }
    if (action === 'retry_send') {
      const row = this.store.outgoing().find(r => r.key === args.key)
      if (!row || !['failed', 'uncertain'].includes(row.status)) throw new Error('发送状态不可重试')
      if (row.status === 'uncertain' && args.duplicateRiskConfirmed !== true) throw new Error('请先确认 QQ 未收到此消息；重试可能重复发送')
      this.store.outState(row.key, 'pending'); void this.tick(); return { queued: true }
    }
    if (action === 'confirm_send') {
      const row = this.store.outgoing().find(r => r.key === args.key)
      if (row?.status !== 'uncertain' || args.receivedConfirmed !== true) throw new Error('仅可确认已人工核实收到的结果未知消息')
      this.store.outState(row.key, 'sent', 'manually-confirmed'); void this.tick(); return { confirmed: true }
    }
    if (action === 'retry_input' || action === 'discard_input') {
      const row = this.store.inbox().find(r => r.key === args.key)
      if (!row) throw new Error('消息不存在')
      await this.adapter.serial(`${row.account}:${row.peer}`, async () => {
        const current = this.store.inbox().find(r => r.key === row.key)
        if (!current) return
        if (action === 'retry_input' && current.status !== 'error') throw new Error('仅可重试处理失败的来信')
        this.store.inState(row.key, action === 'retry_input' ? 'received' : 'discarded')
      })
      void this.tick(); return { updated: true }
    }
    throw new Error('未知 QQ 管理操作')
  }
  async dispose() {
    this.stopped = true; await this.administration.catch(() => {}); await this.adapter.dispose(); await this.tickPromise; await this.gateway.close()
    for (const id of this.scopes.keys()) await this.removeScope(id)
    this.store.set('host-running', false)
    this.store.close()
  }
}
export async function apply(ctx: Context, config: Config = {}) {
  const service = new QqBridge(ctx, config)
  ctx.effect(() => () => service.dispose())
  await service.start()
  ctx.typert.remotes.register(remote)
  ctx.on('agent/created', ({ agent }) => { service.install(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => service.removeScope(agent.id))
  ctx.on('session/event', (session, event) => { if (event.type === 'turn/end') void service.adapter.capture(session, event).catch(e => { const route = service.store.session(session.id); if (route) service.adapter.pause(route, e) }) })
  const timer = setInterval(() => { void service.tick() }, 1000); timer.unref()
  ctx.effect(() => () => clearInterval(timer))
}
