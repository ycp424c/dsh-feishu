import assert from 'node:assert/strict'
import { after } from 'node:test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const runtimeRequire = createRequire(new URL('../../runtime/package.json', import.meta.url))
const load = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const llm = await load('@deepseek-ai/dsh-llm')
const agents = await load('@deepseek-ai/dsh-agent')
const sessions = await load('@deepseek-ai/dsh-session')
import { State } from 'dsh-feishu/core/state'
import { conversationKey } from 'dsh-feishu/core/policy'
import { OrchestratedConversations } from '../../src/orchestration/feishu.mjs'
import * as orchestrator from '../../src/orchestration/index.mjs'

const testHome = await mkdtemp(join(tmpdir(), 'orchestrator-test-home-'))
const previousHome = process.env.DSH_HOME
const previousAgentsHome = process.env.DSH_AGENTS_HOME
process.env.DSH_HOME = testHome
process.env.DSH_AGENTS_HOME = join(testHome, 'agents')
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgentsHome
  await rm(testHome, { recursive: true, force: true })
})

export { llm }
export const text = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
]
export const call = (name, args) => {
  const id = llm.ToolCallId(crypto.randomUUID())
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
export async function until(predicate, description, timeout = 6000) {
  const start = Date.now()
  while (!await predicate()) {
    if (Date.now() - start > timeout) assert.fail(`Timed out: ${description}`)
    await setTimeout(10)
  }
}

export async function host(model, options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'orchestrator-native-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const ctx = new Context()
  const errors = []
  const events = new Map()
  ctx.on('session/event', (session, event) => { const list = events.get(session.id) ?? []; list.push(event); events.set(session.id, list) })
  ctx.on('internal/error', error => errors.push(error))
  async function plugin(name, config) {
    const mod = await load(`@deepseek-ai/dsh-${name}`)
    await ctx.plugin(mod.default ?? mod, config)
  }
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'fs-local', 'working-directory', 'subprocess-local']) await plugin(name)
  for (const name of ['shell-env', 'bash-local', 'jobs-local']) await plugin(name)
  await plugin('session-persistence-jsonl', { root: join(root, 'sessions'), compression: options.compression ?? 'none' })
  await plugin('session-query-sqlite', { path: ':memory:', openAt: 'never' })
  await plugin('subagent')
  await plugin('subagent-spawn-in-process')
  await ctx.plugin(Loader, { baseUrl: new URL('../../runtime/package.json', import.meta.url).href })
  await plugin('agent-preset-registry', { default: 'orchestrator-frontdesk' })
  for (const name of ['skill', 'web', 'attachment-local']) await plugin(name, name === 'attachment-local' ? { dshHome: root } : undefined)
  await plugin('skill-filesystem', options.skillFilesystem ?? { includeDefaultRoots: false, customSkillDirs: [join(workspace, '.dsh/skills'), join(workspace, '.agents/skills')], watch: false })
  const presetsConfig = JSON.parse(await readFile(new URL('../../src/orchestration/presets.json', import.meta.url), 'utf8'))
  for (const preset of options.fullHost ? [] : presetsConfig) await ctx.agentPresets.register(preset)
  const presets = await ctx.agentPresets.list()
  assert.equal(presets.filter(p => p.broken).map(p => p.broken).join('\n'), '', 'shipped presets activate: ' + errors.map(e => String(e.stack ?? e)).join('\n'))
  await plugin('agent-loop', { agents: [] })
  const service = options.fullHost ? undefined : orchestrator.createOrchestrator(ctx, options.orchestrator)
  if (service) ctx.provide('orchestrator', service)
  const requests = []
  const adapter = new class extends llm.LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text', 'image'] } }
    async *stream(request) { requests.push(request); yield* await model(request, ctx) }
  }()
  ctx.llm.registerAdapter(['synthetic'], adapter)
  const state = new State(join(root, 'channel-state.json'))
  await state.load()
  const config = { appId: 'synthetic', domain: 'feishu', sessionNamespace: 'orchestrator-test', workspace, provider: 'synthetic', model: 'test', agentPreset: 'orchestrator-frontdesk', groupPolicy: 'disabled', maxTurnMs: 0 }
  const sent = []
  const bridge = options.fullHost ? undefined : new OrchestratedConversations({
    agents: ctx.agents, sessions: ctx.sessions, sessionPersistence: ctx.sessionPersistence, agentPresets: ctx.agentPresets,
    workspaceRegistry: { resolveByPath: async () => ({ attachSession: async () => {} }) },
    installModelSelection: agents.installModelSelection, createUserMessage: llm.createUserMessage, sessionId: sessions.SessionId,
    sendReply: async (message, content) => { sent.push({ message, content }); return options.sendReply ? options.sendReply(message, content) : { messageId: `receipt-${sent.length}` } },
    attachmentPath: ref => ref.mediaType ? ctx.attachments.imageHostPath(ref) : ctx.attachments.fileHostPath(ref),
    ...options.deps,
  }, config, state, ctx, service)
  const message = (content, overrides = {}) => ({ chatType: 'p2p', chatId: 'synthetic-chat', senderId: 'synthetic-user', messageId: crypto.randomUUID(), content, ...overrides })
  return { ctx, root, workspace, bridge, config, state, sent, requests, errors, events, message,
    async input(content, overrides) { const msg = message(content, overrides); return bridge.enqueue(msg, ticket => bridge.reply(msg, ticket)) },
    async parent() { return (await bridge.get(conversationKey(message('')))).agent },
    async dispose({ keepFiles = false } = {}) {
      await bridge?.dispose()
      await ctx.fiber.dispose()
      if (!keepFiles) await rm(root, { recursive: true, force: true })
    },
  }
}
