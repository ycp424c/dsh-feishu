import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeishuTools, toolCatalog } from '../src/business/index.mjs'
test('neutral catalog has 16 generic tools and module selection does not load business tools',()=>{
 const catalog=toolCatalog().map(x=>typeof x==='function'?x({}):x)
 assert.equal(catalog.length,16);assert.equal(catalog.some(x=>/requirement/.test(x.name)),false)
 const tools=new FeishuTools({config:{toolGroups:['minutes']}})
 assert.deepEqual(tools.definitions().map(x=>x.name),['feishu_minutes'])
 assert.throws(()=>new FeishuTools({config:{toolGroups:['typo']}}),/Invalid/)
})
test('a workflow grant binds the original runtime turn and cannot be forged or retained',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'feishu-grant-')),agent={},turn={senderId:'ou_user',message:{messageId:'m'},controller:new AbortController()}
 let active=turn,calls=0
 const tool={name:'sample_write',description:'sample',parameters:{type:'object',properties:{}},execute:async()=>{calls++;return {details:{ok:true}}}}
 const executor=new FeishuTools({client:()=>({}),runningForAgent:()=>active,approvals:{request:async()=> 'allowed-once'},catalog:[tool],config:{workspace:dir,stateDir:dir}})
 try{
  await executor.load()
  await assert.rejects(executor.performWrite('sample_write',{},turn,undefined,'forged'),/capability/)
  const grant=await executor.approveWorkflow({agent,toolName:'sample_write'})
  assert.equal((await grant.performWrite('sample_write',{},turn,undefined,'one',undefined,undefined,async()=>({verified:true}))).readback.verified,true)
  grant.dispose();await assert.rejects(grant.performWrite('sample_write',{},turn,undefined,'two'),/capability/)
  const next=await executor.approveWorkflow({agent,toolName:'sample_write'});active={...turn}
  await assert.rejects(next.performWrite('sample_write',{},turn,undefined,'three'),/capability/)
  assert.equal(calls,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('policies run again at dispatch after approval and can prevent all external writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'feishu-policy-')),agent={},turn={senderId:'ou_user',message:{messageId:'m'}}
 let deny=false,calls=0
 const tool={name:'sample_write',description:'sample',parameters:{type:'object',properties:{}},execute:async()=>{calls++;return {details:{ok:true}}}}
 const executor=new FeishuTools({client:()=>({}),runningForAgent:()=>turn,approvals:{request:async()=>{deny=true;return 'allowed-once'}},catalog:[tool],policies:[()=>{if(deny)throw Error('target changed')}],config:{workspace:dir,stateDir:dir}})
 try{await executor.load();await assert.rejects(executor.execute('sample_write',{},{agent}),/target changed/);assert.equal(calls,0)}finally{await rm(dir,{recursive:true,force:true})}
})

test('extension registration rejects duplicates and disposes without removing replacements',()=>{
 const operations=new FeishuTools({client:()=>({}),runningForAgent:()=>null,approvals:{},config:{workspace:'/tmp',stateDir:'/tmp'}})
 const factory={name:'custom_write',parameters:{type:'object'},execute(){}}
 const remove=operations.registerTool(factory,()=>({ok:true}),{before:'feishu_minutes'})
 assert.equal(operations.definitions().at(-2).name,'custom_write')
 assert.throws(()=>operations.registerTool(factory),/Duplicate/)
 remove();operations.registerTool(factory);remove()
 assert.ok(operations.make('custom_write'))
 assert.equal(operations.handlers.custom_write,undefined)
})
