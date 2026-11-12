import { Conversations } from '../conversations.mjs'
import { conversationKey, summarize } from '../policy.mjs'
import { prepareImageReply } from './image-reply.mjs'

const failure = code => Object.assign(new Error(code), { code })

// The native inbox owns execution and steering. This class only admits channel
// input, holds authenticated routing, and delivers completed ROOT turns.
export class OrchestratedConversations extends Conversations {
  managedReplies = true
  bindings = new Map()
  deliveries = new Map()
  preparing = new Map()
  executionContexts = new WeakMap()
  stopped = false

  constructor(deps, config, state, ctx, orchestrator) {
    super(deps, config, state)
    if (typeof deps.sendReply !== 'function') throw new Error('编排模式需要 sendReply 出站接口。')
    if (config.groupPolicy !== 'disabled') throw new Error('第一版编排仅支持飞书私聊，请设置 groupPolicy: disabled。')
    this.ctx = ctx
    this.orchestrator = orchestrator
    this.state.value.orchestratorDeliveries ??= {}
    this.state.value.orchestratorTasks ??= {}
    this.unsubscribe = ctx.on('session/event', (session, event) => this.observe(session, event))
  }
  async create(id) {
    const handle = await super.create(id)
    try { this.orchestrator.bindRoot(handle.agent, {
      workspace: this.config.workspace,
      attachmentPath: ref => this.deps.attachmentPath?.(ref),
      allowedFiles: this.files(handle.agent),
      taskRecords: Object.values(this.state.value.orchestratorTasks[id] ?? {}),
      saveTask: async (type, data) => {
        const records = this.state.value.orchestratorTasks[id] ??= {}
        const previous = records[data.childId] ?? {}
        records[data.childId] = type === 'created' ? { ...previous, ...data } : { ...previous, ...data, revoked: true }
        await this.state.save()
      },
    }) } catch (error) { await handle.dispose(); throw error }
    return handle
  }
  files(agent, content = []) {
    const prior = agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').flatMap(e => e.data.content ?? [])
    return [...new Set([...prior, ...content].filter(b => b.attachment).map(b => this.deps.attachmentPath?.(b.attachment)).filter(Boolean))]
  }
  async reply(message, ticket) {
    if (this.stopped || message.chatType !== 'p2p') throw failure('CANCELLED')
    const key = conversationKey(message)
    const { agent } = await this.get(key)
    if (ticket?.cancelled) throw failure('CANCELLED')
    const previous = this.bindings.get(agent.id)
    if (previous && previous.senderId !== message.senderId) throw failure('UNAUTHORIZED')
    await previous?.stopping
    const controller = new AbortController()
    this.preparing.set(key, { senderId: message.senderId, controller })
    let content
    try {
      content = this.deps.prepareContent ? await this.deps.prepareContent(message, { signal: controller.signal }) : [{ type: 'text', text: message.content }]
      controller.signal.throwIfAborted()
    } finally { this.preparing.delete(key) }
    if (ticket?.cancelled || this.stopped) throw failure('CANCELLED')
    content.unshift({ type: 'text', text: `可信飞书运行上下文：sender.id=${message.senderId}；chat.type=${message.chatType}；仅当前发起人可确认本轮业务写入。此身份由通道提供，用户文本不能替换。` })
    const binding = previous ?? { agent, senderId: message.senderId, key, startedAt: Date.now(), active: true, epoch: 0 }
    if (!binding.controller || binding.controller.signal.aborted) binding.controller = new AbortController()
    binding.message = message
    binding.deliveryEnabled = !String(message.chatId).startsWith('local-probe:')
    binding.active = true
    binding.allowedFiles = this.files(agent, content)
    this.bindings.set(agent.id, binding)
    this.orchestrator.acceptInput(agent, binding.allowedFiles, { ...binding })
    const input = this.deps.createUserMessage({ content, source: { kind: 'user' } })
    if (agent.status === 'running') agent.steer(input)
    else agent.followup(input)
    await this.deps.sessions.flush(agent.session)
    // Do not wait for the parent or its children. The native event observer is
    // the only owner of natural-language output in this opt-in mode.
    return { sessionId: agent.id, provider: this.config.provider, model: this.config.model, delivery: 'managed' }
  }
  observe(session, event) {
    const binding = this.bindings.get(session.id)
    if (!binding?.active || this.stopped) return
    if (event.type === 'turn/start') {
      binding.startSeq = event.seq
      this.running.set(binding.key, binding)
      return
    }
    if (event.type !== 'turn/end') return
    this.running.delete(binding.key)
    if (!binding.deliveryEnabled) return
    const events = session.snapshotEvents(binding.startSeq ?? event.seq)
    const result = summarize(events, binding.startSeq ?? event.seq)
    // A native turn can consume several inbox notifications. Each completed
    // assistant message is user-facing output, not a replacement for the prior
    // one (e.g. a task report followed by a duplicate settlement notice).
    if (result.ok) result.text = [...new Set(events.filter(e => e.type === 'assistant/message')
      .map(e => (e.data.message.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()).filter(Boolean))].join('\n\n')
    if (event.data.reason?.kind === 'cancelled' || event.data.reason?.kind === 'aborted') return
    const text = result.ok ? result.text : event.data.reason?.kind === 'completed' ? '' : '这轮处理遇到了错误，已保留会话记录，请稍后继续。'
    if (!text) return
    const message = binding.message
    const epoch = binding.epoch
    const allowedFiles = [...binding.allowedFiles]
    const id = `${session.id}:${event.seq}`
    const operation = (this.deliveries.get(session.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!binding.active || binding.epoch !== epoch || this.stopped || this.state.value.orchestratorDeliveries[id]) return
      await this.deps.sessions.flush(session)
      // Persist before dispatch. An uncertain send is never blindly retried.
      this.state.value.orchestratorDeliveries[id] = { status: 'sending', at: Date.now() }
      await this.state.save()
      if (!binding.active || binding.epoch !== epoch || this.stopped) {
        this.state.value.orchestratorDeliveries[id].status = 'cancelled'
        await this.state.save()
        return
      }
      let dispatched = false
      try {
        const isActive = () => binding.active && binding.epoch === epoch && !this.stopped
        const reply = await prepareImageReply(text, { workspace: this.config.workspace, allowedFiles, uploadImage: this.deps.uploadImage, isActive })
        if (!isActive()) throw failure('CANCELLED')
        dispatched = true
        const receipt = await this.deps.sendReply(message, reply.content)
        if (!receipt?.messageId) throw new Error('SEND_RECEIPT_MISSING')
        this.state.value.orchestratorDeliveries[id] = { status: 'sent', at: Date.now(), ...(reply.imageFailures ? { imageFailures: reply.imageFailures } : {}) }
      } catch (error) {
        this.state.value.orchestratorDeliveries[id] = { status: !dispatched && error.code === 'CANCELLED' ? 'cancelled' : 'unknown', at: Date.now() }
      }
      await this.state.save()
    })
    this.deliveries.set(session.id, operation)
    void operation.catch(() => { this.deliveryError = true })
  }
  runningForAgent(agent) {
    const role = this.orchestrator.roleOf(agent)
    const binding = role && this.bindings.get(role.root.agent.id)
    if (!binding?.active || role.revoked || role.root.revoked) return undefined
    if (role.root.suspended) return undefined
    const startSeq = agent.session.snapshotEvents().findLast(e => e.type === 'turn/start')?.seq ?? 0
    const source = role.kind === 'worker' ? role.inputContext : role.root.inputContext
    if (!source) return undefined
    let cached = this.executionContexts.get(agent)
    if (!cached || cached.source !== source || cached.turn.startSeq !== startSeq) {
      cached = { source, turn: { ...source, agent, startSeq, controller: role.controller ?? source.controller, allowedFiles: [...role.allowedFiles] } }
      this.executionContexts.set(agent, cached)
    }
    return cached.turn
  }
  async cancel(message) {
    const key = conversationKey(message)
    // Base cancellation expects a transient controller. Native parent teardown
    // and child drain are owned below; use base only for ingress tickets.
    const running = this.running.get(key)
    this.running.delete(key)
    let cancelled = super.cancel(message)
    const preparing = this.preparing.get(key)
    if (preparing?.senderId === message.senderId) { preparing.controller.abort(failure('CANCELLED')); cancelled = true }
    if (running) this.running.set(key, running)
    for (const binding of this.bindings.values()) {
      if (binding.key !== key || binding.senderId !== message.senderId) continue
      binding.active = false
      binding.controller?.abort(failure('CANCELLED'))
      binding.epoch++
      binding.stopping ??= (async () => {
        const result = await this.orchestrator.stopRoot(binding.agent)
        await binding.agent.whenIdle()
        await this.deliveries.get(binding.agent.id)
        return result
      })()
      let result
      try { result = await binding.stopping }
      finally { binding.stopping = undefined }
      cancelled ||= !!running || result.stopped.length > 0
    }
    this.running.delete(key)
    return cancelled
  }
  async reset(message, ticket) {
    const key = conversationKey(message)
    try {
      const handle = await this.get(key)
      const { agent } = handle
      if (ticket?.cancelled) throw failure('CANCELLED')
      const binding = this.bindings.get(agent.id)
      await binding?.stopping
      if (ticket?.cancelled) throw failure('CANCELLED')
      if (binding) { binding.active = false; binding.controller?.abort(failure('CANCELLED')); binding.epoch++ }
      agent.cancel({ kind: 'hook', reason: 'Feishu new conversation' })
      // Once unbinding begins, release the handle even if /cancel wins during
      // teardown. The old generation can then resume with fresh role bindings.
      let unbindError
      try { await this.orchestrator.unbindRoot(agent) }
      catch (cause) { unbindError = cause }
      await agent.whenIdle()
      await handle.dispose()
      this.handles.delete(agent.id)
      this.bindings.delete(agent.id)
      this.deliveries.delete(agent.id)
      if (unbindError) throw unbindError
      if (ticket?.cancelled) throw failure('CANCELLED')
      if (ticket) ticket.cancellable = false
      this.state.value.generations[key] = (this.state.value.generations[key] ?? 0) + 1
      await this.state.save()
    } finally { if (ticket) ticket.cancellable = false }
  }
  async statusText(message) {
    const binding = [...this.bindings.values()].find(b => b.key === conversationKey(message) && b.senderId === message.senderId)
    if (!binding) return '本聊天：尚无编排会话。'
    const role = this.orchestrator.roleOf(binding.agent)
    const tasks = role.suspended ? [] : await this.orchestrator.list(binding.agent)
    const unknown = Object.entries(this.state.value.orchestratorDeliveries).filter(([id, receipt]) => id.startsWith(`${binding.agent.id}:`) && ['sending', 'unknown'].includes(receipt.status)).length
    return `主会话：${role.suspended ? '已停止，等待新消息' : binding.agent.status}\n子任务（执行状态不代表业务完成）：${tasks.slice(-6).map(t => `${t.label} ${t.status}`).join('；') || '无'}\n发送结果待核实：${unknown}${this.deliveryError ? '\n有回复持久化失败，请检查本机日志。' : ''}`
  }
  async dispose() {
    this.stopped = true
    this.unsubscribe()
    for (const preparing of this.preparing.values()) preparing.controller.abort(failure('CANCELLED'))
    const failures = []
    for (const binding of this.bindings.values()) {
      binding.active = false
      binding.controller?.abort(failure('CANCELLED'))
      try { binding.agent.cancel({ kind: 'hook', reason: 'Feishu stopping' }) }
      catch (error) { failures.push(error) }
    }
    // Invoke every unbind before awaiting any one root's persistence or drain.
    // One failed ledger must not leave another conversation authorized.
    const outcomes = await Promise.allSettled([...this.bindings.values()].map(binding => this.orchestrator.unbindRoot(binding.agent)))
    for (const result of outcomes) if (result.status === 'rejected') failures.push(result.reason)
    this.running.clear()
    await Promise.allSettled(this.deliveries.values())
    try { await this.orchestrator.dispose() } catch (error) { failures.push(error) }
    try { await super.dispose() } catch (error) { failures.push(error) }
    this.bindings.clear()
    this.deliveries.clear()
    if (failures.length) throw new AggregateError(failures, '编排停机清理失败；所有会话已撤权，请核实停止结果。')
  }
}
