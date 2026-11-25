import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { host, text, call, until, llm } from './harness.mjs'

const silentReply = '[[DSH_FEISHU_NO_REPLY]]'

test('root with a settled child accepts input after restart from persisted history', { timeout: 15000 }, async () => {
  const app = await host(() => text('完成。'))
  let restarted
  try {
    await app.input('开始任务')
    const parent = await app.parent()
    await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '找图', task: '报告工具缺失。' }, new AbortController().signal)
    await until(() => !app.ctx.agents.get(childId), 'child settled')
    await parent.whenIdle()
    await app.ctx.sessions.flush(parent.session)
    // Snapshot before graceful teardown: a process restart must also handle
    // logs that have not been rewritten by stopRoot/dispose.
    const snapshot = join(app.root, 'crash-snapshot')
    await cp(join(app.root, 'sessions'), snapshot, { recursive: true })
    await cp(join(app.root, 'channel-state.json'), join(app.root, 'crash-state.json'))
    await app.dispose({ keepFiles: true })
    await rm(join(app.root, 'sessions'), { recursive: true })
    await cp(snapshot, join(app.root, 'sessions'), { recursive: true })
    await cp(join(app.root, 'crash-state.json'), join(app.root, 'channel-state.json'))
    restarted = await host(() => text('重发回复。'), { root: app.root })
    await restarted.input('重发刚才两张图')
    await until(() => restarted.sent.length > 0, 'old root sends a new reply')
    assert.equal(restarted.sent[0].content, '重发回复。')
    const restoredParent = await restarted.parent()
    await restoredParent.whenIdle()
    assert.ok((await restarted.ctx.orchestrator.list(restoredParent)).some(row => row.childId === childId))
    await restarted.ctx.orchestrator.message(restoredParent, { agent_id: childId, message: '补充检查' }, new AbortController().signal)
    await until(() => restarted.requests.some(request => request.sessionId === childId), 'child resumes with persisted ownership')
  } finally {
    if (restarted) await restarted.dispose()
    else await app.dispose()
  }
})

for (const trailing of ['新增结果：已找到可用下载工具。', silentReply]) {
  test(`same-turn delivery preserves the report with a ${trailing === silentReply ? 'silent' : 'meaningful'} follow-up`, { timeout: 15000 }, async () => {
    let step = 0
    const app = await host((request, ctx) => {
      if (++step === 1) {
        // A second native notification arrives while the first result is being
        // answered, just as send_message + settlement did in the real session.
        ctx.agents.get(request.sessionId).steer(llm.createUserMessage({ source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '重复的结束通知' }] }))
        return text('子任务结果：缺少下载工具，没有新增图片。')
      }
      return text(trailing)
    })
    try {
      await app.input('开始')
      const parent = await app.parent()
      await parent.whenIdle()
      await until(() => app.sent.length > 0, 'turn delivered')
      assert.equal(step, 2)
      assert.equal(parent.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 1)
      assert.match(app.sent[0].content, /子任务结果：缺少下载工具/)
      if (trailing === silentReply) assert.doesNotMatch(app.sent[0].content, /DSH_FEISHU_NO_REPLY/)
      else assert.match(app.sent[0].content, /新增结果：已找到可用下载工具/)
    } finally { await app.dispose() }
  })
}

test('an explicit user request can echo the internal marker as ordinary text', { timeout: 15000 }, async () => {
  const app = await host(() => text(silentReply))
  try {
    const result = await app.input(`请逐字输出 ${silentReply}`)
    await result.settled
    assert.deepEqual(app.sent.map(reply => reply.content), [silentReply])
  } finally { await app.dispose() }
})

test('a duplicate settlement stays silent after a tool-only follow-up', { timeout: 15000 }, async () => {
  const finishWorker = Promise.withResolvers()
  let step = 0
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      await finishWorker.promise
      return text('子任务已结束。')
    }
    switch (++step) {
      case 1: return call('orchestrator_delegate', { label: '检查', task: '确认任务状态。' })
      case 2: return text('已告知当前状态。')
      case 3: return call('orchestrator_tasks', {})
      default: return text(silentReply)
    }
  })
  try {
    const result = await app.input('开始')
    await until(() => app.sent.length === 1, 'current status delivered')
    finishWorker.resolve()
    await result.settled
    assert.equal(step, 4)
    assert.deepEqual(app.sent.map(reply => reply.content), ['已告知当前状态。'])
  } finally {
    finishWorker.resolve()
    await app.dispose()
  }
})

test('a new user message takes precedence over a simultaneous settlement', { timeout: 15000 }, async () => {
  const started = Promise.withResolvers(), finishFirstReply = Promise.withResolvers()
  let step = 0
  const app = await host(async () => {
    if (++step === 1) {
      started.resolve()
      await finishFirstReply.promise
      return text('当前状态。')
    }
    return text(silentReply)
  })
  try {
    const first = await app.input('开始')
    await started.promise
    const parent = app.ctx.agents.get(first.sessionId)
    await app.input(`请逐字输出 ${silentReply}`)
    parent.steer(llm.createUserMessage({ source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '结束通知' }] }))
    finishFirstReply.resolve()
    await first.settled
    assert.equal(step, 2)
    assert.deepEqual(app.sent.map(reply => reply.content), [`当前状态。\n\n${silentReply}`])
  } finally {
    finishFirstReply.resolve()
    await app.dispose()
  }
})

test('group worker progress and its silent settlement retain the original request target', { timeout: 15000 }, async () => {
  const sendProgress = Promise.withResolvers(), settleWorker = Promise.withResolvers()
  const enteredParentProgress = Promise.withResolvers(), finishParentProgress = Promise.withResolvers()
  const opts = { chatType: 'group', chatId: 'oc_group', threadId: 'omt_topic', rootId: 'om_topic', senderId: 'ou_a', mentionedBot: true }
  let parentSteps = 0, workerSteps = 0
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      if (++workerSteps === 1) {
        await sendProgress.promise
        return call('send_message', { agent_id: agent.session.header.parentSession, message: '任务结果已经报告。' })
      }
      await settleWorker.promise
      return text('收尾通知，内容同前。')
    }
    switch (++parentSteps) {
      case 1: return call('orchestrator_delegate', { label: '检查', task: '报告本轮结果。' })
      case 2: return text('收到，已开始。')
      case 3:
        enteredParentProgress.resolve()
        await finishParentProgress.promise
        return text('首份业务回报。')
      case 4: return text(silentReply)
      default: return text('群友 B 的新回复。')
    }
  }, { config: { groupPolicy: 'allowlist', groupAllowlist: [opts.chatId], groupReplyInThread: true } })

  try {
    const a = await app.input('A 开始', opts)
    await until(() => app.sent.length === 1, 'parent acknowledges A')
    const parent = app.ctx.agents.get(a.sessionId)
    sendProgress.resolve()
    await enteredParentProgress.promise
    settleWorker.resolve()
    await until(() => parent.inbox.nextStep.some(msg => msg.source.kind === 'subagent-settled'), 'settlement overlaps parent progress')
    finishParentProgress.resolve()
    await a.settled
    assert.equal(parentSteps, 4)
    assert.equal(app.sent.length, 2)
    assert.equal(app.sent[1].content, '首份业务回报。')
    assert.equal(app.sent[0].message.messageId, app.sent[1].message.messageId)
    assert.ok(app.sent.every(row => row.message.senderId === 'ou_a'))
    const b = await app.input('B 新问题', { ...opts, senderId: 'ou_b' })
    await b.settled
    assert.equal(app.sent.length, 3)
    assert.equal(app.sent[2].content, '群友 B 的新回复。')
    assert.equal(app.sent[2].message.senderId, 'ou_b')
  } finally {
    sendProgress.resolve(); settleWorker.resolve(); finishParentProgress.resolve()
    await app.dispose()
  }
})

test('the first private Feishu input can attach to a running root without observer errors', { timeout: 15000 }, async t => {
  const started = Promise.withResolvers(), finishFirstReply = Promise.withResolvers()
  let step = 0
  const app = await host(async () => {
    if (++step === 1) {
      started.resolve()
      await finishFirstReply.promise
      return text('网页会话的回复。')
    }
    return text('飞书跟进。')
  })
  try {
    const parent = await app.parent()
    const observe = t.mock.method(app.bridge, 'observe')
    parent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '网页发言' }] }))
    await started.promise
    const admission = await app.input('第一个飞书请求')
    assert.equal(admission.sessionId, parent.id)
    finishFirstReply.resolve()
    await admission.settled
    assert.equal(step, 2)
    assert.deepEqual(observe.mock.calls.flatMap(call => call.error ? [call.error.message] : []), [])
    assert.deepEqual(app.errors, [])
    assert.deepEqual(app.sent, [])
  } finally {
    finishFirstReply.resolve()
    await app.dispose()
  }
})
