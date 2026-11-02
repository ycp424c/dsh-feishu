import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuApprovals } from '../src/approvals.mjs'
import { taskStatus } from '../src/policy.mjs'

function fixture({ sendCard, timeoutMs = 1000, sessionDirectory } = {}) {
  const controller = new AbortController()
  const agent = { session: { header: { cwd: '/workspace' }, snapshotEvents: () => [{
    seq: 10, type: 'tool/call',
    data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'echo safe', workdir: '/tmp', timeoutMs: 30000, run_in_background: true, sandbox_permissions: 'danger-full-access' }) },
  }] } }
  const turn = { agent, controller, senderId: 'ou_owner', startSeq: 5, startedAt: 1000 }
  const sent = [], updated = [], events = []
  const approvals = new FeishuApprovals({
    runningForAgent: candidate => candidate === agent ? turn : undefined,
    sendCard: async (recipient, card) => {
      sent.push({ recipient, card })
      return sendCard ? sendCard(recipient, card) : { messageId: 'om_card' }
    },
    updateCard: async (id, card) => { updated.push({ id, card }) },
    audit: async (event, fields) => { events.push({ event, fields }) },
    timeoutMs, sessionDirectory,
  })
  const request = { agent, toolName: 'bash', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: needed' }
  const click = (operator = 'ou_owner', decision = 'allow', messageId = 'om_card') => ({
    messageId, operator: { openId: operator }, action: { tag: 'button', value: { feishuApprovalId: sent[0].card.elements[1].actions[0].value.feishuApprovalId, decision } },
  })
  return { approvals, request, turn, sent, updated, events, click }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('one Feishu card privately presents the exact command; only its sender can approve once', async () => {
  const f = fixture()
  const pending = f.approvals.request(f.request, () => { throw new Error('must not delegate') })
  await tick()
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].recipient, 'ou_owner')
  assert.match(f.sent[0].card.elements[0].text.content, /echo safe/)
  assert.match(f.sent[0].card.elements[0].text.content, /"workdir": "\/tmp"/)
  assert.match(f.sent[0].card.elements[0].text.content, /"run_in_background": true/)
  assert.match(f.sent[0].card.elements[0].text.content, /"sandbox_permissions": "danger-full-access"/)
  assert.match(taskStatus(f.turn, 'ou_owner', 3000), /等待飞书审批/)
  assert.equal(f.approvals.onCardAction(f.click('ou_other')), false)
  assert.equal(f.approvals.size, 1)
  assert.equal(f.approvals.onCardAction(f.click('ou_owner', 'allow', 'om_other')), false)
  assert.equal(f.approvals.onCardAction(f.click()), true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(f.approvals.onCardAction(f.click()), false)
  assert.equal(f.approvals.size, 0)
  await tick()
  assert.match(f.updated[0].card.elements[0].text.content, /已批准一次/)
})

test('reject, cancellation, timeout, and card delivery failure all fail closed', async () => {
  {
    const f = fixture()
    const pending = f.approvals.request(f.request, () => 'allowed-once')
    await tick()
    assert.equal(f.approvals.onCardAction(f.click('ou_owner', 'reject')), true)
    assert.equal(await pending, 'rejected')
  }
  {
    const f = fixture()
    const pending = f.approvals.request(f.request, () => 'allowed-once')
    await tick()
    f.turn.controller.abort()
    assert.equal(await pending, 'cancelled')
    assert.equal(f.approvals.onCardAction(f.click()), false)
  }
  {
    const f = fixture()
    const controller = new AbortController()
    const pending = f.approvals.request({ ...f.request, signal: controller.signal }, () => 'allowed-once')
    await tick()
    controller.abort()
    assert.equal(await pending, 'cancelled')
    assert.equal(f.approvals.onCardAction(f.click()), false)
  }
  {
    const f = fixture({ timeoutMs: 15 })
    const pending = f.approvals.request(f.request, () => 'allowed-once')
    await tick()
    assert.equal(await pending, 'unavailable')
    assert.equal(f.approvals.onCardAction(f.click()), false)
  }
  {
    const f = fixture({ sendCard: async () => { throw new Error('send failed') } })
    assert.equal(await f.approvals.request(f.request, () => 'allowed-once'), 'unavailable')
  }
})

test('a late card after timeout cannot approve the command', async () => {
  let finish
  const f = fixture({ timeoutMs: 15, sendCard: () => new Promise(resolve => { finish = resolve }) })
  const pending = f.approvals.request(f.request, () => 'allowed-once')
  await tick()
  assert.equal(await pending, 'unavailable')
  finish({ messageId: 'om_card' })
  await tick()
  assert.equal(f.approvals.onCardAction(f.click()), false)
  assert.match(f.updated[0].card.elements[0].text.content, /已过期/)
})

test('requests without reviewable call details fail closed; unrelated agents delegate', async () => {
  const f = fixture()
  assert.equal(await f.approvals.request({ ...f.request, callId: 'missing' }, () => 'allowed-once'), 'unavailable')
  assert.equal(f.sent.length, 0)
  assert.equal(await f.approvals.request({ ...f.request, agent: {} }, () => 'rejected'), 'rejected')
  f.approvals.dispose()
})

test('the card uses the current turn call when a historical call ID is reused', async () => {
  const f = fixture()
  f.request.agent.session.snapshotEvents = fromSeq => [
    { seq: 1, type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'old command' }) } },
    { seq: 10, type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'current command' }) } },
  ].filter(event => event.seq >= fromSeq)
  const pending = f.approvals.request(f.request, () => 'allowed-once')
  await tick()
  assert.match(f.sent[0].card.elements[0].text.content, /current command/)
  assert.doesNotMatch(f.sent[0].card.elements[0].text.content, /old command/)
  f.turn.controller.abort()
  assert.equal(await pending, 'cancelled')
})

test('ambiguous call IDs within one turn cannot be approved', async () => {
  const f = fixture()
  f.request.agent.session.snapshotEvents = () => [
    { seq: 10, type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'first' }) } },
    { seq: 11, type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'second' }) } },
  ]
  assert.equal(await f.approvals.request(f.request, () => 'allowed-once'), 'unavailable')
  assert.equal(f.sent.length, 0)
})

test('a bash call without workdir states the session directory', async () => {
  const f = fixture()
  f.request.agent.session.snapshotEvents = () => [{
    seq: 10, type: 'tool/call',
    data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'pwd', sandbox_permissions: 'danger-full-access' }) },
  }]
  const pending = f.approvals.request(f.request, () => 'allowed-once')
  await tick()
  assert.match(f.sent[0].card.elements[0].text.content, /会话目录为 \/workspace/)
  f.turn.controller.abort()
  assert.equal(await pending, 'cancelled')
})

test('bash approval uses the effective DSH directory after a directory change', async () => {
  const f = fixture({ sessionDirectory: () => '/workspace/subdir' })
  const pending = f.approvals.request(f.request, () => 'unavailable')
  await tick()
  assert.match(f.sent[0].card.elements[0].text.content, /会话目录：\/workspace\/subdir/)
  f.turn.controller.abort()
  assert.equal(await pending, 'cancelled')
})

test('concurrent approvals keep the turn in approval state until all settle', async () => {
  let count = 0
  const f = fixture({ sendCard: async () => ({ messageId: `om_card_${++count}` }) })
  const first = f.approvals.request(f.request, () => 'allowed-once')
  const second = f.approvals.request(f.request, () => 'allowed-once')
  await tick()
  assert.equal(f.turn.approvals.size, 2)
  f.turn.controller.abort()
  assert.equal(await first, 'cancelled')
  assert.equal(await second, 'cancelled')
  assert.equal(f.turn.approvals, undefined)
})
