import { execution } from './shim.mjs'

const maxBytes = 8 * 1024 * 1024
const failure = message => Object.assign(new Error(message), { minutesFailure: true })

function minuteToken(value) {
  let token = value.trim()
  if (token.startsWith('https://')) {
    try {
      const url = new URL(token)
      if (!/^(?:[a-z0-9-]+\.)*(?:feishu\.cn|larksuite\.com)$/.test(url.hostname) || url.username || url.password || url.port) throw Error()
      token = /^\/minutes\/([A-Za-z0-9]{24})\/?$/.exec(url.pathname)?.[1] ?? ''
    } catch { token = '' }
  }
  if (!/^[A-Za-z0-9]{24}$/.test(token)) throw failure('INVALID_MINUTE: 请提供有效的飞书/Lark 妙记链接或 24 位 minute_token。')
  return token
}

function apiError(code, action) {
  const safeCode = Number.isSafeInteger(code) ? code : 'API_ERROR'
  const hints = {
    2091001: '妙记参数无效，请检查链接。',
    2091002: '找不到该篇妙记，请检查链接和应用可访问范围。',
    2091003: '妙记尚未完成转写，请稍后重试。',
    2091004: '该篇妙记已删除。',
    2091005: action === 'read' ? '当前应用没有该篇妙记的导出权限，请检查妙记共享与导出设置。' : '当前应用没有该篇妙记的阅读权限，请检查妙记共享设置。',
    99991668: '访问凭证无效，请检查应用凭据；本工具使用 Bot 身份。',
    99991672: action === 'read' ? '应用缺少导出权限：请开通并发布 minutes:minutes.transcript:export（旧 minutes:minute:download 也可）；minutes:minutes:readonly 仅覆盖基本信息。' : '应用缺少基本信息读取权限：请开通并发布 minutes:minutes:readonly 或 minutes:minutes.basic:read。',
    99991679: '应用权限未生效，请检查权限开通、版本发布及数据访问范围。',
  }
  return failure(`MINUTES_API_ERROR (${safeCode}): ${hints[safeCode] ?? '妙记读取失败，请检查应用权限、资源权限或稍后重试。'} 不需要绑定 lark-cli 用户身份。`)
}

// The SDK returns a stream, including for some error responses. Bound the
// entire read, decode UTF-8 only after combining chunks, and never persist it.
async function readStream(stream, signal, limit = maxBytes) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw failure('MINUTES_RESPONSE_INVALID: 未收到妙记文字流。')
  const abort = () => stream.destroy(failure('MINUTES_ABORTED: 妙记读取已取消。'))
  const timer = setTimeout(() => stream.destroy(failure('MINUTES_TIMEOUT: 妙记文字读取超时。')), 30000)
  timer.unref?.()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) throw failure('MINUTES_ABORTED: 妙记读取已取消。')
    const chunks = []
    let bytes = 0
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > limit) throw failure('MINUTES_TOO_LARGE: 妙记文字超过本工具 8 MiB 读取上限，未返回不完整正文。')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (!stream.destroyed) stream.destroy()
  }
}

function jsonBody(text) { try { return JSON.parse(text) } catch { return null } }

export const minutesTool = {
  name: 'feishu_minutes',
  description: '以 Bot 身份通过飞书 Open API 只读妙记。minute_token 可直接填 /minutes/ 链接。info 获取标题、所有者、时长等基本信息；read 导出包含说话人和时间戳的对话正文，需 minutes:minutes.transcript:export 及该篇妙记导出权限。无需 lark-cli 配置或用户 OAuth。info 成功不代表已读正文。read 默认每段 12000 字符；complete=false 时必须按 next_offset 续读，禁止将部分正文当作完整会议。摘要/待办可基于读到的正文分析生成，非官方 AI 摘要接口。',
  parameters: { anyOf: [
    { type: 'object', properties: { action: { type: 'string', const: 'info' }, minute_token: { type: 'string', description: '妙记链接或 24 位 token' } }, required: ['action', 'minute_token'] },
    { type: 'object', properties: {
      action: { type: 'string', const: 'read' }, minute_token: { type: 'string', description: '妙记链接或 24 位 token' },
      offset: { type: 'integer', minimum: 0, description: '起始字符位置，默认 0；续读使用 next_offset' },
      limit: { type: 'integer', minimum: 1, maximum: 50000, description: '每段最多字符数，默认 12000，上限 50000' },
    }, required: ['action', 'minute_token'] },
  ] },
  async execute(_, args) {
    const token = minuteToken(args.minute_token)
    const { client, signal } = execution.getStore()
    try {
      if (args.action === 'info') {
        const res = await client.minutes.v1.minute.get({ path: { minute_token: token }, params: { user_id_type: 'open_id' } })
        if (res.code !== 0) throw apiError(res.code, args.action)
        if (!res.data?.minute) throw failure('MINUTES_RESPONSE_INVALID: 未收到妙记基本信息。')
        // Avoid returning cover URLs which may contain temporary credentials.
        const { title, owner_id, create_time, duration, url, note_id } = res.data.minute
        return { details: { identity: 'bot', minute_token: token, minute: { title, owner_id, create_time, duration, url, note_id } } }
      }
      const res = await client.minutes.v1.minuteTranscript.get({ path: { minute_token: token }, params: { file_format: 'txt', need_speaker: true, need_timestamp: true } })
      const text = await readStream(res.getReadableStream(), signal)
      const body = jsonBody(text)
      if (body && Number.isSafeInteger(body.code) && body.code !== 0) throw apiError(body.code, args.action)
      if (String(res.headers?.['content-type'] ?? '').includes('application/json')) throw failure('MINUTES_RESPONSE_INVALID: 接口返回 JSON，未获取到妙记正文。')
      const offset = args.offset ?? 0, limit = args.limit ?? 12000
      if (offset > text.length) throw failure('MINUTES_OFFSET_INVALID: 起始位置超出正文长度，请从 0 重新读取。')
      let end = Math.min(offset + limit, text.length)
      // UTF-16 offsets match JS slicing, but never split an emoji surrogate pair.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end += 1
      return { details: { identity: 'bot', minute_token: token, file_format: 'txt', transcript: text.slice(offset, end), offset, total_chars: text.length, next_offset: end < text.length ? end : null, complete: end === text.length } }
    } catch (error) {
      if (error.minutesFailure) throw error
      let data = error.response?.data
      if (data && typeof data[Symbol.asyncIterator] === 'function') {
        try { data = jsonBody(await readStream(data, signal, 65536)) } catch (readError) { if (signal?.aborted) throw readError; data = null }
      }
      throw apiError(data?.code ?? error.code, args.action)
    }
  },
}
