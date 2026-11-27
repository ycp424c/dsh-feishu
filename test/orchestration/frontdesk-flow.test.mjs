import test from 'node:test'
import assert from 'node:assert/strict'
import { host, text, call, until, llm } from './harness.mjs'

const reasoningModel = {
  reasoning: {
    defaultEffort: 'high',
    efforts: [
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ],
  },
}

const execute = (app, agent, name, args) =>
  app.ctx.tools.execute({ callId: llm.ToolCallId(crypto.randomUUID()), agent, name, arguments: args, signal: new AbortController().signal })

test('frontdesk defaults to low reasoningEffort when supported while workers keep model default', { timeout: 15000 }, async () => {
  let parentSteps = 0, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      childId = agent.id
      return text('执行子代理已完成。')
    }
    if (++parentSteps === 1) return call('orchestrator_delegate', { label: '深度分析', task: '完成分析。' })
    if (parentSteps === 2) return text('已正式接取任务。')
    return text('任务已完成并核验。')
  }, { modelInfo: reasoningModel })
  try {
    const admission = await app.input('帮我排查一个复杂问题')
    await admission.settled
    const parent = await app.parent()
    const parentRequests = app.requests.filter(r => r.sessionId === parent.id)
    const workerRequests = app.requests.filter(r => r.sessionId === childId)
    assert.ok(parentRequests.length >= 2)
    assert.ok(workerRequests.length >= 1)
    assert.ok(parentRequests.every(r => r.reasoningEffort === 'low'), 'frontdesk uses low reasoningEffort')
    assert.ok(workerRequests.every(r => r.reasoningEffort === 'high'), 'worker keeps model default high instead of inheriting frontdesk low')
  } finally { await app.dispose() }
})

test('explicit workerReasoningEffort and frontdeskReasoningEffort null override defaults', { timeout: 15000 }, async () => {
  let parentSteps = 0, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      childId = agent.id
      return text('完成。')
    }
    if (++parentSteps === 1) return call('orchestrator_delegate', { label: '高深度任务', task: '执行。' })
    return text('收到。')
  }, {
    modelInfo: reasoningModel,
    orchestrator: { workerReasoningEffort: 'max' },
    config: { orchestration: { frontdeskReasoningEffort: null, workerReasoningEffort: 'max' } },
  })
  try {
    const admission = await app.input('执行高深度任务')
    await admission.settled
    const parent = await app.parent()
    assert.ok(app.requests.filter(r => r.sessionId === parent.id).every(r => r.reasoningEffort === 'high'))
    assert.ok(app.requests.filter(r => r.sessionId === childId).every(r => r.reasoningEffort === 'max'))
  } finally { await app.dispose() }
})

test('two-stage delegation delivers interim reply before delegation and confirmation after acceptance', { timeout: 15000 }, async () => {
  const releaseDelegateStep = Promise.withResolvers()
  const enteredDelegateStep = Promise.withResolvers()
  const releaseWorker = Promise.withResolvers()
  let parentSteps = 0, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      childId = agent.id
      await releaseWorker.promise
      return text('后台执行完成。')
    }
    switch (++parentSteps) {
      case 1:
        return call('orchestrator_begin_delegation', { message: '收到，这个需要后台操作，我先整理委托要求。' })
      case 2:
        enteredDelegateStep.resolve()
        await releaseDelegateStep.promise
        return call('orchestrator_delegate', { label: '后台处理', task: '按要求完成任务并读回核验。' })
      case 3:
        return text('任务已正式接取，后台开始处理，有进展会第一时间同步你。')
      default:
        return text('后台任务已完成。')
    }
  })
  try {
    const admission = await app.input('帮我改一下这个文件并验证')
    await enteredDelegateStep.promise
    // First reply must be sent while frontdesk is still drafting the delegation brief.
    await until(() => app.sent.length === 1, 'interim reply delivered before delegation starts')
    assert.equal(app.sent[0].content, '收到，这个需要后台操作，我先整理委托要求。')
    assert.equal(childId, undefined, 'worker has not started yet while interim reply is already delivered')

    releaseDelegateStep.resolve()
    await until(() => app.sent.length === 2 && Boolean(childId), 'acceptance confirmation delivered after worker starts')
    assert.equal(app.sent[1].content, '任务已正式接取，后台开始处理，有进展会第一时间同步你。')
    assert.equal(app.ctx.agents.get(childId)?.status, 'running')

    releaseWorker.resolve()
    await admission.settled
    assert.equal(app.sent.length, 3)
    assert.equal(app.sent[2].content, '后台任务已完成。')
    assert.ok(Object.values(app.state.value.orchestratorDeliveries).every(r => r.status === 'sent'))
  } finally {
    releaseDelegateStep.resolve()
    releaseWorker.resolve()
    await app.dispose()
  }
})

test('duplicate begin_delegation is idempotent and worker cannot invoke it', { timeout: 15000 }, async () => {
  const holdWorker = Promise.withResolvers()
  let parentSteps = 0, childId, workerToolDesc, workerPrompt
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      childId = agent.id
      workerToolDesc = request.tools.find(t => t.name === 'send_message')?.description ?? ''
      workerPrompt = JSON.stringify(request.system ?? '') + JSON.stringify(request.messages ?? '')
      await holdWorker.promise
      return text('完成。')
    }
    switch (++parentSteps) {
      case 1: return call('orchestrator_begin_delegation', { message: '收到，准备安排后台处理。' })
      case 2: return call('orchestrator_begin_delegation', { message: '重复的先行回复，不应再次发送。' })
      case 3: return call('orchestrator_delegate', { label: '测试', task: '检查边界。' })
      case 4: return text('已正式开始后台处理。')
      default: return text('已完成。')
    }
  })
  try {
    const admission = await app.input('执行一个后台任务')
    await until(() => childId && app.sent.length === 2, 'only one interim reply plus acceptance confirmation')
    assert.deepEqual(app.sent.map(r => r.content), ['收到，准备安排后台处理。', '已正式开始后台处理。'])
    const child = app.ctx.agents.get(childId)
    const denied = await execute(app, child, 'orchestrator_begin_delegation', { message: '子代理禁止调用' })
    assert.equal(denied.isError, true)
    assert.match(workerToolDesc, /不要在结束前调用本工具/)
    assert.match(workerPrompt, /subagent-settled/)
    holdWorker.resolve()
    await admission.settled
  } finally {
    holdWorker.resolve()
    await app.dispose()
  }
})

test('group two-stage delegation routes both replies to the requester and probe stays silent', { timeout: 15000 }, async () => {
  let step = 0
  const opts = { chatType: 'group', chatId: 'oc_group', threadId: 'omt_topic', rootId: 'om_topic', senderId: 'ou_a', mentionedBot: true }
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) return text('群任务完成。')
    switch (++step) {
      case 1: return call('orchestrator_begin_delegation', { message: '收到，我先整理任务并安排后台执行。' })
      case 2: return call('orchestrator_delegate', { label: '群任务', task: '执行。' })
      case 3: return text('已正式接取，后台处理中。')
      default: return text('群任务已完成。')
    }
  }, { config: { groupPolicy: 'allowlist', groupAllowlist: ['oc_group'], groupReplyInThread: true } })
  try {
    const a = await app.input('帮我跑一个群任务', opts)
    await a.settled
    assert.equal(app.sent.length, 3)
    assert.ok(app.sent.every(r => r.message.senderId === 'ou_a' && r.message.messageId === app.sent[0].message.messageId))
    assert.deepEqual(app.sent.map(r => r.content), [
      '收到，我先整理任务并安排后台执行。',
      '已正式接取，后台处理中。',
      '群任务已完成。',
    ])

    // Local probe must not emit IM messages even when calling orchestrator_begin_delegation.
    step = 0
    const probe = await app.input('探针测试', { chatType: 'p2p', chatId: 'local-probe:two-stage', senderId: 'local-probe' })
    await probe.settled
    assert.equal(app.sent.length, 3)
  } finally { await app.dispose() }
})

test('matching assistant text in the same step as begin_delegation is not sent twice', { timeout: 15000 }, async () => {
  let step = 0
  const interim = '收到，我先整理任务并安排后台处理。'
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) return text('完成。')
    if (++step === 1) {
      const id = llm.ToolCallId(crypto.randomUUID())
      const args = JSON.stringify({ message: interim })
      return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: interim },
        { type: 'block-end', index: 0, block: { type: 'text', text: interim } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 1, id, name: 'orchestrator_begin_delegation', argumentsDelta: args },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'orchestrator_begin_delegation', arguments: args } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    }
    if (step === 2) return call('orchestrator_delegate', { label: '去重验证', task: '执行。' })
    if (step === 3) return text('已接取，后台处理中。')
    return text('处理完毕。')
  })
  try {
    const admission = await app.input('测试去重')
    await admission.settled
    assert.deepEqual(app.sent.map(r => r.content), [interim, '已接取，后台处理中。', '处理完毕。'])
  } finally { await app.dispose() }
})
