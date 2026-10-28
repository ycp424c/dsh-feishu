import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowed, conversationKey, sessionId, summarize, taskStatus } from '../src/policy.mjs'
import { State } from '../src/state.mjs'
import { Conversations } from '../src/conversations.mjs'

const cfg = { appId: 'synthetic', domain: 'feishu', workspace: '/synthetic', stateDir: '/synthetic', provider: 'test', model: 'test', agentPreset: 'standard', maxTurnMs: 500, dmMode: 'allowlist', dmAllowlist: ['ou_ok'], groupPolicy: 'open', groupAllowlist: [], requireMention: true }
const dm = { chatType: 'p2p', chatId: 'oc_dm', senderId: 'ou_ok', messageId: 'm1', content: 'hello' }
test('DM allowlist is matched to the sender open_id, never chat_id', () => {
  assert.equal(allowed(cfg, dm), true)
  assert.equal(allowed(cfg, { ...dm, senderId: 'ou_other' }), false)
  assert.equal(allowed({ ...cfg, dmAllowlist: ['oc_dm'] }, dm), false)
  assert.equal(allowed({ ...cfg, dmMode: 'disabled' }, dm), false)
})
test('group admission retains mention, explicit disabled and allowlist boundaries', () => {
  const m = { ...dm, chatType: 'group', mentionedBot: true }
  assert.equal(allowed(cfg, m), true)
  assert.equal(allowed(cfg, { ...m, mentionedBot: false }), false)
  assert.equal(allowed({ ...cfg, groupPolicy: 'allowlist' }, m), false)
  assert.equal(allowed({ ...cfg, groupPolicy: 'disabled' }, m), false)
  assert.equal(allowed({ ...cfg, groups: { '*': { enabled: false } } }, m), false)
})
test('sessions separate channels/threads/apps while retaining ordinary conversation history', () => {
  const key = conversationKey(dm)
  assert.equal(key, conversationKey({ ...dm, content: 'another', messageId: 'm2' }))
  assert.notEqual(key, conversationKey({ ...dm, threadId: 'thread' }))
  assert.notEqual(key, conversationKey({ ...dm, chatId: 'another' }))
  assert.notEqual(sessionId(cfg, key), sessionId({ ...cfg, appId: 'other-app' }, key))
  assert.notEqual(sessionId(cfg, key), sessionId(cfg, key, 1))
})
test('partial assistant text with failed turn never reports successful completion', () => {
  const events = [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } }, { seq: 1, type: 'turn/end', data: { reason: { kind: 'error' } } }]
  assert.equal(summarize(events, 0).ok, false)
  events[1].data.reason.kind = 'completed'
  assert.equal(summarize(events, 0).ok, true)
  assert.equal(summarize(events, 2).ok, false)
})
function fixture({ persisted = [], hang = false, maxTurnMs = 500, prepareContent } = {}) {
  const all = new Map(), calls = { create: 0, resume: 0, flush: 0, messages: [] }
  function make(id) {
    const events = []; let resolveIdle
    const agent = { status: 'idle', session: { id, seq: 0, snapshotEvents: () => events },
      followup(message) { calls.messages.push(message); this.status = 'running'; this.idle = new Promise(r => { resolveIdle = r }); if (!hang) queueMicrotask(() => this.end('completed', message.content[0].text)) },
      end(kind, text = '') { if (text) events.push({ seq: this.session.seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }); events.push({ seq: this.session.seq++, type: 'turn/end', data: { reason: { kind } } }); this.status = 'idle'; resolveIdle?.() },
      whenIdle() { return this.status === 'idle' ? Promise.resolve() : this.idle },
      cancel() { this.end('cancelled') },
    }
    all.set(id, agent)
    return { agent, async dispose() { all.delete(id) } }
  }
  const state = { value: { generations: {}, receipts: {} }, async save() {}, pending: Promise.resolve() }
  const deps = { agents: { get: id => all.get(id), async create(x) { calls.create++;return make(x.sessionId) }, async resume(x) { calls.resume++; return make(x.resumeSessionId) } }, sessions: { async flush() { calls.flush++ } }, sessionPersistence: { async stat(id) { return persisted.includes(id) ? { header: { id }, revision: {} } : undefined } }, agentPresets: { async resolve() { return { id: 'standard' } }, async mount() {} }, workspaceRegistry: { async resolveByPath() { return { async attachSession() {} } } }, sessionId: x => x, createUserMessage: x => x, installModelSelection() {} }
  return { bridge: new Conversations({ ...deps, prepareContent }, { ...cfg, maxTurnMs }, state), calls, state }
}
test('admitted image and file refs reach the user message without string conversion', async () => {
  const content = [{ type: 'text', text: 'hello' }, { type: 'image', attachment: { attachmentId: 'image' } }, { type: 'file', attachment: { attachmentId: 'file' } }]
  const f = fixture({ prepareContent: async () => content })
  await f.bridge.reply(dm)
  assert.deepEqual(f.calls.messages[0].content, content)
})
test('cancellation or timeout during attachment preparation never starts a late model turn', async () => {
  for (const cancel of [true, false]) {
    let finish, signal
    const f = fixture({ maxTurnMs: cancel ? 500 : 15, prepareContent: async (_, options) => { signal = options.signal; return new Promise(r => { finish = r }) } })
    const pending = f.bridge.reply(dm)
    await new Promise(r => setImmediate(r))
    if (cancel) assert.equal(f.bridge.cancel(dm), true)
    await assert.rejects(pending, { code: cancel ? 'CANCELLED' : 'TIMEOUT' })
    assert.equal(signal.aborted, true)
    finish([{ type: 'text', text: 'late content' }])
    await new Promise(r => setImmediate(r))
    assert.equal(f.calls.messages.length, 0)
    assert.equal(f.bridge.running.size, 0)
  }
})
test('one conversation reuses an agent; reset creates another persisted generation', async () => {
  const f = fixture()
  const a = await f.bridge.reply(dm), b = await f.bridge.reply({ ...dm, content: 'next' })
  assert.equal(a.sessionId, b.sessionId); assert.equal(f.calls.create, 1)
  await f.bridge.reset(dm)
  const c = await f.bridge.reply(dm)
  assert.notEqual(a.sessionId, c.sessionId); assert.equal(f.calls.create, 2)
})
test('a process restart resumes the deterministic persisted session', async () => {
  const id = sessionId(cfg, conversationKey(dm))
  const f = fixture({ persisted: [id] })
  await f.bridge.reply(dm)
  assert.equal(f.calls.create, 0); assert.equal(f.calls.resume, 1)
})
test('only the active task sender can cancel a shared group task', async () => {
  const f = fixture({ hang: true })
  const running = f.bridge.reply(dm)
  await new Promise(r => setTimeout(r, 5))
  assert.equal(f.bridge.cancel({ ...dm, senderId: 'other' }), false)
  assert.equal(f.bridge.cancel(dm), true)
  await assert.rejects(running, { code: 'CANCELLED' })
})
test('turn timeout cancels work instead of waiting forever for web-only approval', async () => {
  const f = fixture({ hang: true, maxTurnMs: 10 })
  await assert.rejects(f.bridge.reply(dm), { code: 'TIMEOUT' })
  assert.equal(f.bridge.running.size, 0)
})
test('disabled turn limit leaves long work active and available through status until cancelled', async () => {
  const f = fixture({ hang: true, maxTurnMs: 0 })
  const pending = f.bridge.reply(dm)
  await new Promise(r => setTimeout(r, 25))
  const turn = f.bridge.running.get(conversationKey(dm))
  assert.ok(turn)
  assert.equal(taskStatus(turn, dm.senderId, turn.startedAt + 125000), '本聊天任务：运行中（已持续 2 分 5 秒；可用 /cancel 取消）')
  assert.equal(taskStatus(turn, 'other', turn.startedAt + 125000), '本聊天任务：其他成员正在执行（已持续 2 分 5 秒）')
  assert.equal(f.bridge.cancel(dm), true)
  await assert.rejects(pending, { code: 'CANCELLED' })
})
test('same-chat tasks serialize but separate chats can proceed concurrently', async () => {
  const f = fixture(); const events = []
  await Promise.all([
    f.bridge.enqueue(dm, async () => { events.push('a'); await new Promise(r => setTimeout(r, 10)); events.push('b') }),
    f.bridge.enqueue(dm, async () => events.push('c')),
    f.bridge.enqueue({ ...dm, chatId: 'other' }, async () => events.push('x')),
  ])
  assert.ok(events.indexOf('c') > events.indexOf('b'));assert.ok(events.indexOf('x') < events.indexOf('b'))
})
test('/cancel clears the sender\'s queued work without dropping another sender\'s message', async () => {
  const f = fixture({ hang: true, maxTurnMs: 0 })
  const events = []
  const active = f.bridge.enqueue(dm, ticket => f.bridge.reply(dm, ticket))
  await new Promise(r => setImmediate(r))
  const queued = f.bridge.enqueue({ ...dm, messageId: 'm2' }, () => events.push('stale'), () => events.push('cancelled'))
  const other = f.bridge.enqueue({ ...dm, senderId: 'other', messageId: 'm3' }, () => events.push('other'))
  assert.equal(f.bridge.cancel(dm), true)
  assert.deepEqual(events, ['cancelled'])
  await assert.rejects(active, { code: 'CANCELLED' })
  await Promise.all([queued, other])
  assert.deepEqual(events, ['cancelled', 'other'])
  assert.equal(f.bridge.waiting.size, 0)
  assert.equal(f.bridge.queues.size, 0)
})
test('/cancel during queued startup prevents a model turn after async session loading', async () => {
  const f = fixture({ maxTurnMs: 0 })
  const originalGet = f.bridge.get.bind(f.bridge)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.bridge.get = async key => { await gate; return originalGet(key) }
  const pending = f.bridge.enqueue(dm, ticket => f.bridge.reply(dm, ticket))
  await new Promise(r => setImmediate(r))
  assert.equal(f.bridge.otherSenderActive({ ...dm, senderId: 'other' }), true)
  assert.equal(f.bridge.otherSenderActive(dm), false)
  assert.equal(f.bridge.cancel(dm), true)
  release()
  await assert.rejects(pending, { code: 'CANCELLED' })
  assert.equal(f.calls.messages.length, 0)
})
test('/cancel does not claim to stop a completed turn while its final reply is sending', async () => {
  const f = fixture({ maxTurnMs: 0 })
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const delivering = new Promise(resolve => { entered = resolve })
  const pending = f.bridge.enqueue(dm, async ticket => {
    const result = await f.bridge.reply(dm, ticket)
    entered()
    await gate
    return result
  })
  await delivering
  assert.equal(f.bridge.cancel(dm), false)
  release()
  await pending
})
test('/cancel does not claim to stop a failed turn while its error reply is sending', async () => {
  const f = fixture({ maxTurnMs: 0 })
  f.bridge.get = async () => { throw new Error('session unavailable') }
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const delivering = new Promise(resolve => { entered = resolve })
  const pending = f.bridge.enqueue(dm, async ticket => {
    try { await f.bridge.reply(dm, ticket) }
    catch { entered(); await gate; return 'failed receipt' }
  })
  await delivering
  assert.equal(f.bridge.cancel(dm), false)
  release()
  assert.equal(await pending, 'failed receipt')
})
test('/cancel during /new disposal does not advance the shared session generation', async () => {
  const f = fixture({ maxTurnMs: 0 })
  const handle = await f.bridge.get(conversationKey(dm))
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const disposing = new Promise(resolve => { entered = resolve })
  handle.dispose = async () => { entered(); await gate }
  const pending = f.bridge.enqueue(dm, ticket => f.bridge.reset(dm, ticket))
  await disposing
  assert.equal(f.bridge.cancel(dm), true)
  release()
  await assert.rejects(pending, { code: 'CANCELLED' })
  assert.equal(f.state.value.generations[conversationKey(dm)], undefined)
})
test('durable generations survive reload; corrupt state fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-state-'));const path = join(dir, 'state.json')
  try {
    const a = new State(path);await a.load();a.value.generations.abc = 3;await a.save()
    const b = new State(path);await b.load();assert.equal(b.value.generations.abc, 3)
    assert.ok((await readFile(path, 'utf8')).includes('generations'))
    await writeFile(path, 'broken');await assert.rejects(new State(path).load())
  } finally { await rm(dir, { recursive: true, force: true }) }
})
