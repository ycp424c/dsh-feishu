import { readFileSync } from 'node:fs'
import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Conversations } from './conversations.mjs'
import { State } from './state.mjs'
import { Attachments } from './attachments.mjs'
import { feishuResourceReader } from './feishu-resources.mjs'
import { decodeProbeAttachments, probeBodyLimit } from './probe-attachments.mjs'
import { createMessageReceiver } from './messages.mjs'
import { FeishuApprovals, defaultApprovalTimeoutMs } from './approvals.mjs'
import { FeishuReplies } from './replies.mjs'
import { TypingIndicators } from './typing.mjs'
import { FeishuTools } from './business/index.mjs'
import { businessClient as createBusinessClient } from './business/client.mjs'
import { installUsage } from './usage.mjs'
import { installPrivateBoundary } from './private-boundary.mjs'

import { acquireChannelLease } from './lease.mjs'
import { contractVersion, ExtensionRegistry } from './contracts/index.mjs'
export const baseVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
export async function startFeishu(ctx, raw = {}, application = {}, dependencies) {
  const { createLarkChannel, Domain, LoggerLevel, installModelSelection, createUserMessage, SessionId, credentialRef } = dependencies
  const version = application.version ?? baseVersion
  const label = application.label ?? 'DSH Feishu Bot'
  const apiPrefix = application.apiPrefix ?? '/feishu/api'
  const extensions = new ExtensionRegistry(application.requiredExtensions ?? raw.requiredExtensions ?? [])
  const config = { businessEnabled: true, privateBoundary: true, botLabel: label, sessionNamespace: application.sessionNamespace ?? 'dsh-feishu', domain: 'feishu', dmMode: 'allowlist', dmAllowlist: [], groupPolicy: 'disabled', groupAllowlist: [], requireMention: true, groupReplyInThread: true, groupThreadAutoReply: true, groups: {}, agentPreset: 'standard', maxTurnMs: 0, approvalTimeoutMs: defaultApprovalTimeoutMs, ...raw }
  for (const field of ['appId', 'workspace', 'stateDir', 'provider', 'model']) {
    if (typeof config[field] !== 'string' || !config[field]) throw new Error(`dsh-feishu: ${field} required`)
  }
  // Fresh production/isolated deployments must register the workspace before
  // scheduling; merely creating its directory or an Agent does not register it.
  await ctx.workspaceRegistry.create(config.workspace, label)
  if (!Number.isSafeInteger(config.maxTurnMs) || config.maxTurnMs < 0 || config.maxTurnMs > 2147483647) throw new Error('dsh-feishu: maxTurnMs must be 0 or a supported positive timer duration')
  if (!Number.isSafeInteger(config.approvalTimeoutMs) || config.approvalTimeoutMs < 1000 || config.approvalTimeoutMs > 3600000) throw new Error('dsh-feishu: approvalTimeoutMs must be between 1000 and 3600000')
  if (typeof config.groupReplyInThread !== 'boolean') throw new Error('dsh-feishu: groupReplyInThread must be boolean')
  if (typeof config.groupThreadAutoReply !== 'boolean') throw new Error('dsh-feishu: groupThreadAutoReply must be boolean')
  const enabled = application.enabled ?? (process.env.DSH_FEISHU_ENABLED === '1')
  const state = new State(join(config.stateDir, 'channel-state.json'))
  await state.load()
  let channel
  let releaseLease = async () => {}
  const probeResources = new WeakMap()
  const openFeishuResource = feishuResourceReader(() => channel?.rawClient)
  const attachments = new Attachments({
    store: ctx.attachments,
    openResource: (message, resource, signal) => {
      const local = probeResources.get(message)
      return local ? Readable.from([local.get(resource.fileKey)]) : openFeishuResource(message, resource, signal)
    },
    supportsImages: async signal => (await ctx.llm.resolveModelInfo(config.provider, config.model, signal)).inputModalities?.includes('image') === true,
  }, config.attachmentLimits)
  const bridge = new Conversations({
    agents: ctx.agents, sessions: ctx.sessions, sessionPersistence: ctx.sessionPersistence,
    agentPresets: ctx.agentPresets, workspaceRegistry: ctx.workspaceRegistry,
    installModelSelection, createUserMessage, sessionId: SessionId,
    prepareContent: (message, options) => attachments.prepare(message, options),
    attachmentPath: ref => ref.mediaType ? ctx.attachments.imageHostPath(ref) : ctx.attachments.fileHostPath(ref),
  }, config, state)
  const metrics = { backend: 'dsh', version, enabled, connected: false, received: 0, rejected: 0, completed: 0, failed: 0, sent: 0, sendFailed: 0, startedAt: new Date().toISOString() }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  async function audit(event, fields = {}) {
    await appendFile(join(config.stateDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 })
  }
  const replies = new FeishuReplies(() => channel, state, config)
  const typing = new TypingIndicators(() => channel?.rawClient, state, audit)
  const approvals = new FeishuApprovals({
    runningForAgent: agent => bridge.runningForAgent(agent),
    sendCard: (recipient, card) => channel.send(recipient, { card }),
    updateCard: (messageId, card) => channel.updateCard(messageId, card),
    audit,
    timeoutMs: config.approvalTimeoutMs,
    sessionDirectory: agent => ctx.workingDirectory?.get(agent.session) ?? agent.session.header?.cwd,
    ...application.approvalOptions,
  })
  let business, businessClient
  const usage = await installUsage(ctx, config, bridge)
  if (config.businessEnabled) {
    try { config.testResources = JSON.parse(await readFile(join(config.stateDir, 'test-resources.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e; config.testResources = { docTokens: [], appTokens: [] } }
    const appSecret = (await ctx.credentials.resolve(credentialRef(config.appSecretRef)))?.value
    if (!appSecret) throw new Error('Missing business credential')
    businessClient = createBusinessClient({ appId: config.appId, appSecret, domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu, logger: { debug() {}, trace() {}, info() {}, warn() {}, error() {} } })
    business = (application.createOperations ?? (options => new FeishuTools(options)))({ client: () => businessClient, runningForAgent: a => bridge.runningForAgent(a), approvals, config, audit })
    await business.load()
    for (const definition of business.definitions()) ctx.tools.register(definition)
  }
  let resolveReady, rejectReady, initialized = false, suspended = false, stopping
  const startupAbort = new AbortController()
  const whenReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Readiness is observable without blocking Cordis service activation.
  void whenReady.catch(() => {})
  const runtime = Object.freeze({ ctx, config, bridge, approvals, operations: business, attachments, audit, extensions, contractVersion, whenReady, tools: { register: definition => ctx.tools.register(definition) }, context: { forExecution: exec => bridge.runningForAgent(exec.agent) } })
  ctx.provide('dshFeishu', runtime)
  if (config.privateBoundary) installPrivateBoundary(ctx, { config, bridge, attachments })
  await application.setup?.(runtime)
  const stop = () => stopping ??= (async () => {
    initialized = false; metrics.connected = false; startupAbort.abort(); approvals.dispose()
    await bridge.dispose(); await typing.dispose()
    if (channel) await channel.disconnect()
    await releaseLease()
  })()
  const readinessChanged = () => {
    if (initialized && !extensions.isReady) {
      suspended = true; metrics.needsRestart = true
      void stop().catch(() => { metrics.shutdownError = 'CHANNEL_STOP_FAILED' })
    }
  }
  ctx.effect(() => { extensions.waiters.add(readinessChanged); return () => { extensions.waiters.delete(readinessChanged) } }, 'Feishu extension readiness')
  const status = () => ({ ...metrics, baseVersion, ...extensions.snapshot(), ready: initialized && !suspended && extensions.isReady, activeTasks: bridge.running.size, queuedConversations: bridge.queues.size, pendingApprovals: approvals.size, approvalMode: enabled ? 'feishu-card' : 'disabled', approvalTimeoutMs: config.approvalTimeoutMs, model: `${config.provider}/${config.model}`, maxTurnMs: config.maxTurnMs, progressMode: 'reaction-only', typingMode: 'reaction', groupReplyMode: config.groupReplyInThread ? 'thread' : 'inline', groupThreadAutoReply: config.groupReplyInThread && config.groupThreadAutoReply, capability: 'text-images-files-and-tools', attachmentSupport: true, attachmentLimits: attachments.limits, businessTools: business?.definitions().map(t => t.name) ?? [], businessEnvironment: config.environment ?? null, migratedMemory: Boolean(config.memoryRoot), usageMetadata: true, browserSupport: application.browserSupport ?? null })
  const receive = createMessageReceiver({ config, version, state, bridge, replies, typing, metrics, audit })

  async function api(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
    if (rejection !== undefined) return send(rejection, { error: 'unauthorized' })
    if (req.url.split('?')[0] === `${apiPrefix}/status` && req.method === 'GET') return send(200, status())
    if (req.url.split('?')[0] === `${apiPrefix}/usage` && req.method === 'GET') {
      try { return send(200, JSON.parse(await readFile(join(config.stateDir, 'usage/report.json'), 'utf8'))) } catch (e) { return send(e.code === 'ENOENT' ? 503 : 500, { error: 'USAGE_REPORT_NOT_READY' }) }
    }
    if (req.url.split('?')[0] === `${apiPrefix}/probe` && req.method === 'POST') {
      if (!status().ready) return send(503, { error: 'EXTENSIONS_NOT_READY' })
      try {
        const chunks = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > probeBodyLimit) return send(413, { error: 'too_large' }); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof body.content !== 'string' || body.content.length > 4000 || typeof body.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.key)) return send(400, { error: 'invalid_probe' })
        const message = { chatType: 'p2p', chatId: `local-probe:${body.key}`, senderId: 'local-probe', content: body.content }
        const local = decodeProbeAttachments(body.attachments)
        message.resources = local.resources
        probeResources.set(message, local.data)
        const result = await bridge.enqueue(message, () => bridge.reply(message))
        await usage.flush()
        return send(200, { ...result, delivery: 'none' })
      } catch (e) { return send(e.code === 'invalid_probe' || e instanceof SyntaxError ? 400 : 500, { error: e.code ?? 'PROBE_FAILED' }) }
    }
    return send(405, { error: 'method_not_allowed' })
  }
  for (const path of [`${apiPrefix}/status`, `${apiPrefix}/probe`, `${apiPrefix}/usage`]) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: api }), `Feishu authenticated route ${path}`)
  ctx.effect(() => stop, 'Feishu channel lifecycle')
  async function startup() {
  await extensions.waitReady(config.extensionTimeoutMs ?? 15000, startupAbort.signal)
  startupAbort.signal.throwIfAborted()
  if (!enabled) { await audit('channel.disabled'); startupAbort.signal.throwIfAborted(); initialized = true; return }
  const secret = (await ctx.credentials.resolve(credentialRef(config.appSecretRef)))?.value
  if (!secret) throw new Error('dsh-feishu: missing credential')
  startupAbort.signal.throwIfAborted()
  const quietLogger = { debug() {}, trace() {}, info() {}, warn() {}, error() { metrics.lastSdkErrorAt = new Date().toISOString() } }
  channel = createLarkChannel({
    appId: config.appId, appSecret: secret, transport: 'websocket',
    domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu, source: application.source ?? 'dsh-feishu',
    handshakeTimeoutMs: 15000, logger: quietLogger, loggerLevel: LoggerLevel.error,
    policy: { dmMode: config.dmMode, dmAllowlist: config.dmAllowlist, requireMention: false, respondToMentionAll: false },
    safety: { chatQueue: { enabled: false }, dedup: { ttl: 600000, maxEntries: 10000 }, staleMessageWindowMs: 300000 },
    outbound: { allowedFileDirs: [config.workspace] },
  })
  channel.on('message', message => (status().ready ? receive(message) : Promise.reject(new Error('Extensions unavailable'))).catch(async () => { metrics.failed++; await audit('handler.failed') }))
  channel.on('cardAction', event => { approvals.onCardAction(event) })
  channel.on('reject', event => { metrics.rejected++; void audit('sdk.rejected', { reason: event.reason }).catch(() => {}) })
  channel.on('reconnecting', () => { metrics.connected = false; void audit('channel.reconnecting').catch(() => {}) })
  channel.on('reconnected', () => { metrics.connected = !suspended && extensions.isReady; if (!metrics.connected) void channel.disconnect(); void audit('channel.reconnected').catch(() => {}) })
  channel.on('error', () => { metrics.lastSdkErrorAt = new Date().toISOString() })
  releaseLease = await acquireChannelLease(config.appId, config.domain, config.appLockDirectory)
  try { startupAbort.signal.throwIfAborted(); await channel.connect() } catch (error) { await channel.disconnect(); await releaseLease(); throw error }
  await typing.recover()
  startupAbort.signal.throwIfAborted()
  if (!extensions.isReady) throw new Error('Required Feishu extensions are not ready')
  initialized = true; metrics.connected = true
  ctx.effect(() => ctx.on('approval/request', (request, next) => approvals.request(request, next), { prepend: true }), 'Feishu approval answerer')
  await audit('channel.connected')
  ctx.logger.info(`Feishu channel connected (plugin v${version})`)
  }
  ctx.effect(() => {
    void startup().then(resolveReady, async error => {
      if (!startupAbort.signal.aborted) {
        metrics.startupError = 'CHANNEL_START_FAILED'
        await audit('channel.start.failed').catch(() => {})
      }
      rejectReady(error)
      await stop().catch(() => {})
      // Startup may finish acquiring resources after disposal began.
      if (channel) await channel.disconnect().catch(() => {})
      await releaseLease().catch(() => {})
    })
    return () => { void stop().catch(() => {}) }
  }, 'Feishu deferred startup')
  return runtime
}
