import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
const release=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=process.env.DSH_FEISHU_ROOT
if(!root)throw new Error('DSH_FEISHU_ROOT required')
const validation=spawnSync(process.execPath,[join(release,'scripts/doctor.mjs'),root],{stdio:'inherit'})
if(validation.status!==0)process.exit(validation.status??1)
const state=join(root,'state'),secrets=JSON.parse(readFileSync(join(state,'secrets.json'),'utf8'))
const env={...process.env,...secrets,DSH_HOME:join(state,'dsh'),DSH_AGENTS_HOME:join(state,'empty-agents')}
mkdirSync(env.DSH_AGENTS_HOME,{recursive:true,mode:0o700})
const child=spawn(process.execPath,[join(release,'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--port',process.env.DSH_FEISHU_WEB_PORT??'3188','--no-open'],{cwd:join(state,'workspace'),env,stdio:['ignore','pipe','pipe']})
function log(line){const match=line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\x1b]+/);if(match){writeFileSync(join(state,'web-login-url'),match[0]+'\n',{mode:0o600});console.log('DSH Web ready; login URL saved privately');return}for(const secret of Object.values(secrets))if(typeof secret==='string'&&secret)line=line.split(secret).join('[REDACTED]');console.log(line)}
for(const stream of [child.stdout,child.stderr])createInterface({input:stream}).on('line',log)
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal))
child.on('error',()=>{console.error('DSH launch failed');process.exitCode=1});child.on('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGTERM'?0:1)})
