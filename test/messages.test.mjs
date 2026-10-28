import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageReceiver } from '../src/messages.mjs'
import { Conversations } from '../src/conversations.mjs'
import { FeishuReplies } from '../src/replies.mjs'
import { TypingIndicators } from '../src/typing.mjs'
import { hash } from '../src/policy.mjs'

const group = { chatType: 'group', chatId: 'oc_group', messageId: 'om_root', senderId: 'ou_owner', mentionedBot: true, content: 'hello' }
function gate() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture({ hang = false, failure = false, addGate, sendGate, addCode = 0, replyCode = 0, removeCode = 0 } = {}) {
  const events = [], agents = new Map(), sessions = [], audits = []
  const state = { value: { receipts: {}, generations: {} }, pending: Promise.resolve(), async save() {} }
  const config = { appId: 'test', domain: 'feishu', workspace: '/synthetic', provider: 'test', model: 'test', agentPreset: 'standard', dmMode: 'open', groupPolicy: 'open', requireMention: true, maxTurnMs: 0, approvalTimeoutMs: 300000 }
  const metrics = { rejected: 0, received: 0, completed: 0, failed: 0, sent: 0, sendFailed: 0 }
  const channel = { rawClient: { im: { v1: {
    messageReaction: {
      async create(payload) {
        events.push(['add', payload.path.message_id, payload.data.reaction_type.emoji_type])
        if (addGate) await addGate.promise
        return { code: addCode, data: { reaction_id: 'reaction:' + payload.path.message_id } }
      },
      async delete(payload) { events.push(['remove', payload.path.message_id, payload.path.reaction_id]); return { code: removeCode } },
    },
    message: { async reply(payload) {
      events.push(['send', payload.path.message_id, JSON.parse(payload.data.content).zh_cn.content[0][0].text, payload.data.reply_in_thread])
      if (sendGate) await sendGate.promise
      events.push(['delivered', payload.path.message_id])
      return { code: replyCode, data: { message_id: 'reply:' + events.length, thread_id: 'omt_topic' } }
    } },
  } } }, async send() { throw new Error('unexpected main-chat send') } }
  const audit = async (event, fields) => audits.push({ event, ...fields })
  const bridge = new Conversations({
    agents: { get: id => agents.get(id), async create({ sessionId }) {
      sessions.push(sessionId)
      const history = []
      let idle
      const agent = { session: { id: sessionId, seq: 0, snapshotEvents: () => history }, status: 'idle',
        followup() {
          events.push(['model', sessionId]); this.status = 'running'; idle = gate()
          if (!hang) queueMicrotask(() => this.end(failure ? 'error' : 'completed'))
        },
        end(kind) {
          history.push({ seq: this.session.seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } })
          history.push({ seq: this.session.seq++, type: 'turn/end', data: { reason: { kind } } })
          this.status = 'idle'; idle?.resolve()
        },
        whenIdle() { return idle.promise }, cancel() { this.end('cancelled') },
      }
      agents.set(sessionId, agent)
      return { agent, async dispose() { agents.delete(sessionId) } }
    } },
    sessionPersistence: { async stat() {} }, sessions: { async flush() {} },
    agentPresets: { async resolve() { return { id: 'standard' } }, async mount() {} },
    workspaceRegistry: { async resolveByPath() {} }, installModelSelection() {}, sessionId: id => id, createUserMessage: message => message,
  }, config, state)
  const replies = new FeishuReplies(() => channel, state)
  const typing = new TypingIndicators(() => channel.rawClient, state, audit)
  const receive = createMessageReceiver({ config, version: 'test', state, bridge, replies, typing, metrics, audit })
  return { receive, typing, bridge, replies, config, events, state, sessions, audits, metrics }
}
const tick = () => new Promise(r => setImmediate(r))

test('slow and queued tasks use only reactions, with no timed processing message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ hang: true })
  const active = f.receive(group)
  await tick()
  const queued = f.receive({ ...group, messageId: 'om_queue', rootId: 'om_root', threadId: 'omt_topic' })
  await tick()
  t.mock.timers.tick(11000)
  await tick()
  assert.equal(f.events.filter(event => event[0] === 'add').length, 2)
  assert.equal(f.events.filter(event => event[0] === 'send').length, 0)
  f.bridge.running.values().next().value.agent.end('completed')
  await active
  await tick()
  t.mock.timers.tick(11000)
  await tick()
  assert.equal(f.events.filter(event => event[0] === 'send').length, 1)
  f.bridge.running.values().next().value.agent.end('completed')
  await queued
  assert.deepEqual(f.events.filter(event => event[0] === 'send').map(event => event[2]), ['answer', 'answer'])
  assert.ok(f.audits.filter(event => event.event === 'reply.sent').every(event => event.kind === 'final'))
  assert.deepEqual(f.state.value.typingReactions, {})
})

test('reaction starts before model work and is removed only after final delivery', async () => {
  const sending = gate()
  const f = fixture({ sendGate: sending })
  const pending = f.receive(group)
  await tick()
  assert.equal(f.events[0][0], 'add')
  assert.equal(f.events[0][2], 'Typing')
  assert.ok(f.events.some(event => event[0] === 'send' && event[3] === true))
  assert.ok(!f.events.some(event => event[0] === 'remove'))
  sending.resolve()
  await pending
  assert.equal(f.events.at(-1)[0], 'remove')
  assert.equal(f.events.at(-1)[2], 'reaction:om_root')
  assert.deepEqual(f.state.value.typingReactions, {})
  assert.equal(f.state.value.receipts[hash(group.messageId)].status, 'done')
})
test('a late reaction is cleaned after a fast answer without delaying model or reply', async () => {
  const adding = gate(), f = fixture({ addGate: adding })
  const pending = f.receive(group)
  await tick()
  assert.ok(f.events.some(event => event[0] === 'delivered'))
  assert.ok(!f.events.some(event => event[0] === 'remove'))
  adding.resolve()
  await pending
  assert.equal(f.events.at(-1)[0], 'remove')
})
test('non-mention messages are ignored and duplicate deliveries have one model turn and reaction', async () => {
  const f = fixture()
  await f.receive({ ...group, mentionedBot: false })
  assert.deepEqual(f.events, [])
  await Promise.all([f.receive(group), f.receive(group)])
  assert.equal(f.events.filter(event => event[0] === 'add').length, 1)
  assert.equal(f.events.filter(event => event[0] === 'model').length, 1)
})
test('model and reply failure both clean reactions; reaction API failure does not fail a valid task', async () => {
  for (const options of [{ failure: true }, { replyCode: 230011 }, { addCode: 99991400 }]) {
    const f = fixture(options)
    await f.receive(group)
    assert.equal(f.events.filter(event => event[0] === 'remove').length, options.addCode ? 0 : 1)
    assert.deepEqual(f.state.value.typingReactions, {})
    assert.equal(f.metrics.failed, options.addCode ? 0 : 1)
    if (options.replyCode) assert.equal(f.metrics.sendFailed, 1)
  }
})
test('a topic followup reuses the first session and a new group mention has separate context', async () => {
  const f = fixture()
  await f.receive(group)
  const followup = { ...group, messageId: 'om_followup', rootId: 'om_root', threadId: 'omt_topic', senderId: 'ou_member', mentionedBot: false }
  await Promise.all([f.receive(followup), f.receive(followup)])
  assert.equal(f.sessions.length, 1)
  assert.equal(f.events.filter(event => event[0] === 'model').length, 2)
  assert.equal(f.metrics.rejected, 0)
  await f.receive({ ...group, messageId: 'om_new' })
  assert.equal(f.sessions.length, 2)
})
test('confirmed bot topics accept root-only followups and controls without a mention', async () => {
  const f = fixture()
  await f.receive(group)
  const followup = { ...group, rootId: 'om_root', mentionedBot: false }
  await f.receive({ ...followup, messageId: 'om_followup' })
  await f.receive({ ...followup, messageId: 'om_status', content: '/status' })
  await f.receive({ ...followup, messageId: 'om_reset', content: '/new' })
  await f.receive({ ...followup, messageId: 'om_after_reset' })
  assert.equal(f.events.filter(event => event[0] === 'model').length, 3)
  assert.equal(f.sessions.length, 2)
  assert.equal(f.metrics.rejected, 0)
  assert.ok(f.events.filter(event => event[0] === 'send').every(event => event[3] === true))
})
test('old topic ownership is retained before receipt expiry cleanup on the first followup', async () => {
  for (const rootOnly of [false, true]) {
    const f = fixture()
    await f.receive(group)
    f.state.value.botThreads = {}
    f.state.value.receipts[hash(group.messageId)].at = Date.now() - 37 * 60 * 60 * 1000
    const followup = { ...group, rootId: 'om_root', threadId: 'omt_topic', mentionedBot: false }
    await f.receive({ ...followup, messageId: 'om_migration', ...(rootOnly ? { threadId: undefined, mentionedBot: true } : {}) })
    assert.equal(f.state.value.receipts[hash(group.messageId)], undefined)
    await f.receive({ ...followup, messageId: 'om_after_migration' })
    assert.equal(f.metrics.rejected, 0)
    assert.equal(f.events.filter(event => event[0] === 'model').length, 3)
  }
})
test('unknown topics and other groups stay mention-only, even after a bot reply in an existing topic', async () => {
  const f = fixture()
  await f.receive(group)
  const before = structuredClone(f.state.value.threadRoots)
  await f.receive({ ...group, messageId: 'om_unknown', rootId: 'om_other', threadId: 'omt_other', mentionedBot: false })
  await f.receive({ ...group, chatId: 'oc_other', messageId: 'om_cross_group', rootId: 'om_root', threadId: 'omt_topic', mentionedBot: false })
  assert.deepEqual(f.state.value.threadRoots, before)
  assert.equal(f.metrics.rejected, 2)

  // A successful reply inside someone else's topic does not make it bot-created.
  for (const threadId of ['omt_topic', undefined]) {
    const existing = fixture()
    await existing.receive({ ...group, messageId: 'om_existing_at', rootId: 'om_existing_root', threadId })
    await existing.receive({ ...group, messageId: 'om_existing_followup', rootId: 'om_existing_root', threadId: 'omt_topic', mentionedBot: false })
    assert.equal(existing.metrics.rejected, 1)
    assert.equal(existing.events.filter(event => event[0] === 'model').length, 1)
  }
})
test('admission alone and failed topic delivery do not enable unmentioned followups', async () => {
  for (const options of [{ hang: true }, { replyCode: 230011 }]) {
    const f = fixture(options)
    const first = f.receive(group)
    if (options.hang) await tick()
    else await first
    await f.receive({ ...group, messageId: 'om_no_receipt', rootId: 'om_root', mentionedBot: false })
    assert.equal(f.metrics.rejected, 1)
    if (options.hang) {
      f.bridge.running.values().next().value.agent.end('completed')
      await first
    }
  }
})
test('bot topic auto replies respect global and per-group opt-outs and group access policy', async () => {
  for (const override of [
    { groupThreadAutoReply: false },
    { groups: { oc_group: { threadAutoReply: false } } },
    { groups: { '*': { threadAutoReply: false } } },
    { groups: { oc_group: { enabled: false } } },
    { groupPolicy: 'disabled' },
    { groupPolicy: 'allowlist', groupAllowlist: [] },
  ]) {
    const f = fixture()
    await f.receive(group)
    Object.assign(f.config, override)
    await f.receive({ ...group, messageId: 'om_followup', rootId: 'om_root', threadId: 'omt_topic', mentionedBot: false })
    assert.equal(f.metrics.rejected, 1)
    assert.equal(f.events.filter(event => event[0] === 'model').length, 1)
  }
  const f = fixture()
  await f.receive(group)
  Object.assign(f.config, { groupThreadAutoReply: false, groups: { oc_group: { threadAutoReply: true } } })
  await f.receive({ ...group, messageId: 'om_followup', rootId: 'om_root', threadId: 'omt_topic', mentionedBot: false })
  assert.equal(f.metrics.rejected, 0)
  assert.equal(f.events.filter(event => event[0] === 'model').length, 2)
})
test('cancel cleans active and queued topic reactions without starting queued model work', async () => {
  const f = fixture({ hang: true })
  const opening = f.receive(group)
  await tick()
  f.bridge.running.values().next().value.agent.end('completed')
  await opening
  f.events.length = 0
  const topic = { ...group, rootId: 'om_root', threadId: 'omt_topic', mentionedBot: false }
  const active = f.receive({ ...topic, messageId: 'om_active' })
  await tick()
  const queued = f.receive({ ...topic, messageId: 'om_queue' })
  await tick()
  await f.receive({ ...topic, messageId: 'om_cancel', content: '/cancel' })
  await Promise.all([active, queued])
  assert.equal(f.events.filter(event => event[0] === 'model').length, 1)
  assert.deepEqual(f.events.filter(event => event[0] === 'remove').map(event => event[1]).sort(), ['om_active', 'om_cancel', 'om_queue'])
  assert.equal(f.state.value.receipts[hash('om_queue')].status, 'cancelled')
})
test('shutdown stops running and queued turns while the channel is available for reaction cleanup', async () => {
  const f = fixture({ hang: true })
  const active = f.receive(group)
  await tick()
  const queued = f.receive({ ...group, messageId: 'om_queue', rootId: 'om_root', threadId: 'omt_topic' })
  await tick()
  await f.bridge.dispose()
  await f.typing.dispose()
  await Promise.all([active, queued])
  assert.equal(f.events.filter(event => event[0] === 'model').length, 1)
  assert.equal(f.events.filter(event => event[0] === 'remove').length, 2)
  assert.deepEqual(f.state.value.typingReactions, {})
})
test('failed reaction removal is retained and retried on next startup', async () => {
  const f = fixture({ removeCode: 99991400 })
  await f.receive(group)
  assert.equal(Object.keys(f.state.value.typingReactions).length, 1)
  const cleanup = []
  const recovered = new TypingIndicators(() => ({ im: { v1: { messageReaction: { async delete(payload) { cleanup.push(payload); return { code: 0 } } } } } }), f.state)
  await recovered.recover()
  assert.equal(cleanup[0].path.reaction_id, 'reaction:om_root')
  assert.deepEqual(f.state.value.typingReactions, {})
})
