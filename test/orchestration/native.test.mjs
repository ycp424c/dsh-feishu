import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { host, text, call, until } from './harness.mjs'

test('native worker runs while parent answers, then writes and reads back before parent delivery', { timeout: 20000 }, async () => {
  const gate = Promise.withResolvers()
  let parentSteps = 0, workerSteps = 0, childId
  const app = await host(async (request, ctx) => {
    const child = ctx.agents.get(request.sessionId)
    if (child?.session.header.parentSession) {
      childId = child.id
      switch (++workerSteps) {
        case 1: await gate.promise; return call('skill', { name: 'demo-record' })
        case 2: return call('write', { file_path: 'result.txt', content: 'verified output' })
        case 3: return call('read', { file_path: 'result.txt' })
        default: return text('已写入 result.txt 并读回 verified output。')
      }
    }
    switch (++parentSteps) {
      case 1: return call('orchestrator_delegate', { label: '写入验证', task: '完成工作并读回验证。' })
      case 2: return text('已开始处理。')
      case 3: return text('可以，任务执行期间我也能继续聊。')
      default: return text('子任务已完成，文件写入并读回核验。')
    }
  })
  try {
    const skillDir = join(app.workspace, '.dsh/skills/demo-record')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: demo-record\ndescription: Write a demo record and verify by reading it back.\n---\nWrite result.txt, then read it back before reporting completion.\n')
    const admitted = await app.input('开始任务，不把这句私聊闲话传给子代理。')
    assert.equal(admitted.delivery, 'managed')
    await until(() => workerSteps === 1 && app.sent.length === 1, 'parent first reply and running worker')
    assert.equal(app.ctx.agents.get(childId).status, 'running')
    await app.input('你还在吗？')
    await until(() => app.sent.length === 2, 'parent responds while worker remains blocked')
    assert.equal(app.ctx.agents.get(childId).status, 'running')
    gate.resolve()
    await until(() => app.sent.length === 3, 'native settlement wakes parent and sends completion')
    assert.equal(await readFile(join(app.workspace, 'result.txt'), 'utf8'), 'verified output')
    assert.match(app.sent[2].content, /核验/)
    const workerRequest = app.requests.find(r => r.sessionId === childId)
    assert.ok(workerRequest)
    assert.ok(!JSON.stringify(workerRequest.messages).includes('私聊闲话'))
    const events = app.events.get(childId)
    const results = events.filter(e => e.type === 'tool/result')
    assert.equal(results.length, 3)
    assert.ok(results.every(e => !e.data.message.isError))
    assert.ok(app.sent.every(item => !item.content.startsWith('已写入 result.txt')))
    assert.ok(Object.values(app.state.value.orchestratorDeliveries).every(r => r.status === 'sent'))
  } catch (error) {
    console.error('native diagnostics', JSON.stringify([...app.events].map(([id, events]) => ({ id, events: events.filter(e => ['tool/result', 'turn/end'].includes(e.type)) }))), app.errors)
    throw error
  } finally { gate.resolve(); await app.dispose() }
})
