import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageReceiver } from 'dsh-feishu/core/messages'
import { TypingIndicators } from 'dsh-feishu/core/typing'
import { host, text, call, until } from './harness.mjs'

const native = { timeout: 15000, skip: process.platform !== 'linux' && process.env.DSH_NATIVE_TEST !== '1' ? 'Native integration requires a platform addon' : false }
const gate = () => Promise.withResolvers()

function receiver(app) {
  const events = [], active = new Set()
  const typing = new TypingIndicators(() => ({ im: { v1: { messageReaction: {
    async create({ path }) {
      active.add(path.message_id); events.push(['added', path.message_id])
      return { code: 0, data: { reaction_id: path.message_id } }
    },
    async delete({ path }) {
      active.delete(path.message_id); events.push(['removed', path.message_id])
      return { code: 0 }
    },
  } } } }), app.state)
  const receive = createMessageReceiver({
    config: { ...app.config, dmMode: 'allowlist', dmAllowlist: ['synthetic-user'] }, version: 'test', state: app.state, bridge: app.bridge, typing,
    metrics: { received: 0, rejected: 0, completed: 0, failed: 0, sent: 0, sendFailed: 0 }, audit: async () => {},
    replies: { isBotThread: () => false, route: message => message, send: async () => ({ messageId: crypto.randomUUID() }) },
  })
  return { receive, active, events }
}

test('native receiver keeps the reaction during model work and until reply delivery settles', native, async () => {
  const model = gate(), sending = gate(), delivered = gate()
  const app = await host(async () => { await model.promise; return text('最终回复') }, {
    sendReply: async () => { sending.resolve(); await delivered.promise; return { messageId: 'final-receipt' } },
  })
  const f = receiver(app), message = app.message('开始')
  try {
    await f.receive(message)
    await until(() => app.requests.length > 0, 'model started')
    assert.ok(f.active.has(message.messageId), 'admission must not remove the processing reaction')
    model.resolve(); await sending.promise
    assert.ok(f.active.has(message.messageId), 'pending delivery must retain the reaction')
    delivered.resolve()
    await until(() => !f.active.has(message.messageId), 'reaction removed after final receipt')
    assert.equal(f.events.filter(([event]) => event === 'removed').length, 1)
  } finally { model.resolve(); delivered.resolve(); await app.dispose() }
})

test('native reaction spans the idle frontdesk, background worker and resumed final reply', native, async () => {
  const worker = gate(), finalDelivery = gate()
  let steps = 0, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) { childId = agent.id; await worker.promise; return text('执行完成') }
    if (++steps === 1) return call('orchestrator_delegate', { label: '耗时任务', task: '执行任务并返回结果。' })
    return text(steps === 2 ? '已经开始执行。' : '最终执行结果。')
  }, { sendReply: async (_message, content) => {
    if (JSON.stringify(content).includes('最终执行结果')) await finalDelivery.promise
    return { messageId: crypto.randomUUID() }
  } })
  const f = receiver(app), message = app.message('帮我执行任务')
  try {
    await f.receive(message)
    const parent = await app.parent()
    await until(() => childId && parent.status === 'idle' && app.sent.length === 1, 'frontdesk acknowledges while child is running')
    await app.bridge.deliveries.get(parent.id)
    assert.ok(f.active.has(message.messageId), 'frontdesk acknowledgement must not finish background activity')
    worker.resolve()
    await until(() => app.sent.some(row => JSON.stringify(row.content).includes('最终执行结果')), 'parent sends final result')
    assert.ok(f.active.has(message.messageId), 'worker settlement must wait for parent reply delivery')
    finalDelivery.resolve()
    await until(() => !f.active.has(message.messageId), 'reaction removed after final result')
  } finally { worker.resolve(); finalDelivery.resolve(); await app.dispose() }
})

test('a group followup clears its own reaction while the first requester worker is still active', native, async () => {
  const worker = gate()
  let steps = 0, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) { childId = agent.id; await worker.promise; return text('A 的任务完成') }
    if (++steps === 1) return call('orchestrator_delegate', { label: 'A 的任务', task: '执行 A 的任务。', request_id: ctx.orchestrator.roleOf(agent).inputContext.message.messageId })
    return text(steps === 2 ? 'A 的任务已经开始。' : steps === 3 ? 'B 的问题已经回答。' : 'A 的最终结果。')
  }, { config: { groupPolicy: 'allowlist', groupAllowlist: ['oc_group'], groupReplyInThread: true, requireMention: true } })
  const f = receiver(app), group = { chatType: 'group', chatId: 'oc_group', threadId: 'omt_topic', rootId: 'om_root', mentionedBot: true }
  const a = app.message('A 发起任务', { ...group, senderId: 'ou_a' }), b = app.message('B 的普通问题', { ...group, senderId: 'ou_b' })
  try {
    await f.receive(a)
    const parent = app.ctx.agents.roots()[0]
    await until(() => childId && parent.status === 'idle' && app.sent.length === 1, 'A worker is active')
    await f.receive(b)
    await until(() => f.events.some(([event, id]) => event === 'removed' && id === b.messageId), 'B reaction clears independently')
    assert.ok(f.active.has(a.messageId), 'B completion must not clear A background activity')
    worker.resolve()
    await until(() => !f.active.has(a.messageId), 'A final result clears its reaction')
    assert.equal(app.sent.at(-1).message.senderId, 'ou_a')
  } finally { worker.resolve(); await app.dispose() }
})

test('a failed final delivery releases its reaction and preserves the unknown send receipt', native, async () => {
  const sending = gate(), fail = gate()
  const app = await host(async () => text('最终回复'), { sendReply: async () => {
    sending.resolve(); await fail.promise; throw new Error('Synthetic transport failure after dispatch')
  } })
  const f = receiver(app), message = app.message('开始')
  try {
    await f.receive(message); await sending.promise
    assert.ok(f.active.has(message.messageId))
    fail.resolve()
    await until(() => !f.active.has(message.messageId), 'failure releases reaction')
    assert.ok(Object.values(app.state.value.orchestratorDeliveries).some(row => row.status === 'unknown'))
    assert.equal(f.events.filter(([event]) => event === 'removed').length, 1)
  } finally { fail.resolve(); await app.dispose() }
})

test('steering an already running worker retains both request reactions until its result is delivered', native, async () => {
  const worker = gate()
  let steps = 0, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) { childId = agent.id; await worker.promise; return text('包含补充要求的执行结果') }
    if (++steps === 1) return call('orchestrator_delegate', { label: '可补充任务', task: '等待后续补充要求。' })
    if (steps === 3) return call('send_message', { agent_id: childId, message: '增加一项要求。' })
    return text('已接收。')
  })
  const f = receiver(app), a = app.message('开始任务'), b = app.message('补充一项要求')
  try {
    await f.receive(a)
    const parent = await app.parent()
    await until(() => childId && parent.status === 'idle', 'worker is active')
    await f.receive(b)
    await until(() => steps >= 4 && parent.status === 'idle', 'followup reaches running worker')
    await parent.whenIdle()
    await app.bridge.deliveries.get(parent.id)
    await new Promise(resolve => setImmediate(resolve))
    await app.state.pending
    assert.ok(f.active.has(a.messageId), 'original request remains active')
    assert.ok(f.active.has(b.messageId), 'steered request remains active on the same worker')
    worker.resolve()
    await until(() => !f.active.has(a.messageId) && !f.active.has(b.messageId), 'both reactions clear after the worker report')
  } finally { worker.resolve(); await app.dispose() }
})

test('requester cancellation drains its worker and clears the original reaction', native, async () => {
  const worker = gate()
  let steps = 0, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) { childId = agent.id; await worker.promise; return text('已停止') }
    if (++steps === 1) return call('orchestrator_delegate', { label: '可取消任务', task: '等待测试取消。' })
    return text('已开始。')
  })
  const f = receiver(app), message = app.message('开始')
  try {
    await f.receive(message)
    const parent = await app.parent()
    await until(() => childId && parent.status === 'idle', 'worker is active')
    assert.ok(f.active.has(message.messageId))
    const cancelled = f.receive(app.message('/cancel'))
    await until(() => app.bridge.orchestrator.roleOf(parent).suspended, 'cancel revokes the root')
    worker.resolve(); await cancelled
    await until(() => !f.active.has(message.messageId), 'original reaction clears after cancellation')
    assert.deepEqual(app.state.value.typingReactions, {})
  } finally { worker.resolve(); await app.dispose() }
})

test('a parked inbox after model failure yields to timers and can be cancelled', native, async () => {
  const failure = gate()
  let steps = 0
  const app = await host(async () => {
    if (++steps === 1) { await failure.promise; throw new Error('Synthetic first request failure') }
    return text('继续处理')
  })
  const f = receiver(app), a = app.message('首轮消息'), b = app.message('模型运行期间追加')
  try {
    await f.receive(a)
    const parent = await app.parent()
    await until(() => app.requests.length === 1, 'first model is blocked')
    await f.receive(b)
    assert.ok(parent.inbox.nextStep.length > 0, 'followup is pending before model failure')
    failure.resolve()
    await until(() => parent.status === 'idle', 'failed driver becomes idle')
    assert.ok(parent.inbox.nextStep.length > 0, 'failed driver leaves an admitted input parked')
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(steps, 1, 'completion observation must not drive parked input')
    await f.receive(app.message('/cancel'))
    await until(() => !f.active.has(a.messageId) && !f.active.has(b.messageId), 'cancellation wakes parked completion observers')
    assert.equal(parent.inbox.nextStep.length + parent.inbox.nextTurn.length, 0)
  } finally { failure.resolve(); await app.dispose() }
})

test('shutdown releases group reactions parked behind a failed model turn', native, async () => {
  const failure = gate()
  const app = await host(async () => { await failure.promise; throw new Error('Synthetic group model failure') }, {
    config: { groupPolicy: 'allowlist', groupAllowlist: ['oc_group'], groupReplyInThread: true, requireMention: true },
  })
  const f = receiver(app), group = { chatType: 'group', chatId: 'oc_group', threadId: 'omt_topic', rootId: 'om_root', mentionedBot: true }
  const a = app.message('A 首轮消息', { ...group, senderId: 'ou_a' }), b = app.message('B 追加消息', { ...group, senderId: 'ou_b' })
  let disposed = false
  const dispose = async () => { if (!disposed) { disposed = true; await app.dispose() } }
  try {
    await f.receive(a)
    const parent = app.ctx.agents.roots()[0]
    await until(() => app.requests.length === 1, 'group model is blocked')
    await f.receive(b)
    failure.resolve()
    await until(() => parent.status === 'idle', 'group input is parked')
    assert.ok(parent.inbox.nextStep.length > 0)
    await dispose()
    await until(() => !f.active.has(a.messageId) && !f.active.has(b.messageId), 'shutdown wakes group completion observers')
  } finally { failure.resolve(); await dispose() }
})
