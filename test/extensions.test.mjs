import test from 'node:test'
import assert from 'node:assert/strict'
import { ExtensionRegistry } from '../src/contracts/index.mjs'
test('required extension readiness rejects missing, duplicate and incompatible registrations', async () => {
 const r=new ExtensionRegistry(['business'])
 assert.equal(r.isReady,false)
 assert.throws(()=>r.register('wrong',2),/incompatible/)
 await assert.rejects(r.waitReady(5),/not ready/)
 const remove=r.register('business')
 assert.throws(()=>r.register('business'),/duplicate/)
 const ready=r.waitReady(100)
 r.ready('business');await ready;assert.equal(r.isReady,true)
 remove();assert.equal(r.isReady,false)
 assert.equal(r.waiters.size,0)
})
