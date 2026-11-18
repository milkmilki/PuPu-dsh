import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import { Adapter } from '../src/adapter'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qq-notes-adapter-'))
  const store = new Store(root), sessions = new Map<string, any>(), persisted = new Map<string, any>(), bindings = new Map<string, any>()
  const invocations: any[] = [], creates: string[] = [], operations: string[] = []
  let failAfterCreate = false, installs = 0
  store.set('config', { port: 18080, mergeWindowSeconds: 20, accounts: [
    { id: 'a', selfId: '111111', name: '仆仆', port: 18081, enabled: true, workspaceId: 'w', roleId: 'notes-role', ownerQQ: '222222' },
  ] })
  const ctx: any = {
    get: () => { throw new Error('Old PuPu service must never be used') },
    pupuNotes: { invoke: async (request: any) => {
      invocations.push(request)
      operations.push(`notes:${request.action}`)
      if (request.action === 'state') return { roles: [{ id: 'notes-role', name: '仆仆', speakerName: '小夫' }] }
      const id = request.input.sessionId
      if (request.action === 'sessionState') {
        if (!sessions.has(id)) throw new Error('会话尚未载入，请打开这个会话后重试。')
        return { binding: bindings.get(id) ?? null }
      }
      if (request.action === 'bindSession') {
        bindings.set(id, { sessionId: id, roleId: request.input.roleId, speakerName: request.input.speakerName })
        return { binding: bindings.get(id) }
      }
      throw new Error('Unexpected notes request')
    } },
    workspaceRegistry: { get: () => ({ path: root, status: async () => 'ok' }), archivedSessionIds: [] },
    agents: { get: (id: string) => sessions.get(id) },
    sessionController: {
      create: async ({ sessionId }: any) => {
        operations.push('create'); creates.push(sessionId)
        const events: any[] = []
        const agent = { id: sessionId, status: 'idle', session: { snapshotEvents: () => events }, events }
        persisted.set(sessionId, agent); sessions.set(sessionId, agent)
        if (failAfterCreate) throw new Error('Crash after persisted native create')
        return { sessionId }
      },
      inspect: async (id: string) => {
        operations.push('inspect')
        const agent = persisted.get(id)
        if (!agent) throw new Error('not found')
        return { meta: { cwd: root }, events: agent.events }
      },
      resolveAgent: async (id: string) => {
        operations.push('resolveAgent')
        const agent = persisted.get(id)
        if (!agent) return { error: new Error('not found') }
        sessions.set(id, agent)
        return { agent }
      },
      rename: async () => { operations.push('rename') },
      prompt: async () => { operations.push('prompt'); throw new Error('Recovery must not prompt an agent') },
    },
  }
  const make = () => new Adapter(ctx, store, {} as any, () => { installs++ })
  let adapter = make()
  return {
    store, ctx, sessions, persisted, bindings, invocations, creates, operations, get adapter() { return adapter }, get installs() { return installs },
    failCreate(value: boolean) { failAfterCreate = value },
    async restart(cold = false) { await adapter.dispose(); if (cold) sessions.clear(); adapter = make() },
    async close() { await adapter.dispose(); store.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

test('native route creation binds the current notes role and owner name once, without legacy calls', async () => {
  const f = fixture()
  try {
    const route = await f.adapter.ensureRoute('a', '222222')
    assert.equal(route.roleId, 'notes-role'); assert.equal(route.speakerKey, 'owner')
    assert.equal((route as any).speakerName, '小夫')
    assert.equal(f.creates.length, 1); assert.equal(f.installs, 1)
    const binds = f.invocations.filter(item => item.action === 'bindSession')
    assert.equal(binds.length, 1)
    assert.deepEqual(binds[0].input, { sessionId: route.sessionId, roleId: 'notes-role', speakerName: '小夫' })
    assert(!f.invocations.some(item => ['bind', 'bind_speaker', 'create_speaker'].includes(item.action)))
  } finally { await f.close() }
})

test('restart recovers a reserved creating route after native create committed before response', async () => {
  const f = fixture()
  try {
    f.failCreate(true)
    await assert.rejects(f.adapter.ensureRoute('a', '222222'), /Crash/)
    const reserved = f.store.route('a', '222222')!
    assert.equal(reserved.status, 'creating')
    await f.restart(true); f.failCreate(false)
    await f.adapter.recover()
    const restored = f.store.route('a', '222222')!
    assert.equal(restored.sessionId, reserved.sessionId); assert.equal(restored.status, 'active')
    assert.equal(f.creates.length, 1); assert.equal((restored as any).speakerName, '小夫')
  } finally { await f.close() }
})

test('a creating route cannot adopt another roles existing binding or overwrite a wrong speaker', async () => {
  const f = fixture()
  try {
    const route = await f.adapter.ensureRoute('a', '222222')
    const expected = f.invocations.filter(item => item.action === 'bindSession').length
    for (const wrong of [{ roleId: 'other', speakerName: '小夫' }, { roleId: route.roleId, speakerName: '另一人' }]) {
      f.bindings.set(route.sessionId, { sessionId: route.sessionId, ...wrong })
      await assert.rejects(f.adapter.validate(route), /角色|说话者|身份/)
      f.store.saveRoute({ ...route, status: 'creating' })
      await assert.rejects(f.adapter.ensureRoute('a', '222222'), /角色|说话者|身份/)
    }
    assert.equal(f.invocations.filter(item => item.action === 'bindSession').length, expected)
  } finally { await f.close() }
})

test('custom speaker mappings and stable guest names survive nickname changes without merging people', async () => {
  const f = fixture()
  try {
    f.store.set('speaker:333333', 'speaker:custom')
    f.store.set('speaker-name:speaker:custom', '知夏姐姐')
    f.store.receive({ account: 'a', peer: '333333', id: '1', nickname: '临时昵称', segments: [] })
    const custom = await f.adapter.ensureRoute('a', '333333')
    assert.equal(custom.speakerKey, 'speaker:custom'); assert.equal((custom as any).speakerName, '知夏姐姐')
    for (const peer of ['444444', '555555'])
      f.store.receive({ account: 'a', peer, id: '1', nickname: '同名朋友', segments: [] })
    const first = await f.adapter.ensureRoute('a', '444444'), second = await f.adapter.ensureRoute('a', '555555')
    assert.notEqual(first.speakerKey, second.speakerKey)
    assert.equal((first as any).speakerName, '同名朋友（QQ 444444）')
    assert.notEqual((first as any).speakerName, (second as any).speakerName)
    assert.notEqual(f.bindings.get(first.sessionId).speakerName, f.bindings.get(second.sessionId).speakerName)
    f.store.receive({ account: 'a', peer: '444444', id: '2', nickname: '改名', segments: [] })
    const fresh = await f.adapter.ensureRoute('a', '444444', true)
    assert.equal(fresh.speakerKey, first.speakerKey); assert.equal((fresh as any).speakerName, (first as any).speakerName)
  } finally { await f.close() }
})

test('a reserved route refuses changed account roles and a stale owner mapping before native creation', async () => {
  const f = fixture()
  try {
    f.store.saveRoute({ account: 'a', peer: '222222', sessionId: 'reserved', workspaceId: 'w',
      roleId: 'notes-role', speakerKey: 'owner', speakerName: '小夫', status: 'creating', watermark: -1 })
    const config = f.store.config()
    f.store.set('config', { ...config, accounts: config.accounts.map(account => ({ ...account, roleId: 'other-role' })) })
    await assert.rejects(f.adapter.ensureRoute('a', '222222'), /绑定|角色/)
    f.store.set('config', config)
    f.store.saveRoute({ ...f.store.route('a', '222222')!, sessionId: 'reserved-other', peer: '333333' })
    await assert.rejects(f.adapter.ensureRoute('a', '333333'), /主人身份/)
    assert.equal(f.creates.length, 0)
  } finally { await f.close() }
})

test('a reserved existing native session in another workspace is not rebound', async () => {
  const f = fixture()
  try {
    f.store.saveRoute({ account: 'a', peer: '222222', sessionId: 'collision', workspaceId: 'w',
      roleId: 'notes-role', speakerKey: 'owner', speakerName: '小夫', status: 'creating', watermark: -1 })
    f.sessions.set('collision', { id: 'collision', status: 'idle', session: { snapshotEvents: () => [] } })
    f.ctx.sessionController.inspect = async () => ({ meta: { cwd: 'C:\\unrelated-workspace' }, events: [] })
    await assert.rejects(f.adapter.ensureRoute('a', '222222'), /工作区/)
    assert.equal(f.invocations.filter(item => item.action === 'bindSession').length, 0)
  } finally { await f.close() }
})

test('an untrusted QQ nickname cannot become the owner name in the actual Notes binding', async () => {
  const f = fixture()
  try {
    f.store.receive({ account: 'a', peer: '333333', id: '1', nickname: '小夫', segments: [] })
    const owner = await f.adapter.ensureRoute('a', '222222')
    const guest = await f.adapter.ensureRoute('a', '333333')
    assert.equal(f.bindings.get(owner.sessionId).speakerName, '小夫')
    assert.equal(f.bindings.get(guest.sessionId).speakerName, '小夫（QQ 333333）')
    assert.notEqual(f.bindings.get(owner.sessionId).speakerName, f.bindings.get(guest.sessionId).speakerName)
  } finally { await f.close() }
})

test('startup restores a cold active conversation before Notes identity validation without rebinding or prompting', async () => {
  const f = fixture()
  try {
    const route = await f.adapter.ensureRoute('a', '222222')
    const agent = f.persisted.get(route.sessionId)
    agent.events.push({ seq: 1, type: 'user/message' }, { seq: 2, type: 'assistant/text' }, { seq: 3, type: 'turn/end' })
    const binding = structuredClone(f.bindings.get(route.sessionId))
    const binds = f.invocations.filter(item => item.action === 'bindSession').length
    await f.restart(true); f.operations.length = 0
    assert.equal(f.sessions.size, 0)
    await f.adapter.recover()
    const restored = f.store.route('a', '222222')!
    assert.equal(restored.status, 'active'); assert.equal(restored.sessionId, route.sessionId)
    assert.equal(restored.watermark, 3); assert.equal(f.sessions.get(route.sessionId), agent)
    assert.deepEqual(f.bindings.get(route.sessionId), binding)
    assert(f.operations.indexOf('inspect') < f.operations.indexOf('resolveAgent'))
    assert(f.operations.indexOf('resolveAgent') < f.operations.indexOf('notes:sessionState'))
    assert.equal(f.invocations.filter(item => item.action === 'bindSession').length, binds)
    assert(!f.operations.some(operation => ['create', 'rename', 'prompt'].includes(operation)))
    assert.equal(f.installs, 2)
  } finally { await f.close() }
})

test('manual validation can load a cold paused conversation but rejects its mismatched identity without rebinding', async () => {
  const f = fixture()
  try {
    const route = await f.adapter.ensureRoute('a', '222222')
    await f.restart(true)
    const paused = { ...route, status: 'paused' as const, error: '手动暂停' }
    f.store.saveRoute(paused); f.operations.length = 0
    await f.adapter.validate(paused)
    assert(f.sessions.has(route.sessionId))
    assert.equal(f.store.route('a', '222222')!.status, 'paused')
    f.sessions.clear(); f.bindings.set(route.sessionId, { sessionId: route.sessionId, roleId: route.roleId, speakerName: '另一人' })
    const binds = f.invocations.filter(item => item.action === 'bindSession').length
    await assert.rejects(f.adapter.validate(paused), /角色|说话者|身份/)
    assert.equal(f.invocations.filter(item => item.action === 'bindSession').length, binds)
    assert(!f.operations.includes('prompt'))
  } finally { await f.close() }
})

test('cold validation rejects archived sessions, another cwd and changed account bindings before loading an agent', async () => {
  const f = fixture()
  try {
    const route = await f.adapter.ensureRoute('a', '222222')
    await f.restart(true); f.operations.length = 0
    const inspect = f.ctx.sessionController.inspect
    f.ctx.workspaceRegistry.archivedSessionIds = [route.sessionId]
    await assert.rejects(f.adapter.validate(route), /归档/)
    f.ctx.workspaceRegistry.archivedSessionIds = []
    f.ctx.sessionController.inspect = async () => ({ meta: { cwd: 'C:\\unrelated-workspace' }, events: [] })
    await assert.rejects(f.adapter.validate(route), /工作区/)
    f.ctx.sessionController.inspect = inspect
    const config = f.store.config()
    f.store.set('config', { ...config, accounts: config.accounts.map(account => ({ ...account, roleId: 'other-role' })) })
    await assert.rejects(f.adapter.validate(route), /绑定/)
    assert.equal(f.sessions.size, 0)
    assert(!f.operations.includes('resolveAgent'))
    assert(!f.operations.includes('notes:sessionState'))
  } finally { await f.close() }
})

test('a failed cold resume pauses startup recovery before Notes access and does not create a replacement session', async () => {
  const f = fixture()
  try {
    const route = await f.adapter.ensureRoute('a', '222222')
    await f.restart(true); f.operations.length = 0
    f.ctx.sessionController.resolveAgent = async () => { f.operations.push('resolveAgent'); return { error: new Error('synthetic resume failure') } }
    await f.adapter.recover()
    const paused = f.store.route('a', '222222')!
    assert.equal(paused.status, 'paused'); assert.equal(paused.sessionId, route.sessionId)
    assert.match(paused.error!, /恢复/)
    assert(!f.operations.includes('notes:sessionState'))
    assert(!f.operations.some(operation => ['create', 'rename', 'prompt'].includes(operation)))
  } finally { await f.close() }
})
