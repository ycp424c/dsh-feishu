import { constants, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { insideWorkspace } from './policy.mjs'

const maxImageBytes = 10 * 1024 * 1024
const maxReplyBytes = 30 * 1024 * 1024
const maxImages = 10
const failed = reason => Object.assign(new Error(reason), { imageReason: reason })

// Inline Markdown images only. Code examples are deliberately excluded. Angle
// destinations support spaces; normal destinations support escaped punctuation
// and one level of parentheses, including the existing sticker paths.
function images(text) {
  let fence
  const searchable = text.split(/(?<=\n)/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/m)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      return ' '.repeat(line.length)
    }
    if (marker) { fence = marker[1]; return ' '.repeat(line.length) }
    return /^( {4}|\t)/.test(line) ? ' '.repeat(line.length) : line
  }).join('')
  const tokens = /(`+)[\s\S]*?\1|(?<!\\)!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]+>|(?:\\.|[^()\s]|\([^()\n]*\))+)(?:\s+["'][^\n]*?["'])?\s*\)/g
  return [...searchable.matchAll(tokens)].filter(m => !m[1]).map(m => ({
    start: m.index, end: m.index + m[0].length,
    path: m[3].replace(/^<|>$/g, '').replace(/\\([\\()\[\] <>])/g, '$1'),
  }))
}

function supported(data) {
  return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
    ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) ||
    (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
}

async function localImage(path, workspace, allowedFiles, budget) {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) throw failed('仅支持任务工作区或已接收附件中的本地图片')
  const candidate = isAbsolute(path) ? path : `${workspace}/${path}`
  let actual
  try { actual = realpathSync.native(candidate) } catch { throw failed('文件不存在或无法读取') }
  if (!insideWorkspace(actual, workspace) && !allowedFiles.includes(candidate)) throw failed('图片不在允许访问的范围内')
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw failed('不是普通图片文件')
    const limit = Math.min(maxImageBytes, budget)
    if (stat.size > limit) throw failed('图片超过发送大小限制')
    // Bound the read even if a producer grows the file after stat().
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== stat.size) throw failed('图片仍在写入，请完成后重试')
    const data = buffer.subarray(0, size)
    if (!supported(data)) throw failed('图片格式不支持，请使用 PNG、JPEG、GIF 或 WebP')
    return data
  } finally { await file.close() }
}

// This runs only for an authenticated ROOT reply. Workers supply paths/results,
// never destinations or channel credentials. No URL download or extra IM send.
export async function prepareImageReply(text, { workspace, allowedFiles = [], uploadImage, isActive = () => true }) {
  const matches = images(text)
  if (!matches.length) return { content: text, imageFailures: 0 }
  const rows = []
  let offset = 0, bytes = 0, imageFailures = 0
  const checkActive = () => { if (!isActive()) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }) }
  for (const [index, match] of matches.entries()) {
    checkActive()
    const before = text.slice(offset, match.start)
    if (before.trim()) rows.push([{ tag: 'md', text: before }])
    try {
      if (index >= maxImages) throw failed('单条回复最多发送 10 张图片')
      const data = await localImage(match.path, workspace, allowedFiles, maxReplyBytes - bytes)
      bytes += data.length
      checkActive()
      const key = await uploadImage(data)
      if (typeof key !== 'string' || !key) throw failed('上传失败，请稍后重试')
      rows.push([{ tag: 'img', image_key: key }])
    } catch (error) {
      if (error.code === 'CANCELLED') throw error
      imageFailures++
      rows.push([{ tag: 'text', text: `[图片未发送：${error.imageReason ?? '上传或读取失败，请稍后重试'}]` }])
    }
    checkActive()
    offset = match.end
  }
  const after = text.slice(offset)
  if (after.trim()) rows.push([{ tag: 'md', text: after }])
  return { content: { post: { zh_cn: { title: '', content: rows } } }, imageFailures }
}
