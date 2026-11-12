import { hash } from './policy.mjs'

// Internal admission proof survives receipt cleanup while a legacy reply awaits
// its thread ID. A remote message cannot supply this module-private Symbol.
const admittedLegacyRoot = Symbol('admittedLegacyRoot')

function apiError(response) {
  return Object.assign(new Error('FEISHU_REPLY_FAILED'), { code: 'FEISHU_REPLY_FAILED', apiCode: response?.code })
}

// Bound each post, including a single very long line. Keep Unicode code points intact.
export function markdownChunks(text, limit = 3500) {
  const points = Array.from(text)
  const chunks = []
  let offset = 0, fence = ''
  while (offset < points.length) {
    const end = Math.min(offset + limit, points.length)
    let boundary = end
    if (end < points.length) {
      const newline = points.slice(offset, end).lastIndexOf('\n')
      if (newline > limit / 2) boundary = offset + newline + 1
    }
    const body = points.slice(offset, boundary).join('')
    const prefix = fence ? fence + '\n' : ''
    for (const line of body.split('\n')) {
      const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
      if (!match) continue
      if (!fence) fence = match[1] + match[2]
      else if (match[1][0] === fence[0] && match[1].length >= fence.match(/^(`+|~+)/)[0].length && !match[2].trim()) fence = ''
    }
    chunks.push(prefix + body + (fence ? '\n' + fence.match(/^(`+|~+)/)[0] : ''))
    offset = boundary
  }
  return chunks
}

// The native image outlet emits singleton md/text/img rows. Keep image order
// and bound text on the same strict topic-reply path used for ordinary text.
function postChunks(content) {
  if (typeof content === 'string') return markdownChunks(content).map(text => ({ zh_cn: { title: '', content: [[{ tag: 'md', text }]] } }))
  const post = content?.post?.zh_cn
  if (!post || !Array.isArray(post.content)) throw new Error('INVALID_REPLY_POST')
  const chunks = []; let rows = [], size = 0
  for (const row of post.content) {
    if (!Array.isArray(row) || row.length !== 1) throw new Error('INVALID_REPLY_POST_ROW')
    const node = row[0]
    if (node.tag === 'img' && typeof node.image_key === 'string' && node.image_key) {
      rows.push([node]); continue
    }
    if (!['md', 'text'].includes(node.tag) || typeof node.text !== 'string') throw new Error('INVALID_REPLY_POST_NODE')
    for (const text of markdownChunks(node.text)) {
      if (rows.length && size + Array.from(text).length > 3500) { chunks.push({ zh_cn: { title: post.title ?? '', content: rows } }); rows = []; size = 0 }
      rows.push([{ ...node, text }]); size += Array.from(text).length
    }
  }
  if (rows.length) chunks.push({ zh_cn: { title: post.title ?? '', content: rows } })
  if (!chunks.length) throw new Error('EMPTY_REPLY_POST')
  return chunks
}

export class FeishuReplies {
  constructor(getChannel, state, { groupReplyInThread = true } = {}) {
    this.getChannel = getChannel
    this.state = state
    this.groupReplyInThread = groupReplyInThread
    this.state.value.threadRoots ??= {}
    this.state.value.botThreads ??= {}
  }
  threadKey(message, threadId) { return hash(JSON.stringify([message.chatId, threadId])) }
  isBotThread(message) {
    // Main-chat quotes also carry root_id. Only the current thread_id can
    // prove that this message belongs to a bot-created topic.
    if (message.chatType !== 'group' || !this.groupReplyInThread || !message.threadId) return false
    const key = this.threadKey(message, message.threadId)
    if (Object.hasOwn(this.state.value.botThreads, key)) return this.state.value.botThreads[key] === true
    // Old aliases also cover replies inside user-created topics. Require proof
    // that the plugin admitted the original root, not just a later topic reply.
    const root = this.state.value.threadRoots[key]
    return !!root && root !== message.threadId && (!!this.state.value.receipts?.[hash(root)] || message[admittedLegacyRoot] === root)
  }
  route(message) {
    if (message.chatType !== 'group' || !this.groupReplyInThread) return message
    const savedThread = message.threadId && this.state.value.threadRoots[this.threadKey(message, message.threadId)]
    const savedRoot = message.rootId && this.state.value.threadRoots[this.threadKey(message, message.rootId)]
    // Topics created before this mode retain their existing thread-based session.
    const conversationId = savedThread || savedRoot || message.threadId || message.rootId || message.messageId
    // Promote verified old ownership before dedup receipts can expire. Admission
    // calls route only after access checks, and the next state save persists it.
    if (this.isBotThread(message)) {
      for (const id of [message.threadId, message.rootId, conversationId].filter(Boolean)) this.state.value.botThreads[this.threadKey(message, id)] = true
    }
    // Bind new roots on admission, so a followup can join while the first turn is
    // still running and before the first outgoing topic receipt exists.
    if (!message.threadId) this.state.value.threadRoots[this.threadKey(message, message.rootId || message.messageId)] = conversationId
    const routed = { ...message, conversationId }
    if (this.state.value.receipts?.[hash(conversationId)]) routed[admittedLegacyRoot] = conversationId
    return routed
  }
  async uploadImage(image) {
    const response = await this.getChannel().rawClient.im.v1.image.create({ data: { image_type: 'message', image } })
    const key = response?.image_key ?? response?.data?.image_key
    if ((response?.code !== undefined && response.code !== 0) || typeof key !== 'string' || !key) throw apiError(response)
    return key
  }
  async send(message, text, { isActive = () => true } = {}) {
    const ids = []
    const checkActive = () => {
      if (!isActive()) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED', dispatched: ids.length > 0 })
    }
    checkActive()
    const channel = this.getChannel()
    if (message.chatType !== 'group' || !this.groupReplyInThread) {
      return channel.send(message.chatId, typeof text === 'string' ? { markdown: text } : text, { replyTo: message.messageId, replyInThread: !!message.threadId })
    }
    // Root ownership cannot admit an incoming quote, but an admitted main-chat
    // @Bot quote can create a new bot topic. Persist it only after a valid receipt.
    const quotedBotRoot = message.rootId && this.state.value.botThreads[this.threadKey(message, message.rootId)] === true
    let botThread = this.isBotThread(message) || (!message.threadId && (!message.rootId || quotedBotRoot))
    try {
      for (const post of postChunks(text)) {
        checkActive()
        // SDK send(markdown) sends later chunks to the main chat and may fall back there
        // when a reply target disappears. Every group chunk must use this strict reply API.
        const response = await channel.rawClient.im.v1.message.reply({
          path: { message_id: message.messageId },
          data: { msg_type: 'post', reply_in_thread: true, content: JSON.stringify(post) },
        })
        if (response?.code !== 0 || !response.data?.message_id) throw apiError(response)
        ids.push(response.data.message_id)
        // Root-only events can omit an already-known thread alias. Resolve that
        // alias from the receipt before persisting ownership, so it cannot regress.
        botThread ||= this.isBotThread({ ...message, threadId: response.data.thread_id || message.threadId, rootId: response.data.root_id || message.rootId })
        let changed = false
        for (const id of [response.data.thread_id, response.data.root_id, message.rootId || (!message.threadId && message.messageId)].filter(Boolean)) {
          const key = this.threadKey(message, id)
          const root = message.conversationId || message.threadId || message.rootId || message.messageId
          if (this.state.value.threadRoots[key] !== root) {
            this.state.value.threadRoots[key] = root
            changed = true
          }
          if (this.state.value.botThreads[key] !== botThread) {
            this.state.value.botThreads[key] = botThread
            changed = true
          }
        }
        if (changed) await this.state.save()
      }
    } catch (error) {
      if (ids.length) error.receipt = { messageId: ids[0], chunkIds: [...ids] }
      throw error
    }
    return { messageId: ids[0], chunkIds: ids }
  }
}
