import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFeishu, baseVersion } from '../src/host.mjs'
function harness(){
 const routes=[],effects=[],tools=[],services=new Map();let connected=0
 const ctx={workspaceRegistry:{create:async()=>{}},attachments:{},llm:{},agents:{},sessions:{},sessionPersistence:{},agentPresets:{},credentials:{resolve:async()=>({value:'SYNTHETIC_SECRET'})},tools:{register:x=>tools.push(x)},shellEnv:{register(){}},connection:{requestRejection:()=>undefined},webServer:{register:x=>{routes.push(x);return ()=>{}}},on:()=>()=>{},effect(fn){const result=fn();if(typeof result==='function')effects.push(result)},provide:(k,v)=>services.set(k,v),logger:{info(){}}}
 const channel={rawClient:{},on(){},connect:async()=>{connected++},disconnect:async()=>{}}
 const deps={createLarkChannel:()=>channel,Domain:{Feishu:'feishu',Lark:'lark'},LoggerLevel:{error:0},installModelSelection(){},createUserMessage:x=>x,SessionId:x=>x,credentialRef:x=>x}
 return {ctx,deps,routes,tools,services,get connected(){return connected},dispose:async()=>{for(const fn of effects.reverse())await fn()}}
}
test('standalone host starts with a neutral application and exposes authenticated status without business imports',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'feishu-host-')),f=harness()
 try{
  const runtime=await startFeishu(f.ctx,{appId:'synthetic',workspace:dir,stateDir:dir,provider:'p',model:'m',businessEnabled:true,privateBoundary:true},{enabled:false},f.deps)
  await runtime.whenReady
  assert.equal(f.tools.length,16);assert.equal(f.services.get('dshFeishu'),runtime);assert.equal(f.connected,0)
  const route=f.routes.find(x=>x.path==='/feishu/api/status');assert.ok(route)
  let result;await route.handler({url:route.path,method:'GET'},{writeHead(){},end(value){result=JSON.parse(value)}})
  assert.equal(result.baseVersion,baseVersion);assert.equal(result.ready,true);assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'),false)
 }finally{await f.dispose();await rm(dir,{recursive:true,force:true})}
})
test('missing required extensions prevent a channel connection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'feishu-missing-')),f=harness()
 try{
  const runtime=await startFeishu(f.ctx,{appId:'synthetic',workspace:dir,stateDir:dir,provider:'p',model:'m',extensionTimeoutMs:20},{enabled:true,requiredExtensions:['missing']},f.deps)
  // Publishing the service must finish before an injecting business plugin runs.
  assert.equal(f.services.get('dshFeishu'),runtime)
  const route=f.routes.find(x=>x.path==='/feishu/api/probe');let code
  await route.handler({url:route.path,method:'POST'},{writeHead(c){code=c},end(){}})
  assert.equal(code,503)
  await assert.rejects(runtime.whenReady,/not ready/)
  assert.equal(f.connected,0)
 }finally{await f.dispose();await rm(dir,{recursive:true,force:true})}
})

test('native DSH plugin entry returns only its supported lifecycle result', {skip:process.platform!=='linux'}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'feishu-native-entry-')),f=harness(),before=process.env.DSH_FEISHU_ENABLED
 try{
  process.env.DSH_FEISHU_ENABLED='0'
  const {apply}=await import('../src/index.mjs')
  assert.equal(await apply(f.ctx,{appId:'synthetic',workspace:dir,stateDir:dir,provider:'p',model:'m'}),undefined)
 }finally{if(before===undefined)delete process.env.DSH_FEISHU_ENABLED;else process.env.DSH_FEISHU_ENABLED=before;await f.dispose();await rm(dir,{recursive:true,force:true})}
})

test('an extension can become ready after host activation; loss suspends probes until restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'feishu-lifecycle-')),f=harness()
 try{
  const runtime=await startFeishu(f.ctx,{appId:'synthetic',workspace:dir,stateDir:dir,provider:'p',model:'m'},{enabled:false,requiredExtensions:['business']},f.deps)
  const unregister=runtime.extensions.register('business');runtime.extensions.ready('business');await runtime.whenReady
  async function status(){let value;const route=f.routes.find(x=>x.path==='/feishu/api/status');await route.handler({url:route.path,method:'GET'},{writeHead(){},end(v){value=JSON.parse(v)}});return value}
  assert.equal((await status()).ready,true)
  unregister();assert.equal((await status()).ready,false)
  runtime.extensions.register('business');runtime.extensions.ready('business')
  assert.equal((await status()).ready,false);assert.equal((await status()).needsRestart,true)
 }finally{await f.dispose();await rm(dir,{recursive:true,force:true})}
})
