import { allowed, conversationKey, hash, publicError, taskStatus } from './policy.mjs'

export function createMessageReceiver({ config, version, state, bridge, replies, typing, metrics, audit }) {
  async function respond(message, text, kind = 'final') {
    const result = await replies.send(message, text)
    if (!result?.messageId) throw new Error('SEND_RECEIPT_MISSING')
    metrics.sent++
    await audit('reply.sent', { message: hash(message.messageId), reply: hash(result.messageId), kind })
  }
  async function receive(message) {
    if (!allowed(config, message, { botThread: replies.isBotThread(message) })) { metrics.rejected++; await audit('message.rejected', { message: hash(message.messageId) }); return }
    const receipt = hash(message.messageId)
    if (state.value.receipts[receipt]) return
    state.value.receipts[receipt] = { at: Date.now(), status: 'received' }
    message = replies.route(message)
    for (const [id, value] of Object.entries(state.value.receipts)) if (Date.now() - value.at > 36 * 60 * 60 * 1000) delete state.value.receipts[id]
    await state.save()
    metrics.received++
    const indicator = typing.start(message)
    try {
      await audit('message.received', { message: receipt, conversation: conversationKey(message), contentType: message.rawContentType, sender: hash(message.senderId), chat: hash(message.chatId), chatType: message.chatType })
      return await processMessage(message, receipt, indicator)
    } finally { await indicator.stop() }
  }
  async function processMessage(message, receipt, indicator) {
    const text = message.content.trim()
    const finish = async (action, send = (text, kind) => respond(message, text, kind), ticket) => {
      try { await action(); state.value.receipts[receipt].status = 'done' }
      catch (error) {
        if (ticket) ticket.cancellable = false
        metrics.failed++
        state.value.receipts[receipt].status = 'failed'
        await audit('message.failed', { message: receipt, code: error?.code ?? 'FAILED' })
        try { await send(publicError(error), 'error') } catch { metrics.sendFailed++; await audit('reply.failed', { message: receipt }) }
      }
      await state.save()
    }
    const queuedCancelled = async () => {
      state.value.receipts[receipt].status = 'cancelled'
      await indicator.stop()
      await state.save()
      await audit('message.queue_cancelled', { message: receipt })
    }
    if (!message.resources?.length && (text === '/status' || (config.statusCommandAlias && text === config.statusCommandAlias))) return finish(() => respond(message, `${config.botLabel ?? 'DSH Feishu Bot'} · 飞书插件 v${version}\n\n模型：${config.model}\n${taskStatus(bridge.running.get(conversationKey(message)), message.senderId)}\n整轮时限：${config.maxTurnMs === 0 ? '无固定上限' : `${Math.ceil(config.maxTurnMs / 60000)} 分钟`}\n审批等待：最长 ${Math.ceil(config.approvalTimeoutMs / 60000)} 分钟，卡片私发给任务发起人\n全部运行中任务：${bridge.running.size}\n支持文本、图片（需视觉模型）、文件地址、工具和会话续聊。\n命令：/new 新会话，/cancel 取消自己当前和排队中的任务。`, 'status'))
    if (!message.resources?.length && (text === '/cancel' || text === '取消当前任务')) return finish(() => respond(message, bridge.cancel(message) ? '已请求取消你当前和排队中的任务。' : '没有找到由你发起的运行中或排队任务。', 'control'))
    if (!message.resources?.length && (text === '/new' || text === '/reset')) {
      if (bridge.otherSenderActive(message)) return finish(() => respond(message, '当前聊天有其他成员的任务正在执行，请等待完成后再开启新会话。', 'control'))
      bridge.cancel(message)
      return bridge.enqueue(message, ticket => finish(async () => { await bridge.reset(message, ticket); await respond(message, '已开启新的 DSH 会话，之前的记录仍然保留。', 'control') }, undefined, ticket), queuedCancelled)
    }
    if (!text && !message.resources?.length) return finish(() => respond(message, '请发送文字问题或附件。', 'unsupported'))
    return bridge.enqueue(message, ticket => finish(async () => {
      await audit('agent.start', { message: receipt, model: `${config.provider}/${config.model}` })
      const result = await bridge.reply(message, ticket)
      metrics.completed++
      await audit('agent.completed', { message: receipt, session: result.sessionId, model: `${result.provider}/${result.model}` })
      await respond(message, result.text)
    }, undefined, ticket), queuedCancelled)
  }

  return receive
}
