import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireChannelLease } from '../src/lease.mjs'
test('one local app can acquire only one channel lease, and release is idempotent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'feishu-lease-'))
 try{const release=await acquireChannelLease('app','feishu',root);await assert.rejects(acquireChannelLease('app','feishu',root),/lease/);await release();await release();const next=await acquireChannelLease('app','feishu',root);await release();await assert.rejects(acquireChannelLease('app','feishu',root),/lease/);await next()}finally{await rm(root,{recursive:true,force:true})}
})
