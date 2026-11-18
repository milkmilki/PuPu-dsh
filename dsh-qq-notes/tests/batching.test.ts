import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readyBatch } from '../src/batching'
import { Store } from '../src/store'
import type { Inbox } from '../src/types'

const item = (id: number, receivedAt?: number, images = 0): Inbox => ({ account:'pupu',peer:'222222',id:String(id),key:String(id),nickname:'synthetic',status:'received',receivedAt,segments:[{type:'text',data:{text:`part ${id}`}},...Array.from({length:images},()=>({type:'image',data:{url:'https://qpic.cn/synthetic.png'}}))] })

test('quiet window extends only for new messages and becomes ready after 20 seconds', () => {
  const items=[item(1,1000),item(2,18000)]
  assert.equal(readyBatch(items,21000,20,10), undefined)
  assert.equal(readyBatch(items,37999,20,10), undefined)
  assert.deepEqual(readyBatch(items,38000,20,10),items)
  assert.deepEqual(readyBatch([item(1,1000),item(2,22000)],23000,20,10),[item(1,1000)])
})

test('continuous input seals after 60 seconds or 20 messages without losing later messages', () => {
  const continuous=Array.from({length:8},(_,i)=>item(i,i*10000+1000))
  assert.deepEqual(readyBatch(continuous,71000,20,10),continuous.slice(0,6))
  const rapid=Array.from({length:21},(_,i)=>item(i,1000+i))
  assert.deepEqual(readyBatch(rapid,1021,20,10),rapid.slice(0,20))
})

test('zero disables merging, old timestamp-less input stays singleton and image limits split batches', () => {
  assert.deepEqual(readyBatch([item(1,1000),item(2,1001)],1001,0,10),[item(1,1000)])
  assert.deepEqual(readyBatch([item(1),item(2)],100000,20,10),[item(1)])
  assert.deepEqual(readyBatch([item(1,1000,2),item(2,1001,2)],1002,20,3),[item(1,1000,2)])
  assert.deepEqual(readyBatch([item(1,90000)],1000,20,10),[item(1,90000)])
})

test('text payload limits split without dropping or truncating a message', () => {
  const first=item(1,1000),second=item(2,1001)
  first.segments=[{type:'text',data:{text:'a'.repeat(180000)}}]
  second.segments=[{type:'text',data:{text:'b'.repeat(180000)}}]
  assert.deepEqual(readyBatch([first,second],1002,20,10),[first])
})

test('sealed input membership, timestamps and request keys survive restart and retry', () => {
  const root=mkdtempSync(join(tmpdir(),'dsh-qq-batches-'))
  let now=1000,store=new Store(root,()=>now)
  try {
    const incoming=(id:string)=>({account:'pupu',peer:'222222',id,nickname:'synthetic',segments:[{type:'text',data:{text:id}}]})
    store.receive(incoming('one'));store.admit('pupu','222222','approved')
    now=1500;assert.equal(store.receive(incoming('one')),false)
    now=1800;store.receive(incoming('two'))
    assert.deepEqual(store.pending().map(i=>i.receivedAt),[1000,1800])
    const batch=store.sealBatch(store.pending(),'session-synthetic')
    assert.equal(store.pending().length,0)
    store.inState(batch.items[0].key,'error','synthetic error')
    assert(store.inbox().every(i=>i.status==='error'&&i.batchSize===2))
    store.inState(batch.items[1].key,'received')
    store.close();store=new Store(root,()=>now)
    const restored=store.pendingBatches()[0]
    assert.equal(restored.key,batch.key)
    assert.equal(restored.sessionId,'session-synthetic')
    assert.deepEqual(restored.items.map(i=>i.id),['one','two'])
    store.receive(incoming('three'))
    assert.deepEqual(store.pending().map(i=>i.id),['three'])
    store.inState(restored.items[0].key,'accepted')
    assert.equal(store.pendingBatches().length,0)
    assert.deepEqual(store.inbox().map(i=>i.id),['three'])
    const single=store.sealBatch(store.pending(),'session-synthetic')
    assert.equal(single.key,single.items[0].key)
    store.inState(single.items[0].key,'discarded')
    assert.equal(store.inbox().length,0)
  } finally {store.close();rmSync(root,{recursive:true,force:true})}
})

test('upgraded inbox keeps the old six-column insert format usable for rollback', () => {
  const root=mkdtempSync(join(tmpdir(),'dsh-qq-old-inbox-')),store=new Store(root)
  try {
    const old=item(1);delete old.receivedAt
    store.set('config',{...store.config(),mergeWindowSeconds:5})
    assert.equal(store.config().mergeWindowSeconds,5)
    assert.equal(Object.hasOwn(store.setting('config'),'mergeWindowSeconds'),false)
    store.db.prepare('INSERT INTO contacts VALUES (?,?,?,?)').run(old.account,old.peer,old.nickname,'pending')
    store.db.prepare('INSERT INTO inbox VALUES (?,?,?,?,?,?)').run('old-key',old.account,old.peer,JSON.stringify(old),'received',null)
    store.admit(old.account,old.peer,'approved')
    assert.equal(store.pending()[0].receivedAt,undefined)
  } finally {store.close();rmSync(root,{recursive:true,force:true})}
})
