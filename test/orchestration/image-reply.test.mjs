import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createLarkChannel, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { prepareImageReply } from '../../src/orchestration/image-reply.mjs'
import { host, text, until } from './harness.mjs'

const require = createRequire(import.meta.url)
const { FeishuReplies } = await import(new URL('./src/replies.mjs', `file://${require.resolve('dsh-feishu/package.json')}`))
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
const gif = Buffer.from('GIF89a010101')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-images-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'stickers'), { recursive: true })
  await writeFile(join(workspace, 'stickers/sample-07.jpg'), jpeg)
  await writeFile(join(workspace, 'stickers/sample-02.gif'), gif)
  return { root, workspace }
}
function sdk() {
  const channel = createLarkChannel({ appId: 'synthetic', appSecret: 'synthetic-not-a-credential', loggerLevel: LoggerLevel.error })
  const requests = [], uploads = []
  channel.rawClient.im.v1.message.reply = async request => { requests.push(request); return { code: 0, data: { message_id: 'receipt' } } }
  channel.rawClient.im.v1.message.create = async () => { assert.fail('Unexpected fallback/create') }
  channel.rawClient.im.v1.image.create = async request => { uploads.push(request); return { code: 0, data: { image_key: `image-${uploads.length}` } } }
  const replies = new FeishuReplies(() => channel, { value: {}, save: async () => {} })
  return { channel, requests, uploads, replies }
}

test('upload keeps the real SDK response transformation before extracting image_key', async t => {
  const { workspace } = await fixture(t)
  const requests = []
  const channel = createLarkChannel({
    appId: 'synthetic-upload-transport', appSecret: 'synthetic-not-a-credential', loggerLevel: LoggerLevel.error,
    httpInstance: { post: async () => ({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }), request: async request => {
      requests.push(new URL(request.url).pathname)
      if (request.url.includes('/auth/')) return { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
      assert.ok(request.url.endsWith('/im/v1/images'))
      assert.match(request.headers['Content-Type'] ?? request.headers['content-type'], /multipart\/form-data/)
      return { code: 0, data: { image_key: 'transport-image-key' } }
    } },
  })
  const replies = new FeishuReplies(() => channel, { value: {}, save: async () => {} })
  const result = await prepareImageReply('![x](./stickers/sample-07.jpg)', { workspace, uploadImage: data => replies.uploadImage(data) })
  assert.ok(requests.includes('/open-apis/im/v1/images'))
  assert.equal(result.imageFailures, 0, 'a successful real SDK upload must not become 图片未发送')
  assert.equal(result.content.post.zh_cn.content[0][0].image_key, 'transport-image-key')
  assert.ok(requests.includes('/open-apis/im/v1/images'))
})

test('real SDK sends local JPEG and GIF as uploaded image keys in one ordered rich reply', async t => {
  const { workspace } = await fixture(t)
  const { replies, requests, uploads } = sdk()
  const content = '给你一张躺平的：\n\n![吃饱饱](./stickers/sample-07.jpg)\n\n再来一张：\n\n![晕乎乎](./stickers/sample-02.gif)\n\n好了。'
  const result = await prepareImageReply(content, { workspace, uploadImage: data => replies.uploadImage(data) })
  await replies.send({ chatType: 'p2p', chatId: 'synthetic-chat', messageId: 'synthetic-message' }, result.content)
  assert.equal(result.imageFailures, 0)
  assert.equal(uploads.length, 2)
  assert.deepEqual(uploads.map(r => r.data.image), [jpeg, gif])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path.message_id, 'synthetic-message')
  assert.equal(requests[0].data.msg_type, 'post')
  const rows = JSON.parse(requests[0].data.content).zh_cn.content.flat()
  assert.deepEqual(rows.map(r => r.tag), ['md', 'img', 'md', 'img', 'md'])
  assert.deepEqual(rows.filter(r => r.tag === 'img').map(r => r.image_key), ['image-1', 'image-2'])
  assert.ok(!requests[0].data.content.includes('./stickers'))
})

test('text, fenced examples, inline code and escaped images do not upload', async t => {
  const { workspace } = await fixture(t)
  const content = '示例：\n```md\n![x](./stickers/sample-07.jpg)\n```\n`![x](./stickers/sample-02.gif)`\n\\![x](./stickers/sample-07.jpg)'
  const result = await prepareImageReply(content, { workspace, uploadImage: () => assert.fail('code example uploaded') })
  assert.equal(result.content, content)
})

test('native root completion uses the upload sink and sends the prepared reply once', { timeout: 15000 }, async t => {
  const { replies, uploads, requests } = sdk()
  const app = await host(() => text('已选好：![图](<./image with spaces.jpg>)'), {
    deps: { uploadImage: data => replies.uploadImage(data) },
    sendReply: (message, content) => replies.send(message, content),
  })
  t.after(() => app.dispose())
  await writeFile(join(app.workspace, 'image with spaces.jpg'), jpeg)
  await app.input('发图')
  await until(() => Object.values(app.state.value.orchestratorDeliveries).some(r => r.status === 'sent'), 'root image delivery')
  assert.equal(uploads.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(app.sent.length, 1)
  assert.deepEqual(app.sent[0].content.post.zh_cn.content.at(-1), [{ tag: 'img', image_key: 'image-1' }])
})

test('only workspace images or exact admitted attachments can be uploaded; failures are visible', async t => {
  const { root, workspace } = await fixture(t)
  const outside = join(root, 'private.jpg')
  await writeFile(outside, jpeg)
  await writeFile(join(workspace, 'fake.jpg'), 'not an image')
  await symlink(outside, join(workspace, 'escape.jpg'))
  let uploads = 0
  const result = await prepareImageReply(`![outside](${outside})\n![symlink](./escape.jpg)\n![missing](./missing.png)\n![fake](./fake.jpg)\n![remote](http://127.0.0.1/private.png)`, {
    workspace, uploadImage: async () => { uploads++; return 'image-key' },
  })
  assert.equal(uploads, 0)
  assert.equal(result.imageFailures, 5)
  assert.equal(JSON.stringify(result.content).includes('tag":"img'), false)
  assert.match(JSON.stringify(result.content), /图片未发送/)
  const admitted = await prepareImageReply(`![attachment](${outside})`, { workspace, allowedFiles: [outside], uploadImage: async () => 'admitted-image' })
  assert.equal(admitted.imageFailures, 0)
  assert.equal(admitted.content.post.zh_cn.content[0][0].image_key, 'admitted-image')
})

test('upload API failure and image limits produce text fallback without broken references', async t => {
  const { workspace } = await fixture(t)
  const { channel, replies } = sdk()
  channel.rawClient.im.v1.image.create = async () => ({ code: 999, data: { image_key: 'must-not-be-used' } })
  const result = await prepareImageReply('![x](./stickers/sample-07.jpg)', { workspace, uploadImage: data => replies.uploadImage(data) })
  assert.equal(result.imageFailures, 1)
  assert.match(JSON.stringify(result.content), /图片未发送/)
  let uploads = 0
  const many = await prepareImageReply(Array(11).fill('![x](./stickers/sample-07.jpg)').join('\n'), { workspace, uploadImage: async () => { uploads++; return 'image' } })
  assert.equal(uploads, 10)
  assert.equal(many.imageFailures, 1)
  await writeFile(join(workspace, 'large.gif'), Buffer.concat([gif, Buffer.alloc(10 * 1024 * 1024)]))
  const large = await prepareImageReply('![x](./large.gif)', { workspace, uploadImage: () => assert.fail('oversized image uploaded') })
  assert.equal(large.imageFailures, 1)
})

test('cancel during upload revokes the queued root reply before message dispatch', { timeout: 15000 }, async t => {
  let started = false, release
  const pending = new Promise(resolve => { release = resolve })
  const app = await host(() => text('![x](./image.jpg)'), { deps: { uploadImage: async () => { started = true; await pending; return 'image' } } })
  t.after(() => app.dispose())
  await writeFile(join(app.workspace, 'image.jpg'), jpeg)
  await app.input('发图')
  await until(() => started, 'image upload starts')
  const cancel = app.bridge.cancel(app.message('/cancel'))
  await until(() => [...app.bridge.bindings.values()].every(b => !b.active), 'root revoked')
  release()
  await cancel
  assert.equal(app.sent.length, 0)
  assert.deepEqual(Object.values(app.state.value.orchestratorDeliveries).map(r => r.status), ['cancelled'])
})
