import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import { Adapter } from '../src/adapter'

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'dsh-qq-adapter-batch-'))
  let now=1000,failAfterAdmission=false,inspectHook=()=>{},downloadHook=()=>{}
  const store=new Store(root,()=>now),prompts:any[]=[],bindings=new Map(),sessions=new Map(),downloads:string[]=[]
  const accounts=['pupu','lulu'].map(id=>({id,selfId:id==='pupu'?'111111':'111112',name:id,port:id==='pupu'?18081:18082,enabled:true,workspaceId:id,roleId:id,ownerQQ:'222222'}))
  store.set('config',{port:18080,mergeWindowSeconds:20,accounts})
  const ctx:any={pupuNotes:{invoke:async({action,input}:any)=>{
    if(action==='state')return {roles:['pupu','lulu'].map(id=>({id,name:id,speakerName:'小夫'}))}
    if(action==='sessionState')return {binding:bindings.get(input.sessionId)??null}
    if(action==='bindSession'){const binding={sessionId:input.sessionId,roleId:input.roleId,speakerName:input.speakerName};bindings.set(input.sessionId,binding);return {binding}}
    throw new Error('unexpected notes request')
  }},workspaceRegistry:{get:(id:string)=>({id,path:root,status:async()=>'ok'}),archivedSessionIds:[]},agents:{get:(id:string)=>sessions.get(id)},attachments:{imageLimits:{maxImageBytes:100000,maxImagesPerMessage:3},validateImage:async()=>{}},sessionController:{
    create:async({sessionId}:any)=>{const events:any[]=[];sessions.set(sessionId,{id:sessionId,status:'idle',events,session:{snapshotEvents:()=>events},options:{}});return {sessionId}},
    inspect:async(id:string)=>{const hook=inspectHook;inspectHook=()=>{};hook();if(!sessions.has(id))throw new Error('not found');return {meta:{cwd:root},events:sessions.get(id).events}},
    resolveAgent:async(id:string)=>({agent:sessions.get(id)}),rename:async()=>{},prompt:async(p:any)=>{prompts.push(p);sessions.get(p.sessionId).events.push({type:'user/message',data:{message:{source:{rpcId:p.requestId}}}});if(failAfterAdmission)throw new Error('synthetic crash after durable admission');return {accepted:true}},
  }}
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
  let adapter=new Adapter(ctx,store,{} as any,()=>{},async(url:any)=>{downloads.push(url);downloadHook();return png})
  const receive=(account:string,peer:string,id:string,image=false,text=id)=>{store.receive({account,peer,id,nickname:'synthetic',segments:[{type:'text',data:{text}},...(image?[{type:'image',data:{url:'https://qpic.cn/synthetic.png'}}]:[])]});store.admit(account,peer,'approved')}
  return {store,prompts,sessions,downloads,receive,setTime:(v:number)=>{now=v},onInspect:(fn:()=>void)=>{inspectHook=fn},onDownload:(fn:()=>void)=>{downloadHook=fn},get adapter(){return adapter},async restart(){await adapter.dispose();adapter=new Adapter(ctx,store,{} as any,()=>{},async()=>{throw new Error('must not redownload admitted image')})},setFail:(v:boolean)=>{failAfterAdmission=v},async close(){await adapter.dispose();store.close();rmSync(root,{recursive:true,force:true})}}
}

test('text/image bursts become one ordered normal DSH input per account/contact',async()=>{
  const f=fixture()
  try {
    f.receive('pupu','222222','first');await f.adapter.processInbox();assert.equal(f.prompts.length,0)
    f.setTime(1800);f.receive('pupu','222222','second',true)
    f.receive('lulu','222222','other-account');f.receive('pupu','333333','other-person')
    f.setTime(21799);await f.adapter.processInbox();assert.equal(f.prompts.length,0)
    f.setTime(21800);await f.adapter.processInbox();assert.equal(f.prompts.length,3)
    const merged=f.prompts.find(p=>p.sessionId===f.store.route('pupu','222222')!.sessionId)
    assert.equal(merged.mode,'queue');assert.equal(merged.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''),'first\uFF0Csecond')
    assert.deepEqual(merged.content.map((p:any)=>p.type),['text','text','text','image'])
    assert.equal(merged.content.at(-1).name,'qq-second')
    assert.equal(new Set(f.prompts.map(p=>p.sessionId)).size,3)
    assert(f.store.inbox().length===0)
  } finally {await f.close()}
})

test('busy conversations retain bursts until idle; other conversations keep working',async()=>{
  const f=fixture()
  try {
    f.receive('pupu','222222','first');f.setTime(21000);await f.adapter.processInbox()
    const agent=f.sessions.get(f.store.route('pupu','222222')!.sessionId);agent.status='running'
    f.setTime(22000);f.receive('pupu','222222','during-one')
    f.setTime(23000);f.receive('pupu','222222','during-two');f.receive('lulu','222222','independent')
    f.setTime(50000);await f.adapter.processInbox();assert.equal(f.prompts.length,2)
    agent.status='idle';await f.adapter.processInbox();assert.equal(f.prompts.length,3)
    assert.equal(f.prompts.at(-1).content.map((p:any)=>p.text??'').join(''),'during-one\uFF0Cduring-two')
  } finally {await f.close()}
})

test('admission crash reuses the sealed batch and does not redownload or regroup new input',async()=>{
  const f=fixture()
  try {
    f.receive('pupu','222222','one',true);f.setTime(1500);f.receive('pupu','222222','two');f.setTime(22000)
    f.setFail(true);await f.adapter.processInbox();assert.equal(f.prompts.length,1)
    const failed=f.store.inbox();assert.equal(failed.length,2);assert(failed.every(i=>i.status==='error'))
    const request=f.prompts[0].requestId
    await f.restart();f.setFail(false)
    const route=f.store.route('pupu','222222')!;f.store.saveRoute({...route,status:'active',error:undefined})
    f.store.inState(failed[0].key,'received');f.receive('pupu','222222','newer')
    await f.adapter.processInbox();assert.equal(f.prompts.length,1)
    assert.equal(f.store.inbox()[0].id,'newer');assert.equal(f.downloads.length,1)
    f.setTime(43000);await f.adapter.processInbox();assert.equal(f.prompts.length,2)
    assert.notEqual(f.prompts.at(-1).requestId,request)
  } finally {await f.close()}
})

test('new input during route preparation extends the quiet window before claiming',async()=>{
  const f=fixture()
  try {
    f.receive('pupu','222222','initial');f.setTime(21000);await f.adapter.processInbox()
    f.setTime(22000);f.receive('pupu','222222','earlier');f.setTime(42000)
    f.onInspect(()=>f.receive('pupu','222222','late'))
    await f.adapter.processInbox();assert.equal(f.prompts.length,1)
    f.setTime(62000);await f.adapter.processInbox();assert.equal(f.prompts.length,2)
    assert.equal(f.prompts.at(-1).content.map((p:any)=>p.text??'').join(''),'earlier\uFF0Clate')
  } finally {await f.close()}
})

test('three messages use Chinese commas only at boundaries and singleton text stays unchanged',async()=>{
  const f=fixture()
  try {
    f.receive('pupu','222222','1',false,'first\nline')
    f.receive('pupu','222222','2',false,'second!')
    f.receive('pupu','222222','3',false,'third')
    f.receive('lulu','222222','single',false,'one\nmessage.')
    f.setTime(21000);await f.adapter.processInbox()
    const text=(account:string)=>f.prompts.find(p=>p.sessionId===f.store.route(account,'222222')!.sessionId).content.map((p:any)=>p.text??'').join('')
    assert.equal(text('pupu'),'first\nline\uFF0Csecond!\uFF0Cthird')
    assert.equal(text('lulu'),'one\nmessage.')
  } finally {await f.close()}
})

test('shutdown during image preparation preserves a received batch instead of pausing it',async()=>{
  const f=fixture()
  try {
    f.receive('pupu','222222','image',true);f.setTime(21000)
    f.onDownload(()=>f.adapter.stop.abort())
    await f.adapter.processInbox()
    assert.equal(f.prompts.length,0)
    assert.equal(f.store.pendingBatches().length,1)
    assert.equal(f.store.inbox()[0].status,'received')
    assert.equal(f.store.route('pupu','222222')!.status,'active')
  } finally {await f.close()}
})
