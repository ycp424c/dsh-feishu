import { createHash } from 'node:crypto'
export const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32)
export function conversationKey(message) {
  return hash(JSON.stringify([message.chatType, message.chatId, message.conversationId ?? message.threadId ?? '']))
}
export function sessionId(config, key, generation = 0) {
  return `${config.sessionNamespace ?? 'dsh-feishu'}-${hash([config.appId, config.domain, key, generation].join(':'))}`
}
export function allowed(config, message, { botThread = false } = {}) {
  if (message.chatType === 'p2p') {
    return config.dmMode === 'open' || (config.dmMode === 'allowlist' && config.dmAllowlist.includes(message.senderId))
  }
  if (message.chatType !== 'group' || config.groupPolicy === 'disabled') return false
  if (config.groupPolicy === 'allowlist' && !config.groupAllowlist.includes(message.chatId)) return false
  const group = config.groups?.[message.chatId] ?? config.groups?.['*'] ?? {}
  if (group.enabled === false) return false
  // Implicit topic continuation must not override an explicit recipient.
  const hasMentions = message.mentionAll || message.mentions?.length > 0
  const threadAutoReply = (group.threadAutoReply ?? config.groupThreadAutoReply ?? true) && botThread && !hasMentions
  if ((group.requireMention ?? config.requireMention) && !message.mentionedBot && !threadAutoReply) return false
  return true
}
export function summarize(events, fromSeq) {
  let text = '', reason
  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type === 'assistant/message') {
      const next = (event.data.message.content ?? []).filter(x => x.type === 'text').map(x => x.text ?? '').join('')
      if (next.trim()) text = next
    }
    if (event.type === 'turn/end') reason = event.data.reason?.kind
  }
  return { text: text.trim(), reason, ok: reason === 'completed' && !!text.trim() }
}
export function taskStatus(turn, senderId, now = Date.now()) {
  if (!turn) return '本聊天任务：无'
  const seconds = Math.floor(Math.max(0, now - turn.startedAt) / 1000)
  const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  const awaitingApproval = !!turn.approvals?.size
  const stage = awaitingApproval ? '等待飞书审批' : '运行中'
  return turn.senderId === senderId
    ? `本聊天任务：${stage}（已持续 ${elapsed}；可用 /cancel 取消）`
    : `本聊天任务：其他成员正在执行${awaitingApproval ? '，等待审批' : ''}（已持续 ${elapsed}）`
}
export function publicError(error) {
  if (error?.code === 'ATTACHMENT_LIMIT') return '附件超过单文件、单消息大小或数量限制，请缩小文件或分批发送。'
  if (error?.code === 'ATTACHMENT_UNSUPPORTED') return '暂不支持这种附件类型，请作为普通文件重新发送。'
  if (['TOO_MANY_IMAGES', 'IMAGES_TOO_LARGE', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE'].includes(error?.code)) return '图片数量、大小或分辨率超过限制，请缩小图片或分批发送。'
  if (['ATTACHMENT_IMAGE_INVALID', 'UNSUPPORTED_IMAGE_TYPE', 'INVALID_IMAGE', 'IMAGE_TYPE_MISMATCH'].includes(error?.code)) return '图片格式或内容无效，请使用 PNG、JPEG、WebP 或 GIF 图片重新发送。'
  if (error?.code === 'ATTACHMENT_MODEL_NO_IMAGES') return '当前模型未启用图片输入，请管理员配置支持图片的模型后再试；本次图片未送入会话。'
  if (error?.code === 'ATTACHMENT_DOWNLOAD_FAILED') return '附件下载失败，请重新发送；若仍失败，请管理员检查飞书消息资源下载权限。'
  if (error?.code === 'CANCELLED') return '当前任务已取消。'
  if (error?.code === 'TIMEOUT') return '本轮达到配置的最长执行时间，已请求停止。可用 /status 查询状态，停止后可用 /new 开启新会话。'
  if (error?.code === 'BUSY') return '上一任务仍在停止中，请稍后重试或联系管理员。'
  return '本轮处理失败，请稍后重试或联系管理员检查后端。未完成的操作不会被报告为成功。'
}
