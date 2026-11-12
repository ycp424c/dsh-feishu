import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, symlink, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { host, text, call, until, llm } from './harness.mjs'

const signal = () => new AbortController().signal
const execute = (app, agent, name, args) => app.ctx.tools.execute({ callId: llm.ToolCallId(crypto.randomUUID()), agent, name, arguments: args, signal: signal() })

test('worker asks parent, receives context and continues in the same native session', { timeout: 15000 }, async () => {
  let delegated = false, asked = false, answered = false, wrote = false, childId
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      childId ??= agent.id
      assert.equal(agent.id, childId)
      if (!asked) { asked = true; return call('send_message', { agent_id: agent.session.header.parentSession, message: '记录哪个时间？' }) }
      if (!JSON.stringify(request.messages).includes('可信补充：昨天晚上')) return text('等待主会话补充时间。')
      if (!wrote) { wrote = true; return call('write', { file_path: 'time.txt', content: '昨天晚上' }) }
      return text('已写入 time.txt，记录的是昨天晚上。')
    }
    if (!delegated) { delegated = true; return call('orchestrator_delegate', { label: '记录时间', task: '执行记录，需要时间时向主会话询问。' }) }
    if (asked && !answered) { answered = true; return call('send_message', { agent_id: childId, message: '可信补充：昨天晚上。' }) }
    return text(wrote ? '已处理记录。' : '正在处理记录。')
  })
  try {
    await app.input('昨天晚上，帮我记一下。')
    await until(async () => wrote && await readFile(join(app.workspace, 'time.txt'), 'utf8').catch(() => '') === '昨天晚上', 'worker receives parent answer and writes')
    await until(() => app.sent.some(m => m.content === '已处理记录。'), 'parent reports child result')
    assert.equal([...app.events.keys()].filter(id => id.startsWith('orchestrator-worker-')).length, 1)
    assert.ok(app.events.get(childId).some(e => e.type === 'user/message' && e.data.source?.kind === 'agent-message'))
  } finally { await app.dispose() }
})

test('completed child cold-resumes on follow-up with history and role restrictions', { timeout: 15000 }, async () => {
  let workerTurns = 0
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      workerTurns++
      if (workerTurns > 1) assert.ok(JSON.stringify(request.messages).includes('阶段一报告'))
      return text(workerTurns === 1 ? '阶段一报告' : '阶段二报告')
    }
    return text('收到报告。')
  })
  try {
    await app.input('开始')
    const parent = await app.parent()
    await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '持续任务', task: '阶段一' }, signal())
    await until(() => workerTurns === 1 && !app.ctx.agents.get(childId), 'first activation released')
    await app.ctx.orchestrator.message(parent, { agent_id: childId, message: '继续阶段二' }, signal())
    await until(() => workerTurns === 2 && !app.ctx.agents.get(childId), 'same child resumed and released')
    assert.equal([...app.events.keys()].filter(id => id.startsWith('orchestrator-worker-')).length, 1)
  } finally { await app.dispose() }
})

test('cancel drains worker, denies late effects and lets the main session accept a new request', { timeout: 15000 }, async () => {
  const started = Promise.withResolvers()
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      started.resolve()
      await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
      return call('write', { file_path: 'late.txt', content: 'must not happen' })
    }
    return text('主会话在线。')
  })
  try {
    await app.input('开始')
    const parent = await app.parent()
    await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '慢任务', task: '工作' }, signal())
    await started.promise
    assert.equal(await app.bridge.cancel(app.message('/cancel')), true)
    assert.equal(app.ctx.agents.get(childId), undefined)
    await assert.rejects(access(join(app.workspace, 'late.txt')))
    await assert.rejects(app.ctx.orchestrator.message(parent, { agent_id: childId, message: '继续写' }, signal()))
    const previous = app.sent.length
    await app.input('聊个新话题')
    await until(() => app.sent.length > previous, 'parent usable after cancellation')
    await assert.rejects(app.ctx.orchestrator.message(parent, { agent_id: childId, message: '继续旧任务' }, signal()))
  } finally { await app.dispose() }
})

test('frontdesk path guards and worker channel restrictions survive permissive hooks', { timeout: 15000 }, async () => {
  const hold = Promise.withResolvers()
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) await Promise.race([hold.promise, new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))])
    return text('完成。')
  })
  try {
    await app.input('开始')
    const parent = await app.parent()
    await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '边界验证', task: '等待' }, signal())
    const child = app.ctx.agents.get(childId)
    app.ctx.on('tools/pre-execute', () => ({ kind: 'allow' }), { prepend: true })
    const privateDir = join(app.root, 'private')
    await mkdir(join(privateDir, 'child'), { recursive: true })
    await writeFile(join(privateDir, 'secret.txt'), 'synthetic private')
    await symlink(join(privateDir, 'child'), join(app.workspace, 'escape'))
    for (const [agent, name, args] of [
      [parent, 'write', { file_path: 'main.txt', content: 'no' }],
      [parent, 'read', { file_path: '../private/secret.txt' }],
      [parent, 'read', { file_path: 'escape/../secret.txt' }],
      [child, 'send_wechat', { text: 'no' }],
      [child, 'orchestrator_delegate', { label: 'nested', task: 'no' }],
    ]) {
      const result = await execute(app, agent, name, args)
      assert.equal(result.isError, true, JSON.stringify({ role: app.ctx.orchestrator.roleOf(agent)?.kind, name, args, result }))
    }
    assert.equal((await execute(app, child, 'write', { file_path: 'allowed.txt', content: 'yes' })).isError, false)
    assert.equal((await execute(app, child, 'read', { file_path: '../private/secret.txt' })).isError, false, 'worker uses ordinary host file access')
    assert.equal(await readFile(join(privateDir, 'secret.txt'), 'utf8'), 'synthetic private')
    await app.input('另一个会话', { chatId: 'other-chat' })
    const other = app.ctx.agents.roots().find(a => a !== parent)
    await other.whenIdle()
    await assert.rejects(app.ctx.orchestrator.message(other, { agent_id: childId, message: 'wrong owner' }, signal()))
    await assert.rejects(app.ctx.orchestrator.cancel(other, childId))
  } finally { hold.resolve(); await app.dispose() }
})

test('attachment handoff selects real admitted blocks and rejects invented or foreign references', { timeout: 15000 }, async () => {
  const hold = Promise.withResolvers()
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) await Promise.race([hold.promise, new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))])
    return text('收到。')
  })
  try {
    const attachment = await app.ctx.attachments.saveFile({ data: Buffer.from('synthetic attachment'), name: 'menu.txt' })
    const file = app.ctx.attachments.fileHostPath(attachment)
    app.bridge.deps.prepareContent = async message => [{ type: 'text', text: message.content }, { type: 'file', attachment }]
    await app.input('请处理这个附件')
    const parent = await app.parent()
    await parent.whenIdle()
    const input = parent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    const ref = `att-${input.seq}-${input.data.content.findIndex(block => block.attachment)}`
    await assert.rejects(app.ctx.orchestrator.delegate(parent, { label: '伪造', task: '处理', attachments: ['att-0-0'] }, signal()))
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '附件', task: '处理附件', attachments: [ref] }, signal())
    await until(() => app.requests.some(r => r.sessionId === childId), 'child model received admitted file')
    const child = app.ctx.agents.get(childId)
    assert.equal((await execute(app, child, 'read', { file_path: file })).isError, false)
    const childInput = app.events.get(childId).filter(e => e.type === 'user/message').flatMap(e => e.data.content ?? []).find(b => b.type === 'file')
    assert.deepEqual(childInput.attachment, attachment)
    const { childId: otherId } = await app.ctx.orchestrator.delegate(parent, { label: '无附件', task: '另一个任务' }, signal())
    assert.ok(!app.events.get(otherId)?.some(e => e.type === 'user/message' && e.data.content?.some(b => b.type === 'file')), 'unselected attachment is not handed to another task')
    await app.ctx.orchestrator.message(parent, { agent_id: otherId, message: '补充这份附件', attachments: [ref] }, signal())
    assert.equal((await execute(app, app.ctx.agents.get(otherId), 'read', { file_path: file })).isError, false)
  } finally { hold.resolve(); await app.dispose() }
})

test('unknown reply delivery is recorded once and not retried', { timeout: 15000 }, async () => {
  const app = await host(async () => text('测试回复。'), { sendReply: async () => { throw new Error('synthetic timeout after dispatch') } })
  try {
    await app.input('开始')
    await until(() => Object.values(app.state.value.orchestratorDeliveries).some(r => r.status === 'unknown'), 'unknown receipt persisted')
    const parent = await app.parent()
    const ended = parent.session.snapshotEvents().find(e => e.type === 'turn/end')
    app.bridge.observe(parent.session, ended)
    await app.bridge.deliveries.get(parent.id)
    assert.equal(app.sent.length, 1)
    assert.match(await app.bridge.statusText(app.message('/status')), /发送结果待核实：1/)
  } finally { await app.dispose() }
})

test('/new creates a new parent, preserves old log and rejects the old child', { timeout: 15000 }, async () => {
  const app = await host(async () => text('收到。'))
  try {
    await app.input('旧话题')
    const old = await app.parent()
    await old.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(old, { label: '旧任务', task: '旧任务' }, signal())
    await until(() => !app.ctx.agents.get(childId), 'old child settled')
    const reset = app.message('/new')
    await app.bridge.cancel(reset)
    await app.bridge.enqueue(reset, ticket => app.bridge.reset(reset, ticket))
    await app.input('新话题')
    const fresh = await app.parent()
    assert.notEqual(fresh.id, old.id)
    assert.ok(await app.ctx.sessionPersistence.stat(old.id))
    await assert.rejects(app.ctx.orchestrator.message(fresh, { agent_id: childId, message: '继续' }, signal()))
  } finally { await app.dispose() }
})
