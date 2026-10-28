import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const release=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=process.argv[2]
const errors=[]
if(process.platform!=='linux'||process.arch!=='x64')errors.push('Linux x64 required for the bundled runtime')
const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<19))errors.push('Node 22.19+ required')
const lock=JSON.parse(readFileSync(join(release,'upstream.lock.json'),'utf8'))
if(createHash('sha256').update(readFileSync(join(release,'runtime/package-lock.json'))).digest('hex')!==lock.runtimeLockSha256)errors.push('Runtime lock digest mismatch')
if(root){
  try {
    const path=join(root,'state/secrets.json'),secrets=JSON.parse(readFileSync(path,'utf8'))
    if((statSync(path).mode&0o777)!==0o600)errors.push('Secrets mode must be 600')
    if(!secrets.DSH_FEISHU_APP_SECRET||!secrets.DSH_MODEL_API_KEY)errors.push('Required credentials not configured')
    const requireYAML=(await import('node:module')).createRequire(join(release,'runtime/package.json'))
    const patch=requireYAML('yaml').parse(readFileSync(join(root,'state/dsh/profiles/web/cordis.patch.yml'),'utf8'))
    const runner=patch.find(x=>x.id==='sandbox')?.config?.runnerCommand
    const workspace=patch.find(x=>x.id==='dsh-feishu')?.config?.workspace
    const i=runner?.indexOf('--bwrap')
    if(!Array.isArray(runner)||i<0||!existsSync(runner[i+1])||spawnSync(runner[i+1],['--version'],{timeout:10000}).status!==0) {
      errors.push('Configured bubblewrap unavailable')
    } else if(typeof workspace!=='string'||spawnSync(runner[0],[...runner.slice(1),'--ro-bind','/','/','--ro-bind',workspace,workspace,'--','/usr/bin/true'],{cwd:workspace,timeout:10000,stdio:'pipe'}).status!==0) {
      errors.push('Configured sandbox cannot execute a workspace command')
    }
  } catch { errors.push('Instance configuration unavailable') }
}
console.log(JSON.stringify({ok:errors.length===0,errors}));process.exitCode=errors.length?1:0
