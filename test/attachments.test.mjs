import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { Attachments, attachmentError, imageMediaType } from '../src/attachments.mjs'
import { feishuResourceReader } from '../src/feishu-resources.mjs'
import { decodeProbeAttachments } from '../src/probe-attachments.mjs'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const message = resources => ({ messageId: 'synthetic-message', content: '请分析附件', resources })
function fixture(values, { limits, vision = true } = {}) {
  const saved = { images: [], files: [] }, streams = []
  const processor = new Attachments({
    store: {
      async saveImages(images) { saved.images.push(...images); return images.map((_, i) => ({ attachmentId: `image-${i}` })) },
      async saveFileStream({ data, name, signal }) {
        const chunks = []
        for await (const chunk of data) { signal?.throwIfAborted(); chunks.push(chunk) }
        saved.files.push({ data: Buffer.concat(chunks), name })
        return { attachmentId: 'file', name, bytes: saved.files.at(-1).data.length }
      },
    },
    async openResource(_, resource) { const stream = Readable.from(values[resource.fileKey]); streams.push(stream); return stream },
    async supportsImages() { return vision },
  }, limits)
  return { processor, saved, streams }
}

test('mixed messages retain order; ordinary files become durable refs, without parsing', async () => {
  const f = fixture({ a: [Buffer.from('PDF opaque bytes')], b: [png], c: [Buffer.from('plain text')] })
  const parts = await f.processor.prepare(message([
    { type: 'file', fileKey: 'a', fileName: '../../contract.pdf' },
    { type: 'image', fileKey: 'b' },
    { type: 'file', fileKey: 'c', fileName: 'notes.txt' },
  ]))
  assert.deepEqual(parts.map(p => p.type), ['text', 'file', 'image', 'file'])
  assert.equal(parts[1].attachment.attachmentId, 'file')
  assert.equal(f.saved.files[0].data.toString(), 'PDF opaque bytes')
  assert.equal(f.saved.images[0].mediaType, 'image/png')
  assert.ok(f.streams.every(s => s.destroyed))
})
test('magic detection handles split headers and images uploaded as files', async () => {
  const f = fixture({ a: [...png].map(n => Buffer.from([n])) })
  const parts = await f.processor.prepare(message([{ type: 'file', fileKey: 'a', fileName: 'wrong.pdf' }]))
  assert.equal(parts[1].type, 'image')
  assert.equal(f.saved.files.length, 0)
})
test('image signatures distinguish supported encodings', () => {
  assert.equal(imageMediaType(Buffer.from([255, 216, 255, 0])), 'image/jpeg')
  assert.equal(imageMediaType(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(imageMediaType(Buffer.from('RIFFxxxxWEBP')), 'image/webp')
  assert.equal(imageMediaType(Buffer.from('<svg>')), undefined)
})
test('mislabelled images fail without submitting opaque bytes as visual content', async () => {
  const f = fixture({ a: [Buffer.from('not an image')] })
  await assert.rejects(f.processor.prepare(message([{ type: 'image', fileKey: 'a' }])), { code: 'ATTACHMENT_IMAGE_INVALID' })
  assert.deepEqual(f.saved, { images: [], files: [] })
})
test('text-only model rejects images before appending them to a session', async () => {
  const f = fixture({ a: [png] }, { vision: false })
  await assert.rejects(f.processor.prepare(message([{ type: 'image', fileKey: 'a' }])), { code: 'ATTACHMENT_MODEL_NO_IMAGES' })
  assert.equal(f.saved.images.length, 0)
})
test('file, image and aggregate budgets apply to actual streamed bytes', async () => {
  for (const limits of [{ maxFileBytes: 13 }, { maxImageBytes: 13 }, { maxMessageBytes: 13 }]) {
    const f = fixture({ a: [png] }, { limits })
    await assert.rejects(f.processor.prepare(message([{ type: 'image', fileKey: 'a' }])), { code: 'ATTACHMENT_LIMIT' })
    assert.ok(f.streams[0].destroyed)
  }
  const f = fixture({ a: [Buffer.alloc(13)], b: [Buffer.alloc(13)] }, { limits: { maxMessageBytes: 25 } })
  await assert.rejects(f.processor.prepare(message([{ type: 'file', fileKey: 'a' }, { type: 'file', fileKey: 'b' }])), { code: 'ATTACHMENT_LIMIT' })
})
test('count rejection performs no download; unsupported resource fails explicitly', async () => {
  const f = fixture({}, { limits: { maxCount: 1 } })
  await assert.rejects(f.processor.prepare(message([{}, {}])), { code: 'ATTACHMENT_LIMIT' })
  assert.equal(f.streams.length, 0)
  await assert.rejects(f.processor.prepare(message([{ type: 'sticker', fileKey: 'a' }])), { code: 'ATTACHMENT_UNSUPPORTED' })
})
test('cancel closes a stalled incoming stream', async () => {
  const stream = new Readable({ read() {} }), controller = new AbortController()
  const processor = new Attachments({ store: {}, openResource: async () => stream, supportsImages: async () => true })
  const work = processor.prepare(message([{ type: 'file', fileKey: 'a' }]), { signal: controller.signal })
  setImmediate(() => controller.abort(attachmentError('CANCELLED')))
  await assert.rejects(work, { code: 'CANCELLED' })
  assert.ok(stream.destroyed)
})
test('download failure does not return a partially admitted message', async () => {
  const f = fixture({ a: [Buffer.alloc(14)] })
  f.processor.openResource = async () => Readable.from((async function* () { yield Buffer.alloc(14); throw new Error('broken download') })())
  await assert.rejects(f.processor.prepare(message([{ type: 'file', fileKey: 'a' }])), /broken download/)
  assert.equal(f.saved.files.length, 0)
})
test('Feishu reader uses message-resource API for user uploads', async () => {
  const calls = [], stream = Readable.from([png])
  const open = feishuResourceReader(() => ({ im: { v1: { messageResource: { async get(args) { calls.push(args); return { getReadableStream: () => stream } } } } } }))
  assert.equal(await open(message([]), { type: 'image', fileKey: 'image-key' }), stream)
  assert.deepEqual(calls[0], { path: { message_id: 'synthetic-message', file_key: 'image-key' }, params: { type: 'image' } })
  await open(message([]), { type: 'video', fileKey: 'video-key' })
  assert.equal(calls[1].params.type, 'file')
})
test('SDK errors are redacted; cancellation closes even a late download response', async () => {
  const failed = feishuResourceReader(() => ({ im: { v1: { messageResource: { async get() { throw new Error('secret URL') } } } } }))
  await assert.rejects(failed(message([]), { type: 'file', fileKey: 'a' }), error => error.code === 'ATTACHMENT_DOWNLOAD_FAILED' && !error.message.includes('secret'))
  let resolve
  const open = feishuResourceReader(() => ({ im: { v1: { messageResource: { get: () => new Promise(r => { resolve = r }) } } } }))
  const controller = new AbortController(), stream = Readable.from([png])
  const pending = open(message([]), { type: 'image', fileKey: 'a' }, controller.signal)
  controller.abort(attachmentError('CANCELLED'))
  await assert.rejects(pending, { code: 'CANCELLED' })
  resolve({ getReadableStream: () => stream })
  await new Promise(r => setImmediate(r))
  assert.ok(stream.destroyed)
})
test('synthetic probes accept bytes only, with canonical base64 and bounded total size', () => {
  const result = decodeProbeAttachments([{ type: 'image', data: png.toString('base64'), name: 'test.png' }])
  assert.deepEqual(result.data.get('0'), png)
  for (const input of [null, {}, [{ type: 'file', path: '/tmp/private' }], [{ type: 'image', data: 'AA' }], [{ type: 'file', data: '', name: 123 }], [{ type: 'file', data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }]]) {
    assert.throws(() => decodeProbeAttachments(input), { code: 'invalid_probe' })
  }
})
