import { mkdirSync, existsSync, writeFileSync, chmodSync, symlinkSync, realpathSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
const options = Object.fromEntries(process.argv.slice(2).reduce((r,x,i,a)=>i%2?r:[...r,[x.replace(/^--/,''),a[i+1]]],[]))
if (!options.root || !options.config) throw new Error('Usage: node scripts/init.mjs --root PATH --config CONFIG.json [--bwrap PATH]')
const root=resolve(options.root),release=resolve(dirname(fileURLToPath(import.meta.url)),'..'),state=join(root,'state'),profile=join(state,'dsh/profiles/web')
const input=JSON.parse(readFileSync(options.config,'utf8'))
for(const key of ['appId','provider','model','baseURL']) if(typeof input[key]!=='string'||!input[key])throw new Error(`Missing ${key}`)
if(!Array.isArray(input.dmAllowlist)||!input.dmAllowlist.length)throw new Error('Explicit non-empty dmAllowlist required')
if(!['single','orchestrated'].includes(input.conversationMode??'single'))throw new Error('Invalid conversationMode')
if(input.conversationMode==='orchestrated'&&(input.groupPolicy??'disabled')!=='disabled'&&input.groupReplyInThread===false)throw new Error('Native group orchestration requires groupReplyInThread: true')
for(const path of [join(state,'secrets.json'),join(profile,'cordis.patch.yml')])if(existsSync(path))throw new Error('Existing instance; initialization never overwrites private settings')
for(const path of [state,profile,join(state,'workspace'),join(state,'empty-agents')]){mkdirSync(path,{recursive:true,mode:0o700});chmodSync(path,0o700)}
const save=(path,value)=>{writeFileSync(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});chmodSync(path,0o600)}
const current=join(root,'current')
if(!existsSync(current))symlinkSync(release,current,'dir')
const config={appId:input.appId,appSecretRef:'DSH_FEISHU_APP_SECRET',domain:input.domain??'feishu',provider:input.provider,model:input.model,workspace:join(state,'workspace'),stateDir:join(state,'feishu'),dmMode:'allowlist',dmAllowlist:input.dmAllowlist,groupPolicy:input.groupPolicy??'disabled',groupAllowlist:input.groupAllowlist??[],requireMention:true,groupReplyInThread:true,groupThreadAutoReply:true,conversationMode:input.conversationMode??'single',orchestration:input.orchestration,maxTurnMs:0,privateBoundary:true,businessEnabled:true,toolGroups:input.toolGroups??['doc','wiki','drive','chat','bitable','message','minutes','scopes']}
const runner=['/usr/bin/python3',join(current,'scripts/sandbox.py'),'--root',root,'--bwrap',options.bwrap??'/usr/bin/bwrap','--readonly-root',current,'--readonly-root',dirname(realpathSync(process.execPath))]
const patch=[
 {id:'agent-default-model',config:{provider:input.provider,model:input.model}},
 {id:'llm-pi-ai',config:{providers:{[input.provider]:{apiKeyEnv:'DSH_MODEL_API_KEY',baseURL:input.baseURL,api:input.api??'openai-completions',models:[{id:input.model,name:input.model,contextWindow:input.contextWindow??131072,maxTokens:input.maxTokens??8192,input:input.input??['text']}]}}}},
 {id:'skill-filesystem',config:{includeDefaultRoots:false,customSkillDirs:[join(state,'workspace/.agents/skills')]}},
 {id:'sandbox-policy',config:{mode:'workspace-write',workspaceRoot:join(state,'workspace')}},
 {id:'sandbox',config:{runnerCommand:runner,runnerFailureSignatures:['FEISHU_SANDBOX_UNAVAILABLE','bwrap:']}},
 {id:'dsh-feishu',config},
]
save(join(profile,'package.json'),{name:'feishu-bot-profile',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-feishu']}},dependencies:{'dsh-feishu':`file:${current}`}})
save(join(profile,'cordis.patch.yml'),patch)
mkdirSync(join(profile,'node_modules'),{recursive:true});symlinkSync(current,join(profile,'node_modules/dsh-feishu'),'dir')
save(join(state,'secrets.json'),{DSH_FEISHU_APP_SECRET:'',DSH_MODEL_API_KEY:''})
save(join(state,'service.env'),'DSH_FEISHU_ENABLED=1\nDSH_FEISHU_WEB_PORT=3188\n')
save(join(state,'workspace/AGENTS.md'),'# 飞书 Bot 工作区\n\n在本工作区处理附件、运行脚本并生成结果。飞书工具写操作使用确认卡片。不能读取凭据、配置或其他会话私有数据。\n')
console.log(JSON.stringify({initialized:true,root,credentials:'Fill state/secrets.json privately, then run doctor. No secret values are printed.'}))
