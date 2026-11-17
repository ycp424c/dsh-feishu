import test from 'node:test'
import assert from 'node:assert/strict'
import { host, text, call, until } from './harness.mjs'

const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []

test('the first private-chat model step can delegate its exact current attachment', {
  timeout: 15000, skip: process.platform !== 'linux' && process.env.DSH_NATIVE_TEST !== '1' ? 'Native integration requires a platform addon' : false,
}, async () => {
  let ids, filePath, childId, delegated = false, workerSteps = 0
  const app = await host(async (request, ctx) => {
    const agent = ctx.agents.get(request.sessionId)
    if (agent.session.header.parentSession) {
      childId = agent.id
      return ++workerSteps === 1 ? call('read', { file_path: filePath }) : text('CURRENT_ATTACHMENT_VERIFIED')
    }
    if (!delegated) {
      const context = strings(request.messages).find(value => value.includes('可用 attachment_id=')) ?? ''
      ids = JSON.parse(context.match(/可用 attachment_id=(\[[^\n]*\])/)?.[1] ?? '[]')
      if (!ids.length) return text('Missing current attachment')
      delegated = true
      return call('orchestrator_delegate', { label: '读取本轮附件', task: '读取明确交接的当前附件。', attachments: ids })
    }
    return text('CURRENT_ATTACHMENT_VERIFIED')
  })
  try {
    const attachment = await app.ctx.attachments.saveFile({ data: Buffer.from('CURRENT_ATTACHMENT_VERIFIED'), name: 'current.txt' })
    filePath = app.ctx.attachments.fileHostPath(attachment)
    app.bridge.deps.prepareContent = async message => [{ type: 'text', text: message.content }, { type: 'file', attachment }]
    await app.input('读取本轮附件。')
    await until(() => ids !== undefined, 'first model step sees attachment handoff IDs')
    assert.equal(ids.length, 1, 'current inbox attachments are visible before their session event is appended')
    await until(() => childId && app.events.get(childId)?.some(event => event.type === 'tool/result'), 'worker reads the selected current file')
    const results = app.events.get(childId).filter(event => event.type === 'tool/result')
    assert.ok(results.some(event => !event.data.message.isError && JSON.stringify(event.data.message.content).includes('CURRENT_ATTACHMENT_VERIFIED')))
  } finally { await app.dispose() }
})
