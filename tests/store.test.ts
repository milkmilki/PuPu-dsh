import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'

test('stable contact identity, admission, durable dedup and uncertain sends', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qq-'))
  let store = new Store(root)
  try {
    const message = { account: 'pupu', peer: '123456', id: '77', nickname: 'A', segments: [{ type: 'text', data: { text: 'hello' } }] }
    assert.equal(store.receive(message), true)
    assert.equal(store.receive({ ...message, nickname: 'renamed' }), false)
    assert.equal(store.contact('pupu', '123456')?.status, 'pending')
    assert.equal(store.pending().length, 0)
    store.admit('pupu', '123456', 'approved')
    assert.equal(store.pending().length, 1)
    store.saveRoute({ account: 'pupu', peer: '123456', sessionId: 's1', workspaceId: 'w1', roleId: 'r1', speakerKey: 'qq1', status: 'active', watermark: 0 })
    assert.equal(store.route('pupu', '123456')?.sessionId, 's1')
    assert.equal(store.route('lulu', '123456'), undefined)
    assert.throws(() => store.saveRoute({ account: 'lulu', peer: '654321', sessionId: 's1', workspaceId: 'w2', roleId: 'r2', speakerKey: 'qq2', status: 'active', watermark: 0 }))
    assert.equal(store.enqueue('out1', 'pupu', '123456', [{ type: 'text', data: { text: 'reply' } }]), true)
    assert.equal(store.enqueue('out1', 'pupu', '123456', []), false)
    store.outState('out1', 'sending')
    store.close(); store = new Store(root)
    assert.equal(store.outgoing()[0].status, 'uncertain')
    assert.equal(store.route('pupu', '123456')?.sessionId, 's1')
    store.outState('out1', 'sent', '88')
    assert.equal(store.unsent().length, 0)
    assert.equal(store.receive({ ...message, id: '78', account: 'lulu' }), true)
    store.receive({ ...message, id: '79' })
    const first=store.pending().find(i=>i.id==='77')!
    store.inState(first.key,'error','synthetic download failure')
    assert.equal(store.pending().filter(i=>i.account==='pupu').length,0)
    store.inState(first.key,'discarded')
    assert.equal(store.pending().filter(i=>i.account==='pupu').length,1)
    store.enqueue('uncertain','pupu','123456',[]);store.outState('uncertain','uncertain')
    store.enqueue('later','pupu','123456',[])
    assert.equal(store.unsent().length,0)
    store.outState('uncertain','sent','manually-confirmed')
    assert.equal(store.unsent()[0].key,'later')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
