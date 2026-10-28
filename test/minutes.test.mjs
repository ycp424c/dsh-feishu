import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { Client } from '@larksuiteoapi/node-sdk'
import { FeishuTools, toolCatalog, isWrite } from '../src/business/index.mjs'

const token = 'obcnq3b9jl72l83w4f149w9c'
const url = `https://sample.feishu.cn/minutes/${token}?from=share`
function harness(client) {
  return new FeishuTools({ client: () => client, runningForAgent: () => undefined,
    approvals: { request: () => { throw Error('read must not request approval') } },
    config: { environment: 'test', workspace: '/tmp', stateDir: '/tmp' } })
}

test('minutes is registered as a read-only tool in the actual business catalog', () => {
  const tool = toolCatalog().find(t => t.name === 'feishu_minutes')
  assert.ok(tool, 'DSH needs a registered minutes tool, granting scopes alone cannot add one')
  for (const action of ['info', 'read']) assert.equal(isWrite(tool.name, { action }), false)
})

test('minutes metadata accepts a shared URL and uses the existing Bot SDK client', async () => {
  let request
  const business = harness({ minutes: { v1: { minute: { get: async p => {
    request = p
    return { code: 0, data: { minute: { token, title: '合成会议', duration: '12000' } } }
  } } } } })
  const result = await business.execute('feishu_minutes', { action: 'info', minute_token: url }, {})
  assert.equal(request.path.minute_token, token)
  assert.equal(request.params.user_id_type, 'open_id')
  assert.equal(result.identity, 'bot')
  assert.equal(result.minute.title, '合成会议')
})

test('transcript streams UTF-8 safely and explicitly marks incomplete pages', async () => {
  let request
  const bytes = Buffer.from('说话人 A 00:00\n讨论测试方案。\n说话人 B 00:10\n确认待办。')
  const client = { minutes: { v1: { minuteTranscript: { get: async p => {
    request = p
    return { headers: { 'content-type': 'text/plain' }, getReadableStream: () => Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]) }
  } } } } }
  const business = harness(client)
  const first = await business.execute('feishu_minutes', { action: 'read', minute_token: token, limit: 12 }, {})
  assert.equal(request.params.file_format, 'txt')
  assert.equal(request.params.need_speaker, true)
  assert.equal(request.params.need_timestamp, true)
  assert.equal(first.complete, false)
  assert.equal(first.next_offset, 12)
  const second = await business.execute('feishu_minutes', { action: 'read', minute_token: token, offset: first.next_offset }, {})
  assert.equal(first.transcript + second.transcript, bytes.toString('utf8'))
  assert.equal(second.complete, true)
  assert.equal(second.next_offset, null)
  await assert.rejects(business.execute('feishu_minutes', { action: 'read', minute_token: token, offset: 9999 }, {}), /OFFSET/)
})

test('invalid URLs, token paths and pagination cannot dispatch any API request', async () => {
  const business = harness(new Proxy({}, { get() { throw Error('must not dispatch') } }))
  for (const value of ['../secrets', `${token}/transcript`, `https://evil.test/minutes/${token}`, `https://sample.feishu.cn.evil.test/minutes/${token}`, `http://sample.feishu.cn/minutes/${token}`]) {
    await assert.rejects(business.execute('feishu_minutes', { action: 'info', minute_token: value }, {}), /INVALID_MINUTE/)
  }
  for (const extra of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 50001 }]) {
    await assert.rejects(business.execute('feishu_minutes', { action: 'read', minute_token: token, ...extra }, {}), /bounds|type|Invalid/)
  }
})

test('missing export scope and resource permission remain distinct and never leak SDK secrets', async () => {
  for (const [code, expected] of [[99991672, /minutes:minutes.transcript:export/], [2091005, /导出权限/], [2091003, /转写/]]) {
    const business = harness({ minutes: { v1: { minuteTranscript: { get: async () => {
      const error = Error('Bearer TOP_SECRET appSecret=TOP_SECRET')
      error.response = { data: Readable.from([JSON.stringify({ code, msg: 'TOP_SECRET' })]) }
      throw error
    } } } } })
    await assert.rejects(business.execute('feishu_minutes', { action: 'read', minute_token: token }, {}), e => {
      assert.match(e.message, expected)
      assert.equal(e.message.includes('TOP_SECRET'), false)
      return true
    })
  }
})

test('JSON errors returned as HTTP 200 are never presented as transcript content', async () => {
  const business = harness({ minutes: { v1: { minuteTranscript: { get: async () => ({
    headers: { 'content-type': 'application/json' },
    getReadableStream: () => Readable.from([JSON.stringify({ code: 2091005, msg: 'denied' })]),
  }) } } } })
  await assert.rejects(business.execute('feishu_minutes', { action: 'read', minute_token: token }, {}), /导出权限/)
})

test('streaming transcript cancellation destroys the response instead of hanging', async () => {
  const stream = new Readable({ read() {} })
  const abort = new AbortController()
  const business = harness({ minutes: { v1: { minuteTranscript: { get: async () => ({ getReadableStream: () => stream }) } } } })
  const result = business.execute('feishu_minutes', { action: 'read', minute_token: token }, { signal: abort.signal })
  setImmediate(() => abort.abort())
  await assert.rejects(result, /abort/i)
  assert.equal(stream.destroyed, true)
})

test('an oversized transcript fails explicitly, closes its stream and returns no partial text', async () => {
  const stream = Readable.from([Buffer.alloc(8 * 1024 * 1024), Buffer.from('x')])
  const business = harness({ minutes: { v1: { minuteTranscript: { get: async () => ({ getReadableStream: () => stream }) } } } })
  await assert.rejects(business.execute('feishu_minutes', { action: 'read', minute_token: token }, {}), /MINUTES_TOO_LARGE/)
  assert.equal(stream.destroyed, true)
})

test('late responses after cancellation are closed and metadata failures remain redacted', async () => {
  const stream = Readable.from(['secret transcript'])
  const abort = new AbortController()
  const business = harness({ minutes: { v1: { minuteTranscript: { get: async () => {
    abort.abort()
    return { getReadableStream: () => stream }
  } } } } })
  await assert.rejects(business.execute('feishu_minutes', { action: 'read', minute_token: token }, { signal: abort.signal }), /MINUTES_ABORTED/)
  assert.equal(stream.destroyed, true)
  const metadata = harness({ minutes: { v1: { minute: { get: async () => ({ code: 2091005, msg: 'TOP_SECRET' }) } } } })
  await assert.rejects(metadata.execute('feishu_minutes', { action: 'info', minute_token: token }, {}), e => {
    assert.match(e.message, /阅读权限/)
    assert.equal(e.message.includes('TOP_SECRET'), false)
    return true
  })
})

test('the installed SDK acquires a tenant token and decodes its actual stream response wrapper', async () => {
  let tokens = 0, requests = []
  const client = new Client({ appId: 'cli_synthetic_minutes', appSecret: 'synthetic',
    cache: { get: async () => undefined, set: async () => {} },
    logger: { debug() {}, trace() {}, info() {}, warn() {}, error() {} },
    httpInstance: {
      post: async (url, data) => {
        assert.ok(url.endsWith('/auth/v3/tenant_access_token/internal'))
        assert.equal(data.app_id, 'cli_synthetic_minutes')
        tokens++
        return { tenant_access_token: 't-synthetic', expire: 7200 }
      },
      request: async request => {
        requests.push(request)
        assert.equal(request.headers.Authorization, 'Bearer t-synthetic')
        if (request.url.endsWith('/transcript')) {
          assert.equal(request.responseType, 'stream')
          return { data: Readable.from(['合成会议对话']), headers: { 'content-type': 'text/plain' } }
        }
        return { code: 0, data: { minute: { token, title: '合成会议' } } }
      },
    },
  })
  const business = harness(client)
  assert.equal((await business.execute('feishu_minutes', { action: 'info', minute_token: token }, {})).minute.title, '合成会议')
  assert.equal((await business.execute('feishu_minutes', { action: 'read', minute_token: token }, {})).transcript, '合成会议对话')
  assert.equal(tokens, 2)
  assert.equal(requests.length, 2)
})
