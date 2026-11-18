import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import { Adapter } from '../src/adapter'
test('unapproved senders cannot drive DSH; approved input uses ordinary queue API and stable request IDs', async () => {
  const root=mkdtempSync(join(tmpdir(),'dsh-qq-adapter-')),store=new Store(root),prompts:any[]=[],bindings=new Map()
  const sessions=new Map(),workspaces=new Map([['w1',{id:'w1',path:root,status:async()=>'ok'}]])
  store.set('config',{port:18080,mergeWindowSeconds:0,accounts:[{id:'a',selfId:'111111',name:'A',port:18081,enabled:true,workspaceId:'w1',roleId:'r1',ownerQQ:'222222'}]})
  let installs=0
  const ctx:any={pupuNotes:{invoke:async({action,input}:any)=>{
    if(action==='state')return {roles:[{id:'r1',name:'仆仆',speakerName:'小夫'}]}
    if(action==='sessionState')return {binding:bindings.get(input.sessionId)??null}
    if(action==='bindSession'){const binding={sessionId:input.sessionId,roleId:input.roleId,speakerName:input.speakerName};bindings.set(input.sessionId,binding);return {binding}}
    throw new Error('unexpected notes request')
  }},workspaceRegistry:{get:(id:string)=>workspaces.get(id),archivedSessionIds:[]},agents:{get:(id:string)=>sessions.get(id)},sessionController:{
    create:async({sessionId}:any)=>{sessions.set(sessionId,{id:sessionId,session:{snapshotEvents:()=>[]},options:{}});return {sessionId}},
    inspect:async(id:string)=>{if(!sessions.has(id))throw new Error('not found');return {meta:{cwd:root},events:[]}},
    resolveAgent:async(id:string)=>({agent:sessions.get(id)}),rename:async()=>{},prompt:async(p:any)=>{prompts.push(p);return {accepted:true}},
  }}
  const adapter=new Adapter(ctx,store,{} as any,()=>installs++)
  try {
    const message={account:'a',peer:'222222',id:'1',nickname:'first',segments:[{type:'text',data:{text:'hello'}}]}
    store.receive(message);await adapter.processInbox();assert.equal(prompts.length,0)
    store.admit('a','222222','approved');await adapter.processInbox();assert.equal(prompts.length,1)
    assert.equal(prompts[0].mode,'queue');assert.deepEqual(prompts[0].content,[{type:'text',text:'hello'}])
    const route=store.route('a','222222')!;assert.equal(route.speakerKey,'owner');assert.equal(installs,1)
    store.receive({...message,nickname:'renamed'});await adapter.processInbox();assert.equal(prompts.length,1)
    const inboxKey=String(store.db.prepare('SELECT key FROM inbox').get()!.key)
    store.inState(inboxKey,'received');await adapter.processInbox();assert.equal(prompts[0].requestId,prompts[1].requestId)
    ctx.workspaceRegistry.archivedSessionIds=[route.sessionId]
    store.receive({...message,id:'2'});await adapter.processInbox();assert.equal(store.route('a','222222')!.status,'paused');assert.equal(prompts.length,2)
    assert.equal(sessions.size,1)
  } finally {await adapter.dispose();store.close();rmSync(root,{recursive:true,force:true})}
})
