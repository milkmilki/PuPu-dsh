import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import WebSocket from 'ws'
import { writeFile, readFile, mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
export const inject: string[] = []
const root = process.env.DSH_QQ_ACCEPTANCE!
let releaseBusy: (() => void) | undefined
class Synthetic extends LlmAdapter {
  providerInfo(provider: string) { return {id:provider,name:'QQ bridge synthetic test'} }
  async listModels(provider: string) { return [{provider,id:'synthetic',name:'Synthetic (no network)'},{provider,id:'text-only',name:'Text only'}] }
  async resolveModel(provider: string, id: string) { return {provider,id,name:id,context:{contextWindow:128000},defaultMaxTokens:8192,inputModalities:(id==='text-only'?['text']:['text','image']) as ('text'|'image')[]} }
  async *stream(options: any): AsyncGenerator<any> {
    await appendFile(join(root,'model-calls.jsonl'),JSON.stringify(options)+'\n')
    const lastUser = options.messages.findLastIndex((m: any) => m.role === 'user' && m.source?.kind === 'user')
    const user = JSON.stringify(options.messages[lastUser]?.content), tools = options.messages.slice(lastUser+1).filter((m: any)=>m.role==='tool')
    if (!options.system && user.includes('BATCH_BUSY')) await new Promise<void>(resolve => { releaseBusy=resolve })
    if (!options.system && user.includes('READ_FLOW') && tools.length < 3) {
      const name = ['read','edit','pwsh'][tools.length]
      const args = name === 'read' ? {file_path:join(root,'workspaces','pupu','value.txt')} : name==='edit' ? {file_path:join(root,'workspaces','pupu','value.txt'),old_string:'before',new_string:'after'} : {command:"if ((Get-Content -Raw -LiteralPath './value.txt').Trim() -ne 'after') { throw 'failed' }; Write-Output 'QQ_FILE_VERIFIED'",workdir:join(root,'workspaces','pupu'),description:'Verify bridge fixture'}
      const block={type:'tool-call',id:`fixture-${tools.length}`,name,arguments:JSON.stringify(args)}
      yield {type:'block-start',index:0,blockType:'text'}; yield {type:'text-delta',index:0,text:'INTERMEDIATE_NOT_FOR_QQ'};yield {type:'block-end',index:0,block:{type:'text',text:'INTERMEDIATE_NOT_FOR_QQ'}}
      yield {type:'block-start',index:1,blockType:'tool-call'};yield {type:'tool-call-delta',index:1,id:block.id,name,argumentsDelta:block.arguments};yield {type:'block-end',index:1,block};yield {type:'finish',reason:{kind:'tool-calls'}};return
    }
    if (!options.system && user.includes('SEND_IMAGE') && tools.length < 1) {
      const block={type:'tool-call',id:`image-${options.messages[lastUser].id}`,name:'qq_send_image',arguments:JSON.stringify({file_path:join(root,'workspaces','pupu','pixel.png')})}
      yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};return
    }
    const text = options.system ? 'Synthetic helper' : `FINAL ${user.includes('READ_FLOW') ? 'READ_FLOW' : user.includes('WEB_FLOW') ? 'WEB_FLOW' : 'QQ_FLOW'}`
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
  }
}
export function apply(ctx: any) {
  void writeFile(join(root,'fixture-loaded.json'),JSON.stringify({loaded:true}))
  ctx.inject(['llm'], (child:any) => { child.llm.registerAdapter(['qq-fixture'],new Synthetic()) })
  ctx.inject(['llm','agents','sessionController','workspaceRegistry','pupu','qqBridge','tools','connection','approval','attachments'],(child:any)=>{
    void writeFile(join(root,'browser-url.txt'),child.connection.authenticatedUrl('http://127.0.0.1:3095'))
    const timer=setTimeout(()=>void run(child).catch(async e=>{await writeFile(join(root,'result.json'),JSON.stringify({passed:false,error:String(e),stack:e.stack},null,2))}),1500)
    return ()=>clearTimeout(timer)
  })
}
const wait = async(fn:()=>boolean|Promise<boolean>,label:string)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,200))}throw new Error(`Timeout: ${label}`)}
async function run(ctx: any) {
  const bridge=ctx.get('qqBridge'), pupu=ctx.get('pupu'), sockets:WebSocket[]=[], actions:any[]=[]
  if (await readFile(join(root,'result.json')).then(()=>true).catch(()=>false)) { await restart(ctx); return }
  const roles:any[]=[]
  for(const name of ['合成仆仆','合成璐璐'])roles.push(await pupu.request({action:'create',args:{name,persona:'用于 QQ 桥接隔离测试的合成人设。'}}))
  await bridge.request({action:'create_workspaces',args:{root:join(root,'workspaces')}})
  const config=bridge.store.config()
  config.mergeWindowSeconds=0
  config.accounts.forEach((a:any,i:number)=>Object.assign(a,{enabled:true,selfId:String(111111+i),roleId:roles[i].id,ownerQQ:'222222'}))
  await bridge.request({action:'save',args:{config,secrets:{pupu:'fixture-token-pupu-001',lulu:'fixture-token-lulu-001'}}})
  await mkdir(join(root,'workspaces','pupu'),{recursive:true});await writeFile(join(root,'workspaces','pupu','value.txt'),'before\n')
  for(const a of config.accounts){
    const ws=new WebSocket(`ws://127.0.0.1:${a.port}/onebot/v11/ws`,{headers:{Authorization:`Bearer fixture-token-${a.id}-001`,'X-Self-ID':a.selfId}})
    await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});sockets.push(ws)
    ws.on('message',raw=>{const value=JSON.parse(raw.toString());actions.push({account:a.id,...value});ws.send(JSON.stringify({status:'ok',retcode:0,echo:value.echo,data:{message_id:actions.length+100}}))})
  }
  const send=(i:number,peer:number,id:number,text:string)=>sockets[i].send(JSON.stringify({post_type:'message',message_type:'private',self_id:Number(config.accounts[i].selfId),user_id:peer,message_id:id,sender:{nickname:`synthetic-${peer}`},message:[{type:'text',data:{text}}]}))
  try {
    send(0,222222,1,'READ_FLOW');send(0,222222,1,'READ_FLOW');send(1,222222,1,'QQ_FLOW')
    await wait(()=>bridge.store.contacts().length===2,'pending contacts')
    assert.equal(bridge.store.routes().length,0);assert.equal(actions.length,0)
    for(const a of config.accounts)await bridge.request({action:'approve',args:{account:a.id,peer:'222222',sharedMemoryConfirmed:true}})
    await wait(()=>bridge.store.outgoing().filter((r:any)=>r.status==='sent').length>=2,'QQ replies')
    const r1=bridge.store.route('pupu','222222'),r2=bridge.store.route('lulu','222222')
    assert.notEqual(r1.sessionId,r2.sessionId)
    const a1=ctx.agents.get(r1.sessionId)
    await writeFile(join(root,'events.json'),JSON.stringify(a1.session.snapshotEvents(),null,2))
    assert.equal((await readFile(join(root,'workspaces','pupu','value.txt'),'utf8')).trim(),'after')
    const results=a1.session.snapshotEvents().filter((e:any)=>e.type==='tool/result')
    assert.equal(results.length,3);assert(results.every((e:any)=>!JSON.stringify(e.data).includes('"isError":true')))
    assert(!JSON.stringify(actions).includes('INTERMEDIATE_NOT_FOR_QQ'))
    await ctx.sessionController.prompt({sessionId:r1.sessionId,requestId:'web-input-test',mode:'queue',content:[{type:'text',text:'WEB_FLOW'}]},new AbortController().signal)
    await wait(()=>actions.some(a=>JSON.stringify(a).includes('FINAL WEB_FLOW')),'Web final forwarded')
    send(0,333333,2,'QQ_FLOW')
    await wait(()=>bridge.store.contacts().length===3,'third contact')
    await bridge.request({action:'approve',args:{account:'pupu',peer:'333333',sharedMemoryConfirmed:true}})
    await wait(()=>bridge.store.outgoing().filter((r:any)=>r.status==='sent').length>=4,'third reply')
    const r3=bridge.store.route('pupu','333333');assert.notEqual(r1.sessionId,r3.sessionId);assert.notEqual(r3.speakerKey,'owner')
    const before=actions.length
    await bridge.adapter.recover();send(0,222222,1,'READ_FLOW');await bridge.tick()
    assert.equal(bridge.store.route('pupu','222222').sessionId,r1.sessionId);assert.equal(actions.length,before)
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
    await writeFile(join(root,'workspaces','pupu','pixel.png'),png)
    const imageResult=await ctx.tools.execute({name:'qq_send_image',callId:'fixture-image-send',arguments:{file_path:join(root,'workspaces','pupu','pixel.png')},agent:a1,signal:new AbortController().signal})
    assert(!imageResult.isError,JSON.stringify(imageResult))
    assert(actions.some(a=>a.params.message[0].type==='image'))
    const deny=a1.ctx.tools.guard((exec:any)=>exec.name==='read_image'?'Synthetic existing DSH read denial':undefined)
    const beforeDenied=actions.length
    const denied=await ctx.tools.execute({name:'qq_send_image',callId:'fixture-image-denied',arguments:{file_path:join(root,'workspaces','pupu','pixel.png')},agent:a1,signal:new AbortController().signal})
    assert(denied.isError);assert.equal(actions.length,beforeDenied);deny()
    let decision='ask',answer='rejected'
    const pre=a1.ctx.on('tools/pre-execute',(exec:any,next:any)=>exec.name==='read_image'?Promise.resolve({kind:decision,reason:'Synthetic permission test'}):next())
    const approval=ctx.on('approval/request',(req:any,next:any)=>req.agent.id===a1.id?Promise.resolve(answer):next(),true)
    ctx.approval.setPolicy(a1,'ask')
    for(const expected of ['rejected','cancelled','allowed-once']){
      answer=expected
      await ctx.sessionController.prompt({sessionId:r1.sessionId,requestId:`fixture-approval-${expected}`,mode:'queue',content:[{type:'text',text:`SEND_IMAGE ${expected}`}]},new AbortController().signal)
      await a1.whenIdle()
      const decisions=a1.session.snapshotEvents().filter((e:any)=>e.type==='approval/decided')
      assert.equal(decisions.at(-1)?.data.outcome,expected)
    }
    pre();approval();ctx.approval.setPolicy(a1,'never')
    // The transport download is simulated; actual DSH attachment admission and input are not.
    bridge.adapter.download=async()=>png
    const imageMessage={post_type:'message',message_type:'private',self_id:111111,user_id:222222,message_id:3,message:[{type:'image',data:{url:'https://qpic.cn/synthetic.png'}}]}
    const sentBeforeImage=bridge.store.outgoing().filter((r:any)=>r.status==='sent').length
    sockets[0].send(JSON.stringify(imageMessage))
    await wait(()=>bridge.store.db.prepare("SELECT status FROM inbox WHERE account='pupu' AND json_extract(value,'$.id')='3'").get()?.status==='accepted','image admitted')
    await a1.whenIdle()
    await wait(()=>bridge.store.outgoing().filter((r:any)=>r.status==='sent').length>sentBeforeImage,'inbound image reply')
    assert(a1.session.snapshotEvents().some((e:any)=>e.type==='user/message' && (e.data.message?.content??e.data.content)?.some((p:any)=>p.type==='image')))
    await assert.rejects(()=>ctx.attachments.validateImage({data:png.subarray(0,12),mediaType:'image/png'}))
    await assert.rejects(()=>ctx.attachments.validateImage({data:Buffer.alloc(ctx.attachments.imageLimits.maxImageBytes+1),mediaType:'image/png'}))
    await ctx.sessionController.selectModel({sessionId:r1.sessionId,provider:'qq-fixture',model:'text-only'})
    sockets[0].send(JSON.stringify({...imageMessage,message_id:4}))
    await wait(()=>bridge.store.inbox().some((r:any)=>r.id==='4' && r.status==='error'),'unsupported image model rejected')
    assert(bridge.store.inbox().find((r:any)=>r.id==='4').error.includes('不支持图片'))
    await ctx.sessionController.selectModel({sessionId:r1.sessionId,provider:'qq-fixture',model:'synthetic'})
    await bridge.request({action:'discard_input',args:{key:bridge.store.inbox().find((r:any)=>r.id==='4').key}})
    await bridge.request({action:'resume',args:{account:'pupu',peer:'222222'}})
    const batching=await batchingFlow(ctx,bridge,sockets,send)
    await writeFile(join(root,'events.json'),JSON.stringify(a1.session.snapshotEvents(),null,2))
    await writeFile(join(root,'actions.json'),JSON.stringify(actions,null,2))
    await writeFile(join(root,'result.json'),JSON.stringify({passed:true,syntheticOneBot:true,realDsh:true,realQQ:false,paidModelCalls:0,twoAccountsDistinctSessions:true,twoContactsDistinctSessions:true,ownerMapping:true,normalSessionApi:true,tools:['read','edit','pwsh','read_image','qq_send_image'],webFinalForwarded:true,intermediateFiltered:true,duplicatesFiltered:true,imageAttachmentAdmission:true,imageDownloadSimulated:true,imageSendThroughDshRead:true,nestedReadDenialHonored:true,approvalPipeline:['rejected','cancelled','allowed-once'],approvalAnswererSynthetic:true,unsupportedImageModelRejected:true,batching,routes:bridge.store.routes()},null,2))
  } finally {for(const ws of sockets)ws.terminate()}
}
async function batchingFlow(ctx:any,bridge:any,sockets:WebSocket[],send:any) {
  const route=bridge.store.route('lulu','222222'),agent=ctx.agents.get(route.sessionId)
  const userMessages=()=>agent.session.snapshotEvents().filter((e:any)=>e.type==='user/message')
  const text=(e:any)=>(e.data.message?.content??e.data.content??[]).filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('')
  const save=async(seconds:number)=>{
    const bot=bridge.gateway.bots.get('lulu')
    await bridge.request({action:'save',args:{config:{...bridge.store.config(),mergeWindowSeconds:seconds}}})
    assert.equal(bridge.gateway.bots.get('lulu'),bot,'timing-only save must not restart QQ connections')
    assert(sockets.every(s=>s.readyState===WebSocket.OPEN))
  }
  await agent.whenIdle();await save(20)
  const before=userMessages().length,start=Date.now()
  send(1,222222,1100,'BATCH_ONE')
  sockets[1].send(JSON.stringify({post_type:'message',message_type:'private',self_id:111112,user_id:222222,message_id:1101,message:[{type:'image',data:{url:'https://qpic.cn/synthetic-burst.png'}}]}))
  send(1,222222,1102,'BATCH_TWO');send(1,222222,1102,'BATCH_TWO')
  await new Promise(r=>setTimeout(r,1000));assert.equal(userMessages().length,before)
  await wait(()=>userMessages().length===before+1,'20-second text/image burst admission')
  assert(Date.now()-start>=20000)
  const merged=userMessages().at(-1)
  assert.equal(text(merged),'BATCH_ONE\uFF0C\uFF0CBATCH_TWO')
  assert.equal((merged.data.message?.content??merged.data.content).filter((p:any)=>p.type==='image').length,1)
  await agent.whenIdle();await save(0)
  await ctx.sessionController.prompt({sessionId:route.sessionId,requestId:'batch-busy-web',mode:'queue',content:[{type:'text',text:'BATCH_BUSY'}]},new AbortController().signal)
  await wait(()=>!!releaseBusy,'synthetic blocked model turn');await save(0.25)
  send(1,222222,1110,'BUSY_ONE');send(1,222222,1111,'BUSY_TWO')
  await new Promise(r=>setTimeout(r,1500));assert.equal(bridge.store.pending().filter((i:any)=>i.account==='lulu').length,2)
  releaseBusy!();releaseBusy=undefined
  await wait(()=>userMessages().some((e:any)=>text(e)==='BUSY_ONE\uFF0CBUSY_TWO'),'busy accumulation delivered after idle')
  await agent.whenIdle();await save(20)
  await wait(()=>bridge.store.outgoing().every((o:any)=>o.status==='sent')&&bridge.store.route('lulu','222222').watermark>=agent.session.snapshotEvents().filter((e:any)=>e.type==='turn/end').at(-1).seq,'all prior turns captured and sent')
  // Freeze one durable batch before stopping the isolated process.
  bridge.updating=true
  send(1,222222,1120,'RESTART_ONE');send(1,222222,1121,'RESTART_TWO')
  await wait(()=>bridge.store.pending().filter((i:any)=>i.account==='lulu').length===2,'restart batch input persisted')
  const sealed=bridge.store.sealBatch(bridge.store.pending().filter((i:any)=>i.account==='lulu'),route.sessionId)
  await writeFile(join(root,'batching-events.json'),JSON.stringify(agent.session.snapshotEvents(),null,2))
  return {twentySecondQuietWindow:true,textAndImageOneInput:true,duplicateEventIgnored:true,busyInputMerged:true,timingSaveKeptSockets:true,restartBatchKey:sealed.key}
}
async function restart(ctx:any) {
  if(await readFile(join(root,'restart-result.json')).then(()=>true).catch(()=>false))return
  const original=JSON.parse(await readFile(join(root,'result.json'),'utf8'))
  if(!original.passed)return
  const bridge=ctx.get('qqBridge'), routes=bridge.store.routes(), config=bridge.store.config(), received:any[]=[]
  assert.deepEqual(routes.map((r:any)=>r.sessionId),original.routes.map((r:any)=>r.sessionId))
  const account=config.accounts.find((a:any)=>a.id==='lulu')
  const ws=new WebSocket(`ws://127.0.0.1:${account.port}/onebot/v11/ws`,{headers:{Authorization:'Bearer fixture-token-lulu-001','X-Self-ID':account.selfId}})
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)})
  ws.on('message',raw=>{const action=JSON.parse(raw.toString());received.push(action);ws.send(JSON.stringify({status:'ok',retcode:0,echo:action.echo,data:{message_id:900+received.length}}))})
  const event={post_type:'message',message_type:'private',self_id:Number(account.selfId),user_id:222222,sender:{nickname:'renamed-after-restart'},message:[{type:'text',data:{text:'QQ_FLOW'}}]}
  try{
    await wait(()=>received.length===1,'persisted sealed batch replied after restart')
    const agent=ctx.agents.get(bridge.store.route('lulu','222222').sessionId)
    const recovered=agent.session.snapshotEvents().filter((e:any)=>e.type==='user/message'&&(e.data.message?.source??e.data.source)?.rpcId===`dsh-qq:${original.batching.restartBatchKey}`)
    assert.equal(recovered.length,1)
    ws.send(JSON.stringify({...event,message_id:1}))
    await new Promise(r=>setTimeout(r,300));await bridge.tick();assert.equal(received.length,1)
    ws.send(JSON.stringify({...event,message_id:999}))
    await wait(()=>received.length===2,'reply after process restart')
    assert.equal(bridge.store.routes().length,original.routes.length)
    assert.deepEqual(bridge.store.routes().map((r:any)=>r.sessionId),original.routes.map((r:any)=>r.sessionId))
    await writeFile(join(root,'restart-result.json'),JSON.stringify({passed:true,actualProcessRestart:true,persistedRoutesReused:true,oldInputNotReplayed:true,oldRepliesNotReplayed:true,newInputReplied:true,sealedBatchRecoveredOnce:true,realQQ:false},null,2))
  }finally{ws.terminate()}
}
