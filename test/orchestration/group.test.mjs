import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createMessageReceiver } from '../../src/messages.mjs'
import { conversationKey } from '../../src/policy.mjs'
import { FeishuReplies } from '../../src/replies.mjs'
import { FeishuApprovals } from '../../src/approvals.mjs'
import { FeishuTools } from '../../src/business/index.mjs'
import { host, text, call, until } from './harness.mjs'

async function groupHost(model, options = {}) {
  let replies
  const app = await host(model, { ...options, config: { groupPolicy: 'allowlist', groupAllowlist: ['oc_group', 'oc_other'], groupReplyInThread: true, requireMention: true, ...options.config }, sendReply: (...args) => replies.send(...args) })
  const posts = [], direct = [], incoming = new Map(), uploads = []
  const channel = {
    rawClient: { im: { v1: {
      image: { create: async request => { uploads.push(request); return { image_key: 'synthetic-image-key' } } },
      message: { reply: async request => {
        posts.push(request)
        const target = incoming.get(request.path.message_id)
        return { code: 0, data: { message_id: `om_reply_${posts.length}`, thread_id: target?.threadId ?? `topic-${target?.messageId}`, root_id: target?.rootId ?? target?.messageId } }
      } },
    } } },
    send: async (...args) => { direct.push(args); return { messageId: 'om_direct' } },
  }
  replies = new FeishuReplies(() => channel, app.state, app.config)
  app.bridge.deps.uploadImage = bytes => replies.uploadImage(bytes)
  const metrics = { received: 0, rejected: 0, completed: 0, failed: 0, sent: 0, sendFailed: 0 }
  const receive = createMessageReceiver({ config: app.config, version: 'test', state: app.state, bridge: app.bridge, replies, metrics, audit: async () => {}, typing: { start: () => ({ stop: async () => {} }) } })
  const message = (content, overrides = {}) => {
    const value = app.message(content, { chatType: 'group', chatId: 'oc_group', threadId: 'omt_shared', rootId: 'om_root', senderId: 'ou_a', mentionedBot: true, ...overrides })
    incoming.set(value.messageId, value)
    return value
  }
  return { ...app, replies, posts, direct, uploads, metrics, message, receive,
    async input(content, overrides) { const value = message(content, overrides); await receive(value); return value },
    async parent(overrides = {}) { return (await app.bridge.get(conversationKey(replies.route(message('', overrides))))).agent },
  }
}

test('group members share topic history while other topics and groups keep separate roots', { timeout: 15000 }, async () => {
  const app = await groupHost(() => text('群聊回复。'))
  try {
    await writeFile(join(app.workspace, 'AGENTS.md'), 'Synthetic group workspace instructions.\n')
    await app.input('成员 A 的上下文'); const first = await app.parent(); await first.whenIdle()
    await app.input('成员 B 继续', { senderId: 'ou_b' }); await first.whenIdle()
    assert.equal((await app.parent({ senderId: 'ou_b' })).id, first.id)
    assert.ok(JSON.stringify(app.requests.at(-1).messages).includes('成员 A 的上下文'))
    await app.input('另一话题', { threadId: 'omt_other', rootId: 'om_other' })
    assert.notEqual((await app.parent({ threadId: 'omt_other', rootId: 'om_other' })).id, first.id)
    await app.input('另一个群', { chatId: 'oc_other' })
    assert.notEqual((await app.parent({ chatId: 'oc_other' })).id, first.id)
    await until(() => app.sent.length === 4, 'four native topic replies')
    assert.equal(app.direct.length, 0)
    assert.ok(app.posts.every(post => post.data.reply_in_thread === true))
  } finally { await app.dispose() }
})

test('the first group model request can explicitly hand its real file attachment to a worker', { timeout: 15000 }, async () => {
  let delegated = false, workerSteps = 0, childId, filePath, attachment
  const app = await groupHost((request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      childId = agent.id
      return ++workerSteps === 1 ? call('read', { file_path: filePath }) : text('附件读回完成。')
    }
    if (!delegated) {
      delegated = true
      const native = ctx.orchestrator.roleOf(agent).inputContext.nativeMessage
      const ref = `att-${native.id}-${native.content.findIndex(block => block.attachment)}`
      assert.ok(JSON.stringify(request.messages).includes(ref), 'the model sees the attested reference on its first request')
      return call('orchestrator_delegate', { label: '读取附件', task: '读取真实附件。', attachments: [ref] })
    }
    return text('已处理。')
  })
  try {
    attachment = await app.ctx.attachments.saveFile({ data: Buffer.from('synthetic group attachment'), name: 'sample.txt' })
    filePath = app.ctx.attachments.fileHostPath(attachment)
    app.bridge.deps.prepareContent = async message => [{ type: 'text', text: message.content }, { type: 'file', attachment }]
    await app.input('读取附件')
    await until(() => childId && app.events.get(childId)?.some(e => e.type === 'tool/result'), 'worker reads attachment')
    const events = app.events.get(childId)
    assert.deepEqual(events.filter(e => e.type === 'user/message').flatMap(e => e.data.content ?? []).find(b => b.type === 'file').attachment, attachment)
    assert.ok(events.find(e => e.type === 'tool/result').data.message.content.some(block => block.text?.includes('synthetic group attachment')))
  } finally { await app.dispose() }
})

test('group admission retains allowlists, explicit recipients, bot topic continuation and deduplication', { timeout: 15000 }, async () => {
  const app = await groupHost(() => text('回复。'))
  try {
    const first = await app.input('开启话题', { messageId: 'om_initial', threadId: undefined, rootId: undefined })
    await until(() => app.sent.length === 1, 'bot creates topic')
    await app.receive(first)
    await app.input('无需再次 @', { threadId: 'topic-om_initial', rootId: first.messageId, mentionedBot: false })
    await until(() => app.sent.length === 2, 'implicit bot topic reply')
    for (const overrides of [
      { chatId: 'oc_forbidden' }, { mentionedBot: false },
      { threadId: 'topic-om_initial', rootId: first.messageId, mentionedBot: false, mentions: [{ id: 'ou_other' }] },
    ]) await app.input('不应回复', overrides)
    assert.equal(app.metrics.rejected, 3)
    assert.equal(app.sent.length, 2)
    assert.equal(app.metrics.accepted, 2)
  } finally { await app.dispose() }
})

test('a new speaker cannot replace an in-flight delegation requester', { timeout: 15000 }, async () => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), worker = Promise.withResolvers()
  let steps = 0
  const app = await groupHost(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) { await worker.promise; return text('完成。') }
    if (++steps === 1) { entered.resolve(); await gate.promise; return call('orchestrator_delegate', { label: 'A 的任务', task: '等待。' }) }
    return text('继续群聊。')
  })
  try {
    const original = await app.input('A 发起执行'); await entered.promise
    await app.input('B 在模型运行期间发言', { senderId: 'ou_b' })
    gate.resolve()
    await until(() => Object.values(app.state.value.orchestratorTasks).some(rows => Object.keys(rows).length), 'delegation persists')
    const record = Object.values(Object.values(app.state.value.orchestratorTasks)[0])[0]
    assert.equal(record.origin.senderId, 'ou_a')
    assert.equal(record.origin.message.messageId, original.messageId)
  } finally { gate.resolve(); worker.resolve(); await app.dispose() }
})

test('group task approval stays with the original requester after another member speaks', { timeout: 15000 }, async () => {
  let delegated = false, workerSteps = 0, writes = 0, readbacks = 0, shown, childId
  const app = await groupHost((request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) { childId = request.sessionId; return ++workerSteps === 1 ? call('sample_write', {}) : text('写入已核验。') }
    if (!delegated) { delegated = true; return call('orchestrator_delegate', { label: '保存', task: '保存并读回。' }) }
    return text('群里继续聊。')
  })
  const approvals = new FeishuApprovals({ runningForAgent: agent => app.bridge.runningForAgent(agent), timeoutMs: 10000,
    sendCard: async (recipient, card) => { shown = { recipient, card }; return { messageId: 'om_card' } }, updateCard: async () => {},
  })
  const factory = { name: 'sample_write', description: 'Synthetic group write', parameters: { type: 'object', properties: {} }, execute: async () => { writes++; return { details: { id: 'record' } } } }
  const operations = new FeishuTools({ client: () => ({}), runningForAgent: agent => app.bridge.runningForAgent(agent), approvals, catalog: [factory], config: { ...app.config, stateDir: app.root } })
  try {
    await operations.load()
    app.ctx.tools.register(defineTool({ name: 'sample_write', description: '保存并读回', parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const turn = app.bridge.runningForAgent(exec.agent)
        return operations.withApprovedWorkflow({ agent: exec.agent, toolName: 'sample_write', callId: exec.callId, signal: exec.signal, business: true }, async grant => JSON.stringify(await grant.performWrite('sample_write', args, turn, exec.signal, 'group-write', undefined, undefined, async () => { readbacks++; return { verified: true } })))
      },
    }))
    const original = await app.input('A 要求保存')
    await until(() => shown && approvals.byMessageId.has('om_card'), 'private approval receipt')
    await app.input('B 继续讨论', { senderId: 'ou_b' }); const parent = await app.parent(); await parent.whenIdle()
    assert.equal(shown.recipient, 'ou_a')
    const child = app.ctx.agents.get(childId), source = app.bridge.runningForAgent(child)
    assert.equal(source.senderId, 'ou_a'); assert.equal(source.message.messageId, original.messageId)
    await assert.rejects(app.ctx.orchestrator.delegate(parent, { label: '伪造归属', task: '不应执行', request_id: original.messageId }, new AbortController().signal))
    await assert.rejects(app.ctx.orchestrator.message(parent, { agent_id: childId, message: 'B 修改 A 的任务' }, new AbortController().signal))
    await assert.rejects(app.ctx.orchestrator.cancel(parent, childId))
    const generation = app.state.value.generations[conversationKey(app.replies.route(original))] ?? 0
    await app.input('/new', { senderId: 'ou_b' })
    assert.equal(app.state.value.generations[conversationKey(app.replies.route(original))] ?? 0, generation)
    await app.input('/cancel', { senderId: 'ou_b' })
    assert.equal(app.ctx.agents.get(childId)?.status, 'running')
    const action = { tag: 'button', value: shown.card.elements.at(-1).actions[0].value }
    assert.equal(approvals.onCardAction({ messageId: 'om_card', operator: { openId: 'ou_b' }, action }), false)
    assert.equal(writes, 0)
    assert.equal(approvals.onCardAction({ messageId: 'om_card', operator: { openId: 'ou_a' }, action }), true)
    await until(() => operations.ledger['group-write']?.status === 'verified', 'approved write and readback')
    assert.equal(writes, 1); assert.equal(readbacks, 1)
  } finally { approvals.dispose(); await app.dispose() }
})

test('cancelling the active speaker preserves and wakes another member already in the native inbox', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers()
  let calls = 0
  const app = await groupHost(async request => {
    if (++calls === 1) {
      entered.resolve()
      await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
      return text('A 的过时结果。')
    }
    return text('B 的消息正常处理。')
  })
  try {
    await app.input('A 的长处理'); await entered.promise
    const pendingB = await app.input('B 已经排队', { senderId: 'ou_b' })
    await app.input('/cancel')
    await until(() => app.sent.some(row => row.message.messageId === pendingB.messageId), 'B wakes without another user message')
    assert.ok(app.sent.every(row => !row.content.includes('A 的过时结果')))
    assert.equal(app.sent.filter(row => row.message.messageId === pendingB.messageId).length, 1)
  } finally { await app.dispose() }
})

test('cancelling one member drains only their worker while another member keeps chatting and working', { timeout: 15000 }, async () => {
  let steps = 0
  const gates = new Map()
  const app = await groupHost(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      const gate = Promise.withResolvers(); gates.set(request.sessionId, gate)
      await Promise.race([gate.promise, new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))])
      return text('任务完成。')
    }
    if ([1, 3].includes(++steps)) return call('orchestrator_delegate', { label: `任务 ${steps}`, task: '等待。' })
    return text('群聊回复。')
  })
  try {
    await app.input('A 的任务'); const parent = await app.parent(); await parent.whenIdle()
    const requestB = await app.input('B 的任务', { senderId: 'ou_b' }); await parent.whenIdle()
    await until(() => gates.size === 2, 'two workers')
    const records = Object.values(app.state.value.orchestratorTasks[parent.id])
    const taskA = records.find(row => row.origin.senderId === 'ou_a'), taskB = records.find(row => row.origin.senderId === 'ou_b')
    await app.input('/cancel')
    assert.equal(app.ctx.agents.get(taskA.childId), undefined)
    assert.equal(app.ctx.agents.get(taskB.childId)?.status, 'running')
    await app.input('C 继续聊天', { senderId: 'ou_c' }); await parent.whenIdle()
    gates.get(taskB.childId).resolve()
    await until(() => app.sent.some(row => row.message.messageId === requestB.messageId && row.content.includes('群聊回复')), 'B completion returns to original request')
    assert.equal(app.direct.length, 0)
  } finally { for (const gate of gates.values()) gate.resolve(); await app.dispose() }
})

test('group image replies and long text stay in the topic with no direct-send fallback', { timeout: 15000 }, async () => {
  const app = await groupHost(() => text(`![图](./result.jpg)\n${'🙂'.repeat(8000)}`))
  try {
    await writeFile(join(app.workspace, 'result.jpg'), Buffer.from('ffd8ffe000', 'hex'))
    const original = await app.input('发送图文')
    await until(() => Object.values(app.state.value.orchestratorDeliveries).some(row => row.status === 'sent'), 'rich topic delivery')
    assert.equal(app.uploads.length, 1)
    assert.ok(app.posts.length >= 3)
    assert.ok(app.posts.every(post => post.path.message_id === original.messageId && post.data.reply_in_thread))
    const rows = app.posts.flatMap(post => JSON.parse(post.data.content).zh_cn.content).flat()
    assert.equal(rows.filter(row => row.tag === 'img').length, 1)
    assert.equal(rows.filter(row => row.tag === 'md').map(row => row.text).join('').trim(), '🙂'.repeat(8000))
    assert.equal(app.direct.length, 0)
  } finally { await app.dispose() }
})

test('mixed native task notifications require an explicit attested request before new delegation', { timeout: 15000 }, async () => {
  const parentGate = Promise.withResolvers(), parentEntered = Promise.withResolvers()
  const mixedGate = Promise.withResolvers(), mixed = Promise.withResolvers(), workers = new Map()
  let steps = 0
  const app = await groupHost(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      const gate = Promise.withResolvers(); workers.set(agent.id, gate)
      if (workers.size <= 2) await gate.promise
      return text('子任务报告。')
    }
    const sources = app.ctx.orchestrator.roleOf(agent).executionContexts ?? []
    if (sources.length > 1) { mixed.resolve(sources); await mixedGate.promise; return text('已分别收到报告。') }
    if ([1, 3].includes(++steps)) return call('orchestrator_delegate', { label: `任务 ${steps}`, task: '等待。' })
    if (steps === 5) { parentEntered.resolve(); await parentGate.promise }
    return text('继续讨论。')
  })
  try {
    const first = await app.input('A 的任务'); const parent = await app.parent(); await parent.whenIdle()
    await app.input('B 的任务', { senderId: 'ou_b' }); await parent.whenIdle()
    await until(() => workers.size === 2, 'two workers start')
    await app.input('C 在讨论', { senderId: 'ou_c' }); await parentEntered.promise
    for (const gate of workers.values()) gate.resolve()
    await until(() => [...workers.keys()].every(id => !app.ctx.agents.get(id)), 'both native results settle')
    parentGate.resolve()
    const sources = await mixed.promise
    assert.deepEqual(new Set(sources.map(c => c.senderId)), new Set(['ou_a', 'ou_b']))
    await assert.rejects(app.ctx.orchestrator.delegate(parent, { label: '未选发起人', task: '不应执行' }, new AbortController().signal))
    await assert.rejects(app.ctx.orchestrator.delegate(parent, { label: '伪造请求', task: '不应执行', request_id: 'not-attested' }, new AbortController().signal))
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '继续 A 的目标', task: '补充核验', request_id: first.messageId }, new AbortController().signal)
    assert.equal(app.state.value.orchestratorTasks[parent.id][childId].origin.senderId, 'ou_a')
    assert.equal(app.state.value.orchestratorTasks[parent.id][childId].origin.message.messageId, first.messageId)
  } finally { parentGate.resolve(); mixedGate.resolve(); for (const gate of workers.values()) gate.resolve(); await app.dispose() }
})

test('a partial rich topic send remains unknown and is never redirected or automatically resent', { timeout: 15000 }, async () => {
  const app = await groupHost(() => text(`![图](./result.jpg)\n${'x'.repeat(8000)}`))
  let calls = 0
  try {
    await writeFile(join(app.workspace, 'result.jpg'), Buffer.from('ffd8ffe000', 'hex'))
    const reply = app.replies.getChannel().rawClient.im.v1.message.reply
    app.replies.getChannel().rawClient.im.v1.message.reply = async request => {
      if (++calls === 2) throw new Error('Synthetic reply target unavailable after first chunk')
      return reply(request)
    }
    await app.input('发送图文')
    await until(() => Object.values(app.state.value.orchestratorDeliveries).some(row => row.status === 'unknown'), 'uncertain rich delivery')
    const parent = await app.parent(); await parent.whenIdle()
    const end = parent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
    app.bridge.observe(parent.session, end)
    await app.bridge.deliveries.get(parent.id)
    assert.equal(calls, 2)
    assert.equal(app.direct.length, 0)
    assert.equal(app.posts.length, 1)
  } finally { await app.dispose() }
})

test('queued image delivery retains its owner across later chatter, cancellation and topic reset', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers(), uploaded = Promise.withResolvers()
  let steps = 0
  const app = await groupHost(() => text(++steps === 1 ? 'A 的图片：![图](./result.jpg)' : 'B 的回复。'))
  try {
    await writeFile(join(app.workspace, 'result.jpg'), Buffer.from('ffd8ffe000', 'hex'))
    app.bridge.deps.uploadImage = async () => { entered.resolve(); await uploaded.promise; return 'synthetic-image-key' }
    const original = await app.input('A 发图'); await entered.promise
    const parent = await app.parent(); await parent.whenIdle()
    await app.input('/new', { senderId: 'ou_b' })
    assert.equal((await app.parent()).id, parent.id, 'another member cannot reset while A uploads')
    const requestB = await app.input('B 继续聊天', { senderId: 'ou_b' }); await parent.whenIdle()
    await app.input('/cancel')
    uploaded.resolve()
    await until(() => app.sent.some(row => row.message.messageId === requestB.messageId), 'B reply survives A cancellation')
    assert.ok(app.sent.every(row => row.message.messageId !== original.messageId))
    assert.ok(Object.values(app.state.value.orchestratorDeliveries).some(row => row.status === 'cancelled'))
  } finally { uploaded.resolve(); await app.dispose() }
})

test('cancelling A during image upload removes A output from the same native turn while B still receives theirs', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers(), first = Promise.withResolvers(), uploading = Promise.withResolvers(), uploaded = Promise.withResolvers()
  let steps = 0
  const app = await groupHost(async () => {
    if (++steps === 1) { entered.resolve(); await first.promise; return text('A_ONLY_RESULT ![A](./a.jpg)') }
    return text('B_ONLY_RESULT')
  })
  try {
    await writeFile(join(app.workspace, 'a.jpg'), Buffer.from('ffd8ffe000', 'hex'))
    app.bridge.deps.uploadImage = async () => { uploading.resolve(); await uploaded.promise; return 'image-A' }
    await app.input('A 请求'); await entered.promise
    const b = await app.input('B 请求', { senderId: 'ou_b' }); first.resolve()
    await uploading.promise
    const parent = await app.parent(); await parent.whenIdle()
    const outputs = app.bridge.bindings.get(parent.id).outputs
    assert.deepEqual(outputs.map(row => row.contexts.map(c => c.senderId)), [['ou_a'], ['ou_b']])
    assert.equal(await app.bridge.cancel(app.message('/cancel')), true); uploaded.resolve()
    await app.bridge.deliveries.get(parent.id)
    assert.equal(app.posts.length, 1)
    assert.equal(app.posts[0].path.message_id, b.messageId)
    assert.ok(JSON.stringify(app.posts).includes('B_ONLY_RESULT'))
    assert.ok(!JSON.stringify(app.posts).includes('A_ONLY_RESULT'))
    assert.ok(!JSON.stringify(app.posts).includes('image-A'))
  } finally { first.resolve(); uploaded.resolve(); await app.dispose() }
})

test('cancelling a claimed request during prompt assembly prevents its model request and preserves the next speaker', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  const app = await groupHost(() => text('B 的回复。'))
  try {
    const parent = await app.parent()
    let pause = true
    parent.ctx.on('system-prompt/assemble', async (assembly, ctx, next) => {
      const result = await next()
      if (pause) { pause = false; entered.resolve(); await gate.promise }
      return result
    })
    await app.input('A 请求'); await entered.promise
    assert.equal(parent.inbox.nextTurn.length + parent.inbox.nextStep.length, 0)
    const b = await app.input('B 排队', { senderId: 'ou_b' })
    assert.equal(await app.bridge.cancel(app.message('/cancel')), true); gate.resolve()
    await until(() => app.posts.length === 1, 'B wakes after cancelled prompt assembly')
    await parent.whenIdle()
    assert.equal(app.requests.length, 1, 'A never starts a model request')
    assert.equal(app.posts[0].path.message_id, b.messageId)
  } finally { gate.resolve(); await app.dispose() }
})

test('a claimed worker report protects its owner from another member resetting the topic before pre-step', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  const app = await groupHost((request, ctx) => text(ctx.agents.get(request.sessionId).session.header.parentSession ? 'A 的任务报告' : 'A 的结果'))
  try {
    const original = await app.input('A 请求'); const parent = await app.parent()
    await parent.whenIdle(); await app.bridge.deliveries.get(parent.id)
    let pause = true
    parent.ctx.on('system-prompt/assemble', async (assembly, ctx, next) => {
      const result = await next()
      if (pause) { pause = false; entered.resolve(); await gate.promise }
      return result
    })
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: 'A 的任务', task: '为 A 返回结果。' }, new AbortController().signal)
    await entered.promise; await until(() => !app.ctx.agents.get(childId), 'worker disposed after reporting')
    assert.equal(parent.inbox.nextTurn.length + parent.inbox.nextStep.length, 0)
    const b = app.message('/new', { senderId: 'ou_b' })
    assert.equal(app.bridge.otherSenderActive(b), true)
    await assert.rejects(app.bridge.reset(b), { code: 'OTHER_SENDER_ACTIVE' })
    assert.equal(app.state.value.generations[conversationKey(app.replies.route(original))] ?? 0, 0)
    gate.resolve(); await parent.whenIdle(); await app.bridge.deliveries.get(parent.id)
    assert.ok(app.posts.length >= 2, 'A report remains deliverable')
  } finally { gate.resolve(); await app.dispose() }
})

test('cancelling after the first long-reply dispatch stops later chunks and retains its partial receipt without retry', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers()
  const app = await groupHost(() => text('长'.repeat(8000)))
  try {
    const api = app.replies.getChannel().rawClient.im.v1.message, reply = api.reply
    let calls = 0
    api.reply = async request => {
      if (++calls === 1) { entered.resolve(); await gate.promise }
      return reply(request)
    }
    await app.input('长回复'); await entered.promise
    assert.equal(await app.bridge.cancel(app.message('/cancel')), true); gate.resolve()
    const parent = await app.parent(); await parent.whenIdle(); await app.bridge.deliveries.get(parent.id)
    assert.equal(calls, 1)
    assert.equal(app.posts.length, 1)
    const ledger = Object.values(app.state.value.orchestratorDeliveries).find(row => row.status === 'unknown')
    assert.deepEqual(ledger.receipts, [{ messageId: 'om_reply_1', chunkIds: ['om_reply_1'] }])
    app.bridge.observe(parent.session, parent.session.snapshotEvents().findLast(e => e.type === 'turn/end'))
    await app.bridge.deliveries.get(parent.id)
    assert.equal(calls, 1)
  } finally { gate.resolve(); await app.dispose() }
})

test('group task origin survives restart and another member cannot resume it', { timeout: 15000 }, async () => {
  const model = () => text('完成。')
  let app = await groupHost(model), root, childId, parentId
  try {
    await app.input('A 发起任务'); const parent = await app.parent(); await parent.whenIdle(); parentId = parent.id
    childId = (await app.ctx.orchestrator.delegate(parent, { label: '持久任务', task: '完成一次任务。' }, new AbortController().signal)).childId
    await until(() => app.events.get(childId)?.some(e => e.type === 'turn/end'), 'worker settles')
    await parent.whenIdle(); await app.state.pending
    root = app.root
    const backup = join(root, 'channel-before-stop.json'); await cp(app.state.path, backup)
    await app.dispose({ keepFiles: true }); await cp(backup, join(root, 'channel-state.json'))
    app = await groupHost(model, { root })
    await app.input('B 继续群聊', { senderId: 'ou_b' }); const restored = await app.parent(); await restored.whenIdle()
    assert.equal(restored.id, parentId)
    assert.equal(app.ctx.orchestrator.contextForChild(restored, childId).senderId, 'ou_a')
    await assert.rejects(app.ctx.orchestrator.message(restored, { agent_id: childId, message: 'B 接管' }, new AbortController().signal))
    await app.input('A 继续', { senderId: 'ou_a' }); await restored.whenIdle()
    await app.ctx.orchestrator.message(restored, { agent_id: childId, message: 'A 继续原任务' }, new AbortController().signal)
    await until(() => app.events.get(childId)?.some(e => e.type === 'turn/end'), 'original owner resumes')
  } finally { await app.dispose(); if (root) await rm(root, { recursive: true, force: true }) }
})

test('a pending group input recovers its trusted owner after a crash before another member wakes the topic', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers()
  let app = await groupHost(async request => {
    entered.resolve()
    await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
    return text('停止旧轮。')
  }), root, pendingB, delegated = false
  try {
    await app.input('A 的长处理'); await entered.promise
    pendingB = await app.input('B 的待处理任务', { senderId: 'ou_b' })
    const parent = await app.parent(); await app.ctx.sessions.flush(parent.session); await app.state.pending
    root = app.root
    await cp(join(root, 'sessions'), join(root, 'sessions-before-crash'), { recursive: true })
    await cp(app.state.path, join(root, 'state-before-crash.json'))
    await app.dispose({ keepFiles: true })
    await rm(join(root, 'sessions'), { recursive: true, force: true })
    await cp(join(root, 'sessions-before-crash'), join(root, 'sessions'), { recursive: true })
    await cp(join(root, 'state-before-crash.json'), join(root, 'channel-state.json'))
    app = await groupHost((request, ctx) => {
      if (ctx.agents.get(request.sessionId).session.header.parentSession) return text('B 完成。')
      if (!delegated) { delegated = true; return call('orchestrator_delegate', { label: 'B 恢复任务', task: '完成 B 的请求。', request_id: pendingB.messageId }) }
      return text('恢复后回复。')
    }, { root })
    await app.input('C 唤醒话题', { senderId: 'ou_c' })
    const restored = await app.parent()
    await until(() => Object.keys(app.state.value.orchestratorTasks[restored.id] ?? {}).length > 0, 'pending B delegation resumes')
    const record = Object.values(app.state.value.orchestratorTasks[restored.id])[0]
    assert.equal(record.origin.senderId, 'ou_b')
    assert.equal(record.origin.message.messageId, pendingB.messageId)
    assert.ok(!JSON.stringify(app.state.value.orchestratorInputs).includes('B 的待处理任务'), 'the routing ledger keeps no duplicate message body')
  } finally { await app.dispose(); if (root) await rm(root, { recursive: true, force: true }) }
})
