import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { host, text, call, until, llm } from './harness.mjs'

const signal = () => new AbortController().signal
const tool = (name, execute) => defineTool({ name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] }, execute })
const invoke = (app, agent, name) => app.ctx.tools.execute({ callId: llm.ToolCallId(crypto.randomUUID()), agent, name, arguments: {}, signal: signal() })

test('frontdesk delegates external work and acknowledges while its worker is still running', { timeout: 15000 }, async () => {
  const release = Promise.withResolvers(), started = Promise.withResolvers()
  let delegated = false, parentTools, childTools
  const app = await host(async (request, ctx) => {
    const names = request.tools.map(tool => tool.name)
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      childTools = names
      started.resolve(); await release.promise
      return text('执行结果。')
    }
    parentTools = names
    if (!delegated) { delegated = true; return call('orchestrator_delegate', { label: '重新找图', task: '完成实际搜图和下载。' }) }
    return text('已交给执行子代理继续找图。')
  })
  try {
    await app.input('重新再找一次看看')
    await started.promise
    for (const name of ['web_search', 'web_fetch', 'bash']) assert.ok(!parentTools.includes(name), `frontdesk must delegate ${name}`)
    assert.ok(parentTools.includes('orchestrator_delegate'))
    for (const name of ['bash', 'web_search', 'web_fetch']) assert.ok(childTools.includes(name), `worker has ${name}`)
    await until(() => app.sent.length > 0, 'parent replies before child finishes')
    assert.equal(app.sent[0].content, '已交给执行子代理继续找图。')
    const children = await app.ctx.orchestrator.list(await app.parent())
    assert.equal(children.length, 1)
    assert.equal(app.ctx.agents.get(children[0].childId).status, 'running')
  } finally { release.resolve(); await app.dispose() }
})

test('an existing child gains a late plugin tool and continues with native Shell in the same session', { timeout: 15000 }, async () => {
  let resumed = false, steps = 0, childId
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 10, 128])
  const app = await host((request, ctx) => {
    if (!ctx.agents.get(request.sessionId).session.header.parentSession) return text('主会话在线。')
    childId ??= request.sessionId
    assert.equal(request.sessionId, childId)
    if (!resumed) return text('等待补充工具，然后继续同一任务。')
    if (++steps === 1) {
      const names = request.tools.map(t => t.name)
      for (const name of ['image_download', 'bash']) assert.ok(names.includes(name), `${name} visible after resume`)
      return call('image_download', {})
    }
    if (steps === 2) return call('bash', { description: '复制已下载的二进制图片并完成验收', command: 'cp downloaded.png copied.png' })
    return text('已下载并复制图片。')
  })
  try {
    await app.input('开始')
    const parent = await app.parent(); await parent.whenIdle()
    await app.ctx.orchestrator.delegate(parent, { label: '下载图片', task: '下载图片，缺工具时保留上下文。' }, signal())
    await until(() => childId && !app.ctx.agents.get(childId), 'child waiting and released')
    app.ctx.tools.register(tool('image_download', async () => { await writeFile(join(app.workspace, 'downloaded.png'), bytes); return 'downloaded.png' }))
    resumed = true
    await app.ctx.orchestrator.message(parent, { agent_id: childId, message: '工具已经补齐，继续。' }, signal())
    await until(async () => (await readFile(join(app.workspace, 'copied.png')).catch(() => undefined))?.equals(bytes), 'native Shell copies downloaded binary')
    assert.ok(app.requests.filter(r => r.sessionId === childId).length >= 3)
    assert.equal((await app.ctx.orchestrator.list(parent)).length, 1, 'no replacement task created')
  } finally { await app.dispose() }
})

test('worker inherits execution plugins but cannot use direct channel tools, including late registrations', { timeout: 15000 }, async () => {
  const hold = Promise.withResolvers(), started = Promise.withResolvers()
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) { started.resolve(); await hold.promise }
    return text('完成。')
  })
  let externalCalls = 0
  try {
    await app.input('开始'); const parent = await app.parent(); await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '边界', task: '等待检查' }, signal())
    await started.promise
    const child = app.ctx.agents.get(childId)
    for (const name of ['message', 'send_wechat']) app.ctx.tools.register(tool(name, async () => { externalCalls++; return 'must not execute' }))
    app.ctx.tools.register(tool('business_lookup', async () => 'allowed execution plugin'))
    app.ctx.on('tools/pre-execute', () => ({ kind: 'allow' }), { prepend: true })
    assert.equal((await invoke(app, child, 'business_lookup')).isError, false)
    assert.equal((await invoke(app, parent, 'business_lookup')).isError, true)
    for (const name of ['message', 'send_wechat']) assert.equal((await invoke(app, child, name)).isError, true)
    assert.equal(externalCalls, 0)
  } finally { hold.resolve(); await app.dispose() }
})

test('cancelling the child stops an executing Shell command before its later write', { timeout: 15000 }, async () => {
  let called = false
  const app = await host((request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession && !called) {
      called = true
      return call('bash', { description: '测试取消正在运行的子任务命令', command: 'printf started > started.txt; sleep 2; printf late > late.txt', timeoutMs: 10000 })
    }
    return text('收到。')
  })
  try {
    await app.input('开始'); const parent = await app.parent(); await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '运行命令', task: '执行慢命令' }, signal())
    await until(() => access(join(app.workspace, 'started.txt')).then(() => true, () => false), 'command really starts')
    await app.bridge.cancel(app.message('/cancel'))
    assert.equal(app.ctx.agents.get(childId), undefined)
    await new Promise(resolve => setTimeout(resolve, 2200))
    await assert.rejects(access(join(app.workspace, 'late.txt')))
  } finally { await app.dispose() }
})
