import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { host, text, until, llm } from './harness.mjs'

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

test('multiple assistant replies in one native turn preserve the task report', { timeout: 15000 }, async () => {
  let step = 0
  const app = await host((request, ctx) => {
    if (++step === 1) {
      // A second native notification arrives while the first result is being
      // answered, just as send_message + settlement did in the real session.
      ctx.agents.get(request.sessionId).steer(llm.createUserMessage({ source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '重复的结束通知' }] }))
      return text('子任务结果：缺少下载工具，没有新增图片。')
    }
    return text('后面没有新进展，结论同上。')
  })
  try {
    await app.input('开始')
    const parent = await app.parent()
    await parent.whenIdle()
    await until(() => app.sent.length > 0, 'turn delivered')
    assert.equal(step, 2)
    assert.equal(parent.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 1)
    assert.match(app.sent[0].content, /子任务结果：缺少下载工具/)
  } finally { await app.dispose() }
})
