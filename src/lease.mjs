import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
export async function acquireChannelLease(appId, domain, directory = join(homedir(), '.local/state/dsh-feishu/locks')) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key=createHash('sha256').update(JSON.stringify([domain,appId])).digest('hex'),path=join(directory,key+'.json'),nonce=randomUUID()
  let fd
  try { fd=await open(path,'wx',0o600) } catch(e) { if(e.code==='EEXIST')throw new Error('This app has a local channel lease; stop its consumer or inspect an orphan lease before retrying');throw e }
  try { await fd.writeFile(JSON.stringify({pid:process.pid,nonce,startedAt:new Date().toISOString()})+'\n') } finally { await fd.close() }
  return async()=>{try{if(JSON.parse(await readFile(path,'utf8')).nonce===nonce)await unlink(path)}catch(e){if(e.code!=='ENOENT')throw e}}
}
