import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Store } from './store'
import { Gateway } from './gateway'
import { completedReply, splitReply } from './final-reply'
import { downloadImage, imageType } from './images'
import { readyBatch } from './batching'
import type { Account, Inbox, InputBatch, Route } from './types'

/** Only this boundary knows about DSH; the gateway cannot drive an agent. */
export class Adapter {
  readonly stop = new AbortController()
  private pending = new Map<string, Promise<any>>()
  constructor(readonly ctx: any, readonly store: Store, readonly gateway: Gateway, readonly installTools: (agent: any) => void, readonly download = downloadImage) {}
  pupu(action: string, args: Record<string, unknown> = {}): Promise<any> {
    const service = this.ctx.get('pupu')
    if (!service) throw new Error('请先启用 PuPu 角色记忆插件')
    return service.request({ action, args })
  }
  serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.pending.set(key, next)
    void next.finally(() => { if (this.pending.get(key) === next) this.pending.delete(key) }).catch(() => {})
    return next
  }
  account(id: string): Account {
    const account = this.store.config().accounts.find(a => a.id === id)
    if (!account?.enabled || !account.workspaceId || !account.roleId) throw new Error('QQ 账号连接或工作区绑定未启用')
    return account
  }
  async validate(route: Route) {
    const account = this.account(route.account), workspace = this.ctx.workspaceRegistry.get(route.workspaceId)
    if (!workspace || await workspace.status() !== 'ok' || account.workspaceId !== route.workspaceId || account.roleId !== route.roleId) throw new Error('工作区缺失或绑定已变更，请检查后恢复或开始新聊天')
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(route.sessionId)) throw new Error('对话已归档，请先在 DSH 恢复对话')
    const inspection = await this.ctx.sessionController.inspect(route.sessionId, this.stop.signal)
    if (resolve(inspection.meta.cwd) !== resolve(workspace.path)) throw new Error('对话不属于绑定的工作区')
    const binding = await this.pupu('binding', { sessionId: route.sessionId })
    if (binding.roleId !== route.roleId || (binding.speakerKey ?? 'owner') !== route.speakerKey) throw new Error('PuPu 角色或说话者绑定失效')
    return inspection
  }
  pause(route: Route, error: unknown) {
    this.store.saveRoute({ ...this.store.route(route.account, route.peer)!, status: 'paused', error: error instanceof Error ? error.message : '路由失败' })
  }
  async ensureRoute(accountId: string, peer: string, fresh = false): Promise<Route> {
    const account = this.account(accountId)
    let route = this.store.route(accountId, peer)
    if (route && !fresh && route.status !== 'creating') {
      if (route.status !== 'active') throw new Error(route.error ?? '路由已暂停')
      await this.validate(route); return route
    }
    const workspace = this.ctx.workspaceRegistry.get(account.workspaceId)
    if (!workspace || await workspace.status() !== 'ok') throw new Error('绑定工作区不存在')
    if (!route || fresh) {
      if (route) {
        const old = this.ctx.agents.get(route.sessionId)
        if (old?.status === 'running') throw new Error('请先等待当前轮次结束，再开始新聊天')
        this.store.set(`route-history:${route.sessionId}`, route)
      }
      route = { account: accountId, peer, sessionId: randomUUID(), workspaceId: account.workspaceId!, roleId: account.roleId!, speakerKey: '', status: 'creating', watermark: -1 }
      this.store.saveRoute(route)
    }
    // A reserved ID survives a crash between create() and saving the returned ID.
    let agent = this.ctx.agents.get(route.sessionId)
    if (!agent) {
      let exists = false
      try { await this.ctx.sessionController.inspect(route.sessionId, this.stop.signal); exists = true } catch (e: any) {
        if (!/not.found|不存在|not found/i.test(String(e?.code ?? '') + String(e?.message ?? ''))) throw e
      }
      if (!exists) {
        const created = await this.ctx.sessionController.create({ workspaceId: route.workspaceId, sessionId: route.sessionId })
        route.sessionId = created.sessionId; this.store.saveRoute(route)
      }
      const loaded = await this.ctx.sessionController.resolveAgent(route.sessionId)
      if (loaded.error) throw new Error('DSH 对话无法恢复')
      agent = loaded.agent
    }
    await this.pupu('bind', { sessionId: route.sessionId, roleId: route.roleId })
    let speakerKey = peer === account.ownerQQ ? 'owner' : this.store.setting(`speaker:${peer}`)
    if (!speakerKey) {
      const name = `QQ ${peer}`, { speakers } = await this.pupu('speakers', { sessionId: route.sessionId })
      speakerKey = speakers.find((p: any) => p.name === name)?.personKey ?? (await this.pupu('create_speaker', { name })).personKey
      this.store.set(`speaker:${peer}`, speakerKey)
    }
    await this.pupu('bind_speaker', { sessionId: route.sessionId, personKey: speakerKey })
    route.speakerKey = speakerKey; route.status = 'active'; route.error = undefined
    route.watermark = agent.session.snapshotEvents().at(-1)?.seq ?? -1
    this.store.saveRoute(route); this.installTools(agent)
    await this.ctx.sessionController.rename({ sessionId: route.sessionId, title: `QQ · ${this.store.contact(accountId, peer)?.nickname ?? peer} (${peer})` })
    return route
  }
  async processInbox() {
    const blocked = new Set<string>()
    const select = (items: Inbox[]) => readyBatch(items, this.store.now(), this.store.config().mergeWindowSeconds ?? 20, this.ctx.attachments?.imageLimits.maxImagesPerMessage ?? 10)
    const dispatch = async (items: Inbox[], sealed?: InputBatch) => {
      const first = items[0], key = `${first.account}:${first.peer}`
      let failureKey = first.key
      if (this.stop.signal.aborted || blocked.has(key)) return
      blocked.add(key)
      try {
        await this.serial(key, async () => {
          if (this.stop.signal.aborted || this.store.contact(first.account, first.peer)?.status !== 'approved') return
          const route = await this.ensureRoute(first.account, first.peer)
          if (this.ctx.agents.get(route.sessionId)?.status === 'running') return
          const current = sealed ? sealed.items : select(this.store.pending().filter(i => i.account === first.account && i.peer === first.peer))
          if (!current) return
          failureKey = current[0].key
          const batch = sealed ?? this.store.sealBatch(current, route.sessionId)
          await this.deliver(batch, route)
        })
      } catch (e) {
        if (this.stop.signal.aborted) return
        if (!this.store.inbox().some(i => i.key === failureKey)) return
        this.store.inState(failureKey, 'error', e instanceof Error ? e.message : '输入失败')
        const route = this.store.route(first.account, first.peer)
        if (route) this.pause(route, e)
      }
    }
    // Claimed membership must not change after a crash, retry or new arrival.
    for (const batch of this.store.pendingBatches()) await dispatch(batch.items, batch)
    const groups = new Map<string, Inbox[]>()
    for (const item of this.store.pending()) {
      const key = `${item.account}:${item.peer}`, group = groups.get(key) ?? []
      group.push(item); groups.set(key, group)
    }
    for (const items of groups.values()) {
      const batch = select(items)
      if (batch) await dispatch(batch)
    }
  }
  private async deliver(batch: InputBatch, route: Route) {
    if (batch.sessionId !== route.sessionId) throw new Error('此合并批次属于原 DSH 对话，不能自动改投新聊天；请核对后丢弃该批次')
    const loaded = await this.ctx.sessionController.resolveAgent(route.sessionId)
    if (loaded.error) throw new Error('DSH 无法恢复此对话')
    if (loaded.agent.status === 'running') return
    const content: any[] = []
    const requestId = `dsh-qq:${batch.key}`
    const alreadyAdmitted = loaded.agent.session.snapshotEvents().some((e: any) =>
      e.type === 'user/message' && (e.data.message?.source ?? e.data.source)?.rpcId === requestId
      || e.type === 'agent/inbox/spliced' && e.data.inserted?.some((m: any) => m.source?.rpcId === requestId))
    if (alreadyAdmitted) {
      this.store.inState(batch.items[0].key, 'accepted'); return
    }
    for (const [index, item] of batch.items.entries()) {
      if (index) content.push({ type: 'text', text: '\uFF0C' })
      for (const segment of item.segments) {
        if (segment.type === 'text') content.push({ type: 'text', text: segment.data.text })
        else if (segment.type === 'image') {
          let url = segment.data.url
          if (!url) url = (await this.gateway.bots.get(item.account)!.action('get_image', { file: segment.data.file })).url
          const data = await this.download(url, Math.min(15 * 1024 * 1024, this.ctx.attachments.imageLimits.maxImageBytes), this.stop.signal)
          const mediaType = imageType(data)
          await this.ctx.attachments.validateImage({ data, mediaType })
          content.push({ type: 'image', mediaType, data: data.toString('base64'), name: `qq-${item.id}` })
        }
      }
    }
    this.stop.signal.throwIfAborted()
    const current = this.store.route(batch.account, batch.peer)
    if (current?.status !== 'active' || current.sessionId !== batch.sessionId || this.store.contact(batch.account, batch.peer)?.status !== 'approved') throw new Error('联系人或路由状态已变化，合并批次未投递')
    // DSH deduplicates against both the durable user message and its durable queue.
    try {
      await this.ctx.sessionController.prompt({ sessionId: route.sessionId, requestId, mode: 'queue', content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, this.stop.signal)
    } catch (e: any) {
      if (e?.details?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') throw new Error('此对话当前模型不支持图片；请在 DSH 选择支持图片的模型后重试，不会自动切换模型')
      throw e
    }
    this.store.inState(batch.items[0].key, 'accepted')
  }
  async capture(session: any, end: any) {
    const route = this.store.session(session.id)
    if (!route || end.type !== 'turn/end') return
    await this.serial(`${route.account}:${route.peer}`, async () => {
      const current = this.store.session(session.id)
      if (!current || current.status !== 'active' || end.seq <= current.watermark) return
      try { await this.validate(current) } catch (e) { this.pause(current, e); return }
      const agent = this.ctx.agents.get(session.id)
      if (agent) await this.ctx.parallel(scopeTarget(agent.session, agent), 'session/flush', agent.session)
      const reply = completedReply(session.snapshotEvents(), end)
      this.store.transaction(() => {
        if (reply) splitReply(reply.text).forEach((text, i) => this.store.enqueue(`final:${session.id}:${reply.id}:${i}`, current.account, current.peer, [{ type: 'text', data: { text } }]))
        this.store.saveRoute({ ...current, watermark: end.seq })
      })
    })
  }
  async recover(replayCrashTail = false) {
    for (const route of this.store.routes()) {
      if (route.status !== 'active') continue
      try {
        const inspection = await this.validate(route)
        if (replayCrashTail) {
          for (const event of inspection.events) if (event.type === 'turn/end' && event.seq > route.watermark) await this.capture({ id: route.sessionId, snapshotEvents: () => inspection.events }, event)
        }
        // Clean disable/enable skips offline history; crash recovery uses the saved boundary.
        this.store.saveRoute({ ...this.store.route(route.account, route.peer)!, watermark: inspection.events.at(-1)?.seq ?? -1 })
        const loaded = await this.ctx.sessionController.resolveAgent(route.sessionId)
        if (loaded.error) throw new Error('无法恢复已绑定对话')
        this.installTools(loaded.agent)
      } catch (e) { this.pause(route, e) }
    }
  }
  async dispose() { this.stop.abort(); await Promise.allSettled(this.pending.values()) }
}
