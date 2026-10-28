import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuReplies, markdownChunks } from '../src/replies.mjs'
import { conversationKey, hash } from '../src/policy.mjs'
import { State } from '../src/state.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const group = { chatType: 'group', chatId: 'oc_group', messageId: 'om_root' }
function fixture(response = { code: 0, data: { message_id: 'om_reply', thread_id: 'omt_topic' } }, state = { value: {}, async save() {} }) {
  const sent = [], direct = []
  const channel = {
    rawClient: { im: { v1: { message: { async reply(payload) { sent.push(payload); return response } } } } },
    async send(...args) { direct.push(args); return { messageId: 'om_dm' } },
  }
  return { replies: new FeishuReplies(() => channel, state), sent, direct, state }
}
test('all long group reply chunks stay in the originating topic, including a long single line', async () => {
  const f = fixture()
  const message = f.replies.route(group)
  const result = await f.replies.send(message, '🙂'.repeat(9000))
  assert.equal(f.sent.length, 3)
  assert.equal(result.chunkIds.length, 3)
  assert.equal(f.direct.length, 0)
  const chunks = f.sent.map(payload => {
    assert.equal(payload.path.message_id, 'om_root')
    assert.equal(payload.data.reply_in_thread, true)
    assert.equal(payload.data.msg_type, 'post')
    return JSON.parse(payload.data.content).zh_cn.content[0][0].text
  })
  assert.equal(chunks.join(''), '🙂'.repeat(9000))
  assert.ok(chunks.every(chunk => !chunk.includes('\ufffd') && Array.from(chunk).length <= 3500))
})
test('withdrawn targets, thrown errors, API failures and missing receipts never fall back to the group', async () => {
  for (const response of [{ code: 230011 }, { code: 99991400 }, { code: 0, data: {} }]) {
    const f = fixture(response)
    await assert.rejects(f.replies.send(f.replies.route(group), 'answer'), { code: 'FEISHU_REPLY_FAILED' })
    assert.equal(f.direct.length, 0)
    assert.equal(f.sent.length, 1)
  }
  const f = fixture()
  f.replies.getChannel().rawClient.im.v1.message.reply = async () => { throw new Error('unavailable') }
  await assert.rejects(f.replies.send(f.replies.route(group), 'answer'))
  assert.equal(f.direct.length, 0)
})
test('topic continuation retains the first turn session after durable state reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-thread-'))
  try {
    const state = new State(join(dir, 'state.json'))
    await state.load()
    const f = fixture(undefined, state)
    const first = f.replies.route(group)
    const second = f.replies.route({ ...group, messageId: 'om_another_question' })
    assert.notEqual(conversationKey(first), conversationKey(second))
    await f.replies.send(first, 'answer')
    const reloaded = new State(state.path)
    await reloaded.load()
    const restarted = fixture(undefined, reloaded)
    for (const rootId of ['om_root', undefined]) {
      const followup = restarted.replies.route({ ...group, messageId: 'om_followup', threadId: 'omt_topic', rootId })
      assert.equal(conversationKey(first), conversationKey(followup))
    }
    const otherGroup = restarted.replies.route({ ...group, chatId: 'oc_other', threadId: 'omt_topic' })
    assert.notEqual(conversationKey(first), conversationKey(otherGroup))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('private chats retain normal sending and group thread mode can be disabled', async () => {
  const f = fixture()
  const dm = { ...group, chatType: 'p2p' }
  assert.equal(f.replies.route(dm), dm)
  await f.replies.send(dm, 'answer')
  assert.equal(f.direct[0][2].replyInThread, false)
  f.replies.groupReplyInThread = false
  assert.equal(f.replies.route(group), group)
  await f.replies.send(group, 'answer')
  assert.equal(f.sent.length, 0)
})
test('legacy topics keep their existing session and root IDs handle replies without a thread receipt', async () => {
  const f = fixture({ code: 0, data: { message_id: 'om_reply' } })
  const legacy = { ...group, messageId: 'om_old_followup', rootId: 'om_old_root', threadId: 'omt_old_topic' }
  assert.equal(conversationKey(f.replies.route(legacy)), conversationKey(legacy))
  const first = f.replies.route(group)
  await f.replies.send(first, 'answer')
  const next = f.replies.route({ ...group, messageId: 'om_followup', rootId: 'om_root', threadId: 'omt_new_topic' })
  assert.equal(conversationKey(first), conversationKey(next))
})
test('long fenced code is closed and reopened with the original language', () => {
  const chunks = markdownChunks('before\n```js\n' + 'const x = 1;\n'.repeat(700) + '```\nafter')
  assert.ok(chunks.length > 1)
  assert.ok(chunks[0].endsWith('\n```'))
  assert.ok(chunks[1].startsWith('```js\n'))
  assert.ok(chunks.every(chunk => (chunk.match(/^```/gm) ?? []).length === 2))
  assert.ok(chunks.at(-1).endsWith('after'))
})
test('only successfully created bot topics enable auto replies, with durable chat-scoped aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-bot-thread-'))
  try {
    const state = new State(join(dir, 'state.json'))
    await state.load()
    const f = fixture(undefined, state)
    const first = f.replies.route(group)
    const followup = { ...group, messageId: 'om_followup', rootId: 'om_root', threadId: 'omt_topic' }
    assert.equal(f.replies.isBotThread(followup), false)
    await f.replies.send(first, 'answer')
    const reloaded = new State(state.path)
    await reloaded.load()
    const restarted = fixture(undefined, reloaded)
    for (const message of [followup, { ...followup, rootId: undefined }]) {
      assert.equal(restarted.replies.isBotThread(message), true)
      assert.equal(conversationKey(restarted.replies.route(message)), conversationKey(first))
    }
    const mainChatQuote = { ...followup, threadId: undefined }
    assert.equal(restarted.replies.isBotThread(mainChatQuote), false)
    assert.equal(restarted.replies.isBotThread({ ...mainChatQuote, threadId: 'omt_unrelated' }), false)
    // Root aliases still retain context for an explicitly admitted @Bot quote.
    assert.equal(conversationKey(restarted.replies.route(mainChatQuote)), conversationKey(first))
    assert.equal(restarted.replies.isBotThread(group), false)
    assert.equal(restarted.replies.isBotThread({ ...followup, chatId: 'oc_other' }), false)
    restarted.replies.groupReplyInThread = false
    assert.equal(restarted.replies.isBotThread(followup), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('previous versions bot-created topic receipts remain usable without trusting admission-only roots', async () => {
  const f = fixture()
  f.state.value.receipts = { [hash(group.messageId)]: { status: 'done', at: Date.now() } }
  const first = f.replies.route(group)
  await f.replies.send(first, 'answer')
  delete f.state.value.botThreads
  const restarted = fixture(undefined, f.state)
  assert.equal(restarted.replies.isBotThread({ ...group, messageId: 'om_followup', threadId: 'omt_topic' }), true)
  assert.equal(restarted.replies.isBotThread({ ...group, messageId: 'om_followup', rootId: 'om_root' }), false)
  assert.equal(restarted.replies.isBotThread({ ...group, messageId: 'om_unknown', threadId: 'omt_unknown' }), false)
})
test('old root-only replies in user-created topics are not proof that the bot created them', async () => {
  const f = fixture()
  const legacy = { ...group, messageId: 'om_user_topic_followup', rootId: 'om_user_topic_root' }
  f.state.value.receipts = { [hash(legacy.messageId)]: { status: 'done', at: Date.now() } }
  await f.replies.send(f.replies.route(legacy), 'answer')
  delete f.state.value.botThreads
  const restarted = fixture(undefined, f.state)
  assert.equal(restarted.replies.isBotThread({ ...legacy, threadId: 'omt_topic' }), false)
})
test('a root-only mentioned followup recovers old bot topic ownership from the outgoing receipt', async () => {
  const f = fixture()
  f.state.value.receipts = { [hash(group.messageId)]: { status: 'done', at: Date.now() } }
  await f.replies.send(f.replies.route(group), 'answer')
  delete f.state.value.botThreads
  const restarted = fixture(undefined, f.state)
  const followup = { ...group, messageId: 'om_old_followup', rootId: 'om_root', threadId: 'omt_topic' }
  assert.equal(restarted.replies.isBotThread(followup), true)
  const rootOnly = { ...followup, threadId: undefined }
  await restarted.replies.send(restarted.replies.route(rootOnly), 'answer')
  assert.equal(restarted.replies.isBotThread(followup), true)
  assert.equal(restarted.replies.isBotThread(rootOnly), false)
})
