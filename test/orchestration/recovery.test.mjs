import test from 'node:test'
import assert from 'node:assert/strict'
import { host, text, until } from './harness.mjs'
import { conversationKey } from '../../src/policy.mjs'

test('shutdown revokes and drains every conversation even when task persistence fails', { timeout: 15000 }, async () => {
  const holds = [], parents = [], children = []
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      const hold = Promise.withResolvers(); holds.push(hold)
      await Promise.race([hold.promise, new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))])
    }
    return text('ready')
  })
  const save = app.state.save.bind(app.state)
  try {
    for (const id of ['first', 'second']) {
      const message = app.message('start', { chatId: `chat-${id}`, senderId: `user-${id}` })
      await app.bridge.enqueue(message, ticket => app.bridge.reply(message, ticket))
      const parent = (await app.bridge.get(conversationKey(message))).agent
      await parent.whenIdle(); parents.push(parent)
      children.push((await app.ctx.orchestrator.delegate(parent, { label: id, task: 'wait' }, new AbortController().signal)).childId)
    }
    await until(() => holds.length === 2, 'both workers execute')
    const roles = parents.map(parent => app.ctx.orchestrator.roleOf(parent))
    app.state.save = async () => { throw new Error('Synthetic persistence failure') }
    await assert.rejects(app.bridge.dispose(), /编排停机清理失败/)
    assert.ok(roles.every(role => role.revoked), 'all roots lose tool authorization')
    assert.ok(children.every(id => !app.ctx.agents.get(id)), 'all native workers stop')
    assert.ok(parents.every(parent => !app.ctx.agents.get(parent.id)), 'all root handles release')
  } finally { app.state.save = save; for (const hold of holds) hold.resolve(); await app.dispose() }
})

test('cancelling /new before teardown keeps the original parent usable', { timeout: 15000 }, async () => {
  const app = await host(async () => text('在线。'))
  try {
    await app.input('旧话题')
    const parent = await app.parent()
    await parent.whenIdle()
    const command = app.message('/new')
    await app.bridge.cancel(command)
    let cancellation
    const reset = app.bridge.enqueue(command, ticket => {
      const result = app.bridge.reset(command, ticket)
      cancellation = app.bridge.cancel(app.message('/cancel'))
      return result
    })
    await assert.rejects(reset, /CANCELLED/)
    await cancellation
    await app.input('继续聊')
    assert.equal(await app.parent(), parent)
    assert.equal(app.ctx.orchestrator.roleOf(parent).revoked, false)
  } finally { await app.dispose() }
})

test('cancelling /new after unbinding releases the handle and resumes the old generation', { timeout: 15000 }, async () => {
  const app = await host(async () => text('在线。'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const service = app.ctx.orchestrator
  const unbind = service.unbindRoot.bind(service)
  try {
    await app.input('旧话题')
    const parent = await app.parent()
    await parent.whenIdle()
    service.unbindRoot = async agent => { await unbind(agent); entered.resolve(); await release.promise }
    const command = app.message('/new')
    const reset = app.bridge.enqueue(command, ticket => app.bridge.reset(command, ticket))
    const rejected = assert.rejects(reset, /CANCELLED/)
    await entered.promise
    await app.bridge.cancel(app.message('/cancel'))
    release.resolve()
    await rejected
    await app.input('继续旧话题')
    const resumed = await app.parent()
    assert.equal(resumed.id, parent.id)
    assert.notEqual(resumed, parent)
    assert.equal(app.ctx.orchestrator.roleOf(resumed).revoked, false)
  } finally { release.resolve(); service.unbindRoot = unbind; await app.dispose() }
})

for (const fault of ['flush', 'drain']) test(`cancel remains retryable after a ${fault} failure`, { timeout: 15000 }, async () => {
  const hold = Promise.withResolvers(), started = Promise.withResolvers()
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      started.resolve()
      await Promise.race([hold.promise, new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))])
    }
    return text('在线。')
  })
  const service = fault === 'flush' ? app.ctx.sessions : app.ctx.subagents
  const method = fault === 'flush' ? 'flush' : 'drainChildren'
  const original = service[method].bind(service)
  try {
    await app.input('开始')
    const parent = await app.parent()
    await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '执行中', task: '等待取消' }, new AbortController().signal)
    await started.promise
    let first = true
    service[method] = async (...args) => {
      if (first) { first = false; throw new Error(`SYNTHETIC_${fault}_FAILURE`) }
      return original(...args)
    }
    await assert.rejects(app.bridge.cancel(app.message('/cancel')), error => error instanceof AggregateError && error.errors.some(e => e.message === `SYNTHETIC_${fault}_FAILURE`))
    if (fault === 'flush') assert.equal(app.ctx.agents.get(childId), undefined, 'drain happens even when persistence fails')
    await app.bridge.cancel(app.message('/cancel'))
    assert.equal(app.ctx.agents.get(childId), undefined)
    const before = app.sent.length
    await app.input('新话题')
    await until(() => app.sent.length > before, 'main conversation recovers after retry')
    assert.equal((await app.ctx.orchestrator.list(parent)).find(row => row.childId === childId).status, 'cancelled')
  } finally { service[method] = original; hold.resolve(); await app.dispose() }
})
