import { attachmentError } from './attachments.mjs'

// User-sent resources require the message-resource API, not image.get/file.get.
export function feishuResourceReader(getClient) {
  return async (message, resource, signal) => {
    signal?.throwIfAborted()
    const client = getClient()
    if (!client || !message.messageId) throw attachmentError('ATTACHMENT_DOWNLOAD_FAILED')
    const request = client.im.v1.messageResource.get({
      path: { message_id: message.messageId, file_key: resource.fileKey },
      params: { type: resource.type === 'image' ? 'image' : 'file' },
    }).then(result => {
      const stream = result.getReadableStream()
      // The SDK has no per-request AbortSignal; close a response arriving after cancellation.
      if (signal?.aborted) { stream.destroy(); throw signal.reason }
      return stream
    })
    let onAbort
    try {
      return await Promise.race([
        request,
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
        }),
      ])
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw attachmentError('ATTACHMENT_DOWNLOAD_FAILED')
    } finally { signal?.removeEventListener('abort', onAbort) }
  }
}
