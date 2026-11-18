import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import { Adapter } from '../src/adapter'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qq-notes-adapter-'))
  const store = new Store(root), sessions = new Map<string, any>(), bindings = new Map<string, any>()
  const invocations: any[] = [], creates: string[] = []
  let failAfterCreate = false, installs = 0
  store.set('config', { port: 18080, mergeWindowSeconds: 20, accounts: [
    { id: 'a', selfId: '111111', name: '仆仆', port: 18081, enabled: true, workspaceId: 'w', roleId: 'notes-role', ownerQQ: '222222' },
  ] })
  const ctx: any = {
    get: () => { throw new Error('Old PuPu service must never be used') },
    pupuNotes: { invoke: async (request: any) => {
      invocations.push(request)
      if (request.action === 'state') return { roles: [{ id: 'notes-role', name: '仆仆', speakerName: '小夫' }] }
      const id = request.input.sessionId
      if (request.action === 'sessionState') return { binding: bindings.get(id) ?? null }
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
        creates.push(sessionId); sessions.set(sessionId, { id: sessionId, status: 'idle', session: { snapshotEvents: () => [] } })
        if (failAfterCreate) throw new Error('Crash after persisted native create')
        return { sessionId }
      },
      inspect: async (id: string) => { if (!sessions.has(id)) throw new Error('not found'); return { meta: { cwd: root }, events: [] } },
      resolveAgent: async (id: string) => ({ agent: sessions.get(id) }),
      rename: async () => {},
    },
  }
  const make = () => new Adapter(ctx, store, {} as any, () => { installs++ })
  let adapter = make()
  return {
    store, ctx, sessions, bindings, invocations, creates, get adapter() { return adapter }, get installs() { return installs },
    failCreate(value: boolean) { failAfterCreate = value },
    async restart() { await adapter.dispose(); adapter = make() },
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
    await f.restart(); f.failCreate(false)
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
