import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageReceiver } from 'dsh-feishu/core/messages'
import { hash } from 'dsh-feishu/core/policy'
import { host, text, until } from './harness.mjs'

test('receiver acknowledges admission without a second reply and supports /status and /new', { timeout: 15000 }, async () => {
  const app = await host(async () => text('主会话回复。'))
  const controls = [], metrics = { received: 0, rejected: 0, completed: 0, failed: 0, sent: 0, sendFailed: 0 }
  const receive = createMessageReceiver({
    config: { ...app.config, dmMode: 'allowlist', dmAllowlist: ['synthetic-user'] }, version: 'test', state: app.state, bridge: app.bridge, metrics,
    audit: async () => {}, typing: { start: () => ({ stop: async () => {} }) },
    replies: { isBotThread: () => false, route: m => m, send: async (_, content) => { controls.push(content); return { messageId: crypto.randomUUID() } } },
  })
  try {
    const input = app.message('开始')
    await receive(input)
    await receive(input)
    await until(() => app.sent.length === 1, 'one root reply')
    assert.equal(controls.length, 0)
    assert.equal(metrics.accepted, 1)
    assert.equal(metrics.completed, 0)
    await receive(app.message('/status'))
    assert.match(controls[0], /主会话：idle/)
    const old = await app.parent()
    await receive(app.message('/new'))
    assert.match(controls.at(-1), /已开启新的/)
    await receive(app.message('新消息'))
    assert.notEqual((await app.parent()).id, old.id)
    await receive(app.message('陌生人', { senderId: 'foreign' }))
    assert.equal(metrics.rejected, 1)
  } finally { await app.dispose() }
})

test('cancel during attachment preparation aborts download without a late model request', { timeout: 15000 }, async () => {
  const preparing = Promise.withResolvers()
  const app = await host(async () => text('不应出现。'), { deps: {
    prepareContent: async (_, { signal }) => {
      preparing.resolve()
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  } })
  try {
    const work = app.input('附件下载中')
    const rejected = assert.rejects(work, /CANCELLED/)
    await preparing.promise
    assert.equal(await app.bridge.cancel(app.message('/cancel')), true)
    await rejected
    assert.equal(app.requests.length, 0)
  } finally { await app.dispose() }
})

test('authenticated local probe does not send to an IM recipient', { timeout: 15000 }, async () => {
  const app = await host(async () => text('探针结果。'))
  try {
    await app.input('本地探针', { chatId: 'local-probe:acceptance' })
    const parent = app.ctx.agents.roots()[0]
    await parent.whenIdle()
    assert.equal(app.sent.length, 0)
    assert.ok(parent.session.snapshotEvents().some(e => e.type === 'assistant/message'))
  } finally { await app.dispose() }
})

test('/new preserves a failed receipt when asynchronous cancellation or reset fails', { timeout: 15000 }, async () => {
  const app = await host(() => text('不应调用模型。'))
  const controls = [], metrics = { received: 0, rejected: 0, completed: 0, failed: 0, sent: 0, sendFailed: 0 }
  const receive = createMessageReceiver({
    config: { ...app.config, dmMode: 'allowlist', dmAllowlist: ['synthetic-user'] }, version: 'test', state: app.state, bridge: app.bridge, metrics,
    audit: async () => {}, typing: { start: () => ({ stop: async () => {} }) },
    replies: { isBotThread: () => false, route: m => m, send: async (_, content) => { controls.push(content); return { messageId: crypto.randomUUID() } } },
  })
  try {
    const cancel = app.bridge.cancel.bind(app.bridge)
    app.bridge.cancel = async () => { throw new Error('Synthetic stop failure') }
    const first = app.message('/new'); await receive(first)
    assert.equal(app.state.value.receipts[hash(first.messageId)].status, 'failed')
    app.bridge.cancel = cancel
    app.bridge.reset = async () => { throw new Error('Synthetic reset failure') }
    const second = app.message('/new'); await receive(second)
    assert.equal(app.state.value.receipts[hash(second.messageId)].status, 'failed')
    assert.equal(metrics.failed, 2)
    assert.equal(controls.length, 2)
    assert.ok(controls.every(content => !content.includes('已开启新的')))
    assert.equal(app.requests.length, 0)
  } finally { await app.dispose() }
})
