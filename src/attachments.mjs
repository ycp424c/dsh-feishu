// Transport-independent admission. DSH owns durable bytes and execution-world paths.
const MiB = 1024 * 1024
export const attachmentDefaults = Object.freeze({ maxCount: 10, maxFileBytes: 50 * MiB, maxImageBytes: 20 * MiB, maxMessageBytes: 80 * MiB })
export const attachmentError = code => Object.assign(new Error(code), { code })

export function imageMediaType(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
}

export class Attachments {
  constructor({ store, openResource, supportsImages }, limits = {}) {
    this.store = store
    this.openResource = openResource
    this.supportsImages = supportsImages
    this.limits = { ...attachmentDefaults, ...limits }
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid attachment limit')
  }

  async prepare(message, { signal } = {}) {
    const resources = message.resources ?? []
    if (resources.length > this.limits.maxCount) throw attachmentError('ATTACHMENT_LIMIT')
    const content = [{ type: 'text', text: message.content?.trim() || '请查看本条消息的附件。' }]
    let total = 0
    const images = [], imageSlots = []
    for (const resource of resources) {
      signal?.throwIfAborted()
      if (!['image', 'file', 'audio', 'video'].includes(resource.type) || !resource.fileKey) throw attachmentError('ATTACHMENT_UNSUPPORTED')
      const stream = await this.openResource(message, resource, signal)
      const onAbort = () => stream.destroy(signal.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      const iterator = stream[Symbol.asyncIterator]()
      let size = 0
      const next = async () => {
        signal?.throwIfAborted()
        const item = await iterator.next()
        if (!item.done) {
          item.value = Buffer.from(item.value)
          size += item.value.length
          total += item.value.length
          if (size > this.limits.maxFileBytes || total > this.limits.maxMessageBytes) throw attachmentError('ATTACHMENT_LIMIT')
        }
        return item
      }
      try {
        // Inspect actual bytes, including images sent as ordinary files. Do not trust extensions.
        const prefix = []
        let prefixBytes = 0, ended = false
        while (prefixBytes < 12) {
          const item = await next()
          if (item.done) { ended = true; break }
          prefix.push(item.value); prefixBytes += item.value.length
        }
        const mediaType = imageMediaType(Buffer.concat(prefix))
        async function* chunks() {
          yield* prefix
          if (!ended) for (;;) {
            const item = await next()
            if (item.done) break
            yield item.value
          }
        }
        if (resource.type === 'image' && !mediaType) throw attachmentError('ATTACHMENT_IMAGE_INVALID')
        if (mediaType) {
          if (!(await this.supportsImages(signal))) throw attachmentError('ATTACHMENT_MODEL_NO_IMAGES')
          const data = []; let bytes = 0
          for await (const chunk of chunks()) {
            bytes += chunk.length
            if (bytes > this.limits.maxImageBytes) throw attachmentError('ATTACHMENT_LIMIT')
            data.push(chunk)
          }
          images.push({ data: Buffer.concat(data), mediaType, name: resource.fileName })
          imageSlots.push(content.length)
          content.push(undefined)
        } else {
          const attachment = await this.store.saveFileStream({ data: chunks(), name: resource.fileName ?? `attachment.${resource.type === 'file' ? 'bin' : resource.type}`, signal })
          content.push({ type: 'file', attachment })
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        stream.destroy()
        await iterator.return?.()
      }
    }
    signal?.throwIfAborted()
    if (images.length) {
      // DSH validates the entire image batch, normalizes it, then persists durable refs.
      const refs = await this.store.saveImages(images)
      refs.forEach((attachment, index) => { content[imageSlots[index]] = { type: 'image', attachment } })
    }
    signal?.throwIfAborted()
    return content
  }
}
