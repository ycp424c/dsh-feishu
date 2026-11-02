import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, symlink, writeFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { Conversations } from '../src/conversations.mjs'
import { FeishuTools } from '../src/business/index.mjs'
import { FeishuApprovals } from '../src/approvals.mjs'
import { State } from '../src/state.mjs'
import { conversationKey } from '../src/policy.mjs'
import { workspacePath } from '../src/private-boundary.mjs'

const requireRuntime = createRequire(new URL('../runtime/package.json', import.meta.url))
const installed = existsSync(new URL('../runtime/node_modules/@deepseek-ai/dsh-agent/lib/index.js', import.meta.url))
const load = name => import(pathToFileURL(requireRuntime.resolve(name.startsWith('@') ? name : `@deepseek-ai/dsh-${name}`)).href)

test('Feishu path admission agrees with DSH physical symlink and parent traversal', { skip: !installed }, async () => {
  const [{ Context }, fs] = await Promise.all([load('@deepseek-ai/cordis'), load('fs-local')])
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feishu-dsh-path-'))), workspace = join(root, 'workspace'), privateDir = join(root, 'private')
  const ctx = new Context()
  try {
    await mkdir(workspace); await mkdir(join(privateDir, 'child'), { recursive: true })
    await writeFile(join(privateDir, 'secret.txt'), 'SYNTHETIC')
    await symlink(join(privateDir, 'child'), join(workspace, 'link'), 'dir')
    await ctx.plugin(fs.default, { cwd: workspace })
    for (const path of ['link/..', 'link/../secret.txt', 'link/../new-output.txt']) {
      const target = await ctx.fs.resolve(path, { cwd: workspace })
      assert.ok(ctx.fs.processPath(target).startsWith(privateDir))
      assert.equal(await workspacePath(path, workspace), false, path)
    }
    await assert.rejects(ctx.fs.resolve('missing/../secret.txt', { cwd: workspace }))
    assert.equal(await workspacePath('missing/../secret.txt', workspace), false)
    assert.equal(await workspacePath('new-dir/new-output.txt', workspace), true)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

// Only JavaScript API integration: no CLI, platform sandbox, model credentials,
// Feishu connection, or native installation scripts are needed here.
test('pinned DSH resumes Feishu sessions and preserves requester approval, receipts, and readback', { skip: !installed, timeout: 15000 }, async () => {
  const [{ Context }, llm, sessions, projection, prompt, tools, agents, persistence, loop] = await Promise.all([
    load('@deepseek-ai/cordis'), load('llm'), load('session'), load('session-projection'), load('system-prompt'),
    load('tools'), load('agent'), load('session-persistence-jsonl'), load('agent-loop'),
  ])
  const dir = await mkdtemp(join(tmpdir(), 'feishu-dsh-api-'))
  const state = new State(join(dir, 'channel-state.json')); await state.load()
  const config = { appId: 'synthetic', domain: 'feishu', workspace: dir, provider: 'synthetic', model: 'test-model', agentPreset: 'standard', maxTurnMs: 5000 }
  const message = { chatType: 'p2p', chatId: 'oc_synthetic', senderId: 'ou_synthetic', messageId: 'om_request', content: 'read chat' }
  let ctx, bridge, approvals, business, chatReads = 0, writes = 0, readbacks = 0
  const cardReady = Promise.withResolvers()
  const requests = []
  const text = value => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const call = (id, name, args) => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: llm.ToolCallId(id), name, argumentsDelta: JSON.stringify(args) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: llm.ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const script = [call('chat-read', 'feishu_chat', { action: 'info', chat_id: 'oc_synthetic' }), text('chat read'),
    call('message-write', 'message', { action: 'send', target: 'ou_synthetic', message: 'Synthetic notification' }), text('session resumed')]
  const adapter = new class extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      const chunks = script.shift(); assert.ok(chunks, 'unexpected model request')
      yield* chunks
    }
  }()
  async function mount() {
    ctx = new Context()
    for (const mod of [llm, sessions, projection, prompt, tools, agents]) await ctx.plugin(mod.default)
    await ctx.plugin(persistence, { root: join(dir, 'sessions'), compression: 'none' })
    await ctx.plugin(loop.default, { agents: [] })
    ctx.llm.registerAdapter(['synthetic'], adapter)
    bridge = new Conversations({
      agents: ctx.agents, sessions: ctx.sessions, sessionPersistence: ctx.sessionPersistence,
      agentPresets: { resolve: async id => ({ id }), mount: async () => {} },
      workspaceRegistry: { resolveByPath: async () => ({ attachSession: async () => {} }) },
      installModelSelection: agents.installModelSelection, createUserMessage: llm.createUserMessage, sessionId: sessions.SessionId,
    }, config, state)
    approvals = new FeishuApprovals({
      runningForAgent: agent => bridge.runningForAgent(agent),
      sendCard: (recipient, card) => { cardReady.resolve({ recipient, card }); return { messageId: 'om_card' } },
      updateCard: async () => {}, timeoutMs: 5000,
    })
    business = new FeishuTools({
      client: () => ({ im: {
        chat: { get: async () => { chatReads++; return { code: 0, data: { chat_id: 'oc_synthetic', name: 'Synthetic chat' } } } },
        message: {
          create: async () => { writes++; return { code: 0, data: { message_id: 'om_written' } } },
          get: async () => { readbacks++; return { code: 0, data: { items: [{ message_id: 'om_written' }] } } },
        },
      } }),
      runningForAgent: agent => bridge.runningForAgent(agent), approvals, config: { ...config, stateDir: dir },
    })
    await business.load()
    const definitions = business.definitions(); assert.equal(definitions.length, 16)
    for (const definition of definitions) ctx.tools.register(definition)
  }
  try {
    await mount()
    const first = await bridge.reply(message)
    assert.equal(first.text, 'chat read'); assert.equal(chatReads, 1)
    const handle = await bridge.get(conversationKey(message))
    const result = handle.agent.session.snapshotEvents().find(e => e.type === 'tool/result')
    assert.equal(result.data.message.isError, false)
    assert.ok(JSON.stringify(result.data.message.content).includes('Synthetic chat'))
    await bridge.dispose(); await ctx.fiber.dispose()
    await mount()
    const work = bridge.reply({ ...message, messageId: 'om_continue', content: 'continue' })
    const shown = await cardReady.promise; await setImmediate()
    assert.equal(shown.recipient, 'ou_synthetic'); assert.equal(writes, 0)
    const action = { tag: 'button', value: shown.card.elements.at(-1).actions[0].value }
    assert.equal(approvals.onCardAction({ messageId: 'om_card', operator: { openId: 'ou_other' }, action }), false)
    assert.equal(writes, 0)
    assert.equal(approvals.onCardAction({ messageId: 'om_card', operator: { openId: 'ou_synthetic' }, action }), true)
    const second = await work
    assert.equal(second.text, 'session resumed'); assert.equal(second.sessionId, first.sessionId)
    assert.ok(requests.at(-1).messages.some(m => m.role === 'assistant' && m.content.some(b => b.type === 'text' && b.text === 'chat read')))
    assert.equal(writes, 1); assert.equal(readbacks, 1)
    assert.equal(Object.values(business.ledger)[0].status, 'verified')
    assert.equal(Object.values(business.ledger)[0].result.message_id, 'om_written')
    assert.equal(script.length, 0)
  } finally {
    approvals?.dispose(); await bridge?.dispose(); await ctx?.fiber.dispose(); await rm(dir, { recursive: true, force: true })
  }
})
