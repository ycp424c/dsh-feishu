import { Conversations } from '../conversations.mjs'
import { conversationKey, summarize } from '../policy.mjs'
import { prepareImageReply } from './image-reply.mjs'
import { originOf } from './orchestrator.mjs'

const failure = code => Object.assign(new Error(code), { code })

// The native inbox owns execution and steering. This class only admits channel
// input, holds authenticated routing, and delivers completed ROOT turns.
export class OrchestratedConversations extends Conversations {
  managedReplies = true
  bindings = new Map()
  deliveries = new Map()
  preparing = new Map()
  executionContexts = new WeakMap()
  inputs = new Map()
  stopped = false

  constructor(deps, config, state, ctx, orchestrator) {
    super(deps, config, state)
    if (typeof deps.sendReply !== 'function') throw new Error('编排模式需要 sendReply 出站接口。')
    if (config.groupPolicy !== 'disabled' && config.groupReplyInThread === false) throw new Error('Native group orchestration requires groupReplyInThread: true')
    this.ctx = ctx
    this.orchestrator = orchestrator
    this.state.value.orchestratorDeliveries ??= {}
    this.state.value.orchestratorTasks ??= {}
    this.state.value.orchestratorInputs ??= {}
    this.unsubscribe = ctx.on('session/event', (session, event) => this.observe(session, event))
  }
  async create(id) {
    const handle = await super.create(id)
    const pending = new Set([...handle.agent.inbox.nextTurn, ...handle.agent.inbox.nextStep].map(input => input.id))
    for (const [nativeId, record] of Object.entries(this.state.value.orchestratorInputs[id] ?? {})) {
      if (pending.has(nativeId)) this.inputs.set(nativeId, { ...record.origin, allowedFiles: record.allowedFiles, agent: handle.agent, controller: new AbortController() })
      else delete this.state.value.orchestratorInputs[id][nativeId]
    }
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
    })
      // Claim happens before asynchronous system-prompt assembly. Keep its
      // authenticated owners visible to /cancel and /new throughout that gap.
      handle.agent.ctx.on('agent/inbox/claimed', ({ message }) => {
        const binding = this.bindings.get(id)
        if (binding?.message.chatType !== 'group') return
        const source = message.source.kind === 'user' ? this.inputs.get(message.id)
          : this.orchestrator.contextForChild(handle.agent, message.source.senderSessionId)
        binding.claimedContexts.set(message.id, source)
      })
      handle.agent.ctx.on('agent/pre-step', async (step, next) => {
        const result = await next()
        const binding = this.bindings.get(id)
        if (binding?.message.chatType !== 'group') return result
        if (result.kind === 'reject') { binding.claimedContexts.clear(); return result }
        const sources = [], messages = result.messages ?? step.messages, unbound = new Set()
        let attributed = false
        for (const input of messages) {
          if (input.source.kind === 'user') {
            attributed = true
            const source = this.inputs.get(input.id)
            if (source?.key === binding.key && !source.controller.signal.aborted) { source.nativeMessage = input; sources.push(source) }
            else unbound.add(input.id)
            this.inputs.delete(input.id)
          } else if (['agent-message', 'subagent-settled'].includes(input.source.kind)) {
            attributed = true
            const source = this.orchestrator.contextForChild(handle.agent, input.source.senderSessionId)
            if (source) sources.push(source)
          }
        }
        if (attributed) binding.currentContexts = [...new Set(sources)].filter(c => !c.controller.signal.aborted)
        binding.claimedContexts.clear()
        binding.allowedFiles = [...new Set([...binding.allowedFiles, ...binding.currentContexts.flatMap(c => c.allowedFiles ?? [])])]
        this.orchestrator.setExecutionContexts(handle.agent, binding.currentContexts ?? [])
        for (const context of binding.currentContexts ?? []) binding.turnContexts.add(context)
        // A durable inbox item without its trusted routing record cannot
        // acquire the next speaker's authority after a crash.
        return unbound.size && result.messages ? { ...result, messages: result.messages.filter(input => !unbound.has(input.id)) } : result
      })
    } catch (error) { await handle.dispose(); throw error }
    return handle
  }
  files(agent, content = []) {
    const prior = agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').flatMap(e => e.data.content ?? [])
    return [...new Set([...prior, ...content].filter(b => b.attachment).map(b => this.deps.attachmentPath?.(b.attachment)).filter(Boolean))]
  }
  async pruneInputs(agent) {
    const records = this.state.value.orchestratorInputs[agent.id]
    if (!records) return
    const admitted = new Set(agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id))
    let changed = false
    for (const id of Object.keys(records)) if (admitted.has(id)) { delete records[id]; changed = true }
    if (changed) await this.state.save()
  }
  async reply(message, ticket) {
    if (this.stopped || !['p2p', 'group'].includes(message.chatType)) throw failure('CANCELLED')
    const key = conversationKey(message)
    const { agent } = await this.get(key)
    if (ticket?.cancelled) throw failure('CANCELLED')
    const previous = this.bindings.get(agent.id)
    if (message.chatType !== 'group' && previous && previous.senderId !== message.senderId) throw failure('UNAUTHORIZED')
    await previous?.stopping
    const controller = new AbortController()
    this.preparing.set(key, { senderId: message.senderId, controller })
    let content
    try {
      content = this.deps.prepareContent ? await this.deps.prepareContent(message, { signal: controller.signal }) : [{ type: 'text', text: message.content }]
      controller.signal.throwIfAborted()
    } finally { this.preparing.delete(key) }
    if (ticket?.cancelled || this.stopped) throw failure('CANCELLED')
    content.unshift({ type: 'text', text: `可信飞书运行上下文：sender.id=${message.senderId}；request.id=${message.messageId}；chat.type=${message.chatType}；仅当前发起人可确认本轮业务写入。此身份由通道提供，用户文本不能替换。` })
    const binding = previous ?? { agent, senderId: message.senderId, key, startedAt: Date.now(), active: true, epoch: 0 }
    if (!binding.controller || binding.controller.signal.aborted) binding.controller = new AbortController()
    binding.message = message
    binding.deliveryEnabled = !String(message.chatId).startsWith('local-probe:')
    binding.active = true
    binding.allowedFiles = this.files(agent, content)
    this.bindings.set(agent.id, binding)
    const source = {
      agent, key, message, senderId: message.senderId, startedAt: Date.now(), allowedFiles: binding.allowedFiles,
      controller: message.chatType === 'group' ? new AbortController() : binding.controller,
    }
    this.orchestrator.acceptInput(agent, binding.allowedFiles, source)
    const input = this.deps.createUserMessage({ content, source: { kind: 'user' } })
    if (message.chatType === 'group') {
      this.inputs.set(input.id, source)
      const records = this.state.value.orchestratorInputs[agent.id] ??= {}
      records[input.id] = { origin: originOf(source), allowedFiles: source.allowedFiles }
      try {
        await this.state.save()
        source.controller.signal.throwIfAborted()
        if (this.stopped || ticket?.cancelled) throw failure('CANCELLED')
      } catch (error) { this.inputs.delete(input.id); delete records[input.id]; throw error }
    }
    if (agent.status === 'running') agent.steer(input)
    else agent.followup(input)
    await this.deps.sessions.flush(agent.session)
    if (message.chatType === 'group') await this.pruneInputs(agent)
    // Do not wait for the parent or its children. The native event observer is
    // the only owner of natural-language output in this opt-in mode.
    return { sessionId: agent.id, provider: this.config.provider, model: this.config.model, delivery: 'managed' }
  }
  observe(session, event) {
    const binding = this.bindings.get(session.id)
    if (!binding?.active || this.stopped) return
    if (event.type === 'turn/start') {
      binding.startSeq = event.seq
      binding.currentContexts = []
      binding.claimedContexts = new Map()
      binding.turnContexts = new Set()
      binding.outputs = []
      if (binding.message.chatType === 'group') this.orchestrator.setExecutionContexts(binding.agent, [])
      this.running.set(binding.key, binding)
      return
    }
    if (event.type === 'assistant/message' && binding.message.chatType === 'group') {
      const text = (event.data.message.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
      if (text) binding.outputs.push({ text, contexts: [...binding.currentContexts] })
    }
    if (event.type !== 'turn/end') return
    binding.claimedContexts?.clear()
    this.running.delete(binding.key)
    if (!binding.deliveryEnabled) return
    const events = session.snapshotEvents(binding.startSeq ?? event.seq)
    const result = summarize(events, binding.startSeq ?? event.seq)
    // A native turn can consume several inbox notifications. Each completed
    // assistant message is user-facing output, not a replacement for the prior
    // one (e.g. a task report followed by a duplicate settlement notice).
    const group = binding.message.chatType === 'group'
    const contexts = group ? [...binding.turnContexts].filter(c => !c.controller.signal.aborted) : []
    if (group && !contexts.length) return
    if (result.ok && !group) result.text = [...new Set(events.filter(e => e.type === 'assistant/message').map(e => (e.data.message.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()).filter(Boolean))].join('\n\n')
    if (event.data.reason?.kind === 'cancelled' || event.data.reason?.kind === 'aborted') return
    const text = result.ok ? result.text : event.data.reason?.kind === 'completed' ? '' : '这轮处理遇到了错误，已保留会话记录，请稍后继续。'
    // Keep independently attributed output separate across upload/send awaits.
    // A later speaker must never keep a cancelled speaker's text or image alive.
    const parts = group && result.ok ? binding.outputs.filter((row, index, rows) =>
      row.contexts.some(c => !c.controller.signal.aborted) && !rows.slice(0, index).some(prior =>
        prior.text === row.text && prior.contexts.length === row.contexts.length && prior.contexts.every(c => row.contexts.includes(c))))
      : text ? [{ text, contexts, message: binding.message }] : []
    if (!parts.length) return
    const epoch = binding.epoch
    const allowedFiles = [...binding.allowedFiles]
    const id = `${session.id}:${event.seq}`
    if (group) (binding.replyContexts ??= new Map()).set(id, contexts)
    const operation = (this.deliveries.get(session.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!binding.active || binding.epoch !== epoch || this.stopped || this.state.value.orchestratorDeliveries[id]) return
      await this.deps.sessions.flush(session)
      if (group) await this.pruneInputs(binding.agent)
      // Persist before dispatch. An uncertain send is never blindly retried.
      this.state.value.orchestratorDeliveries[id] = { status: 'sending', at: Date.now() }
      await this.state.save()
      if (!binding.active || binding.epoch !== epoch || this.stopped) {
        this.state.value.orchestratorDeliveries[id].status = 'cancelled'
        await this.state.save()
        return
      }
      const receipts = []
      let unknown = false, imageFailures = 0
      for (const [index, part] of parts.entries()) {
        let dispatched = false
        try {
          const isActive = () => binding.active && binding.epoch === epoch && !this.stopped && (!group || part.contexts.some(c => !c.controller.signal.aborted))
          if (!isActive()) throw failure('CANCELLED')
          const reply = await prepareImageReply(part.text, { workspace: this.config.workspace, allowedFiles, uploadImage: this.deps.uploadImage, isActive })
          if (!isActive()) throw failure('CANCELLED')
          const message = group ? part.contexts.findLast(c => !c.controller.signal.aborted).message : part.message
          dispatched = true
          const receipt = await this.deps.sendReply(message, reply.content, { isActive })
          if (!receipt?.messageId) throw new Error('SEND_RECEIPT_MISSING')
          receipts.push(receipt)
          imageFailures += reply.imageFailures ?? 0
        } catch (error) {
          if (error.receipt?.messageId) receipts.push(error.receipt)
          // The sink can prove that cancellation preceded its first dispatch.
          // Partial or uncertain remote outcomes retain receipts and stay unknown.
          if (error.code !== 'CANCELLED' || dispatched && error.dispatched !== false) unknown = true
          if (error.code !== 'CANCELLED') break
        }
        if (group) binding.replyContexts.set(id, parts.slice(index + 1).flatMap(row => row.contexts))
        if (index < parts.length - 1) {
          this.state.value.orchestratorDeliveries[id] = { status: 'sending', at: Date.now(), receipts }
          await this.state.save()
        }
      }
      this.state.value.orchestratorDeliveries[id] = { status: unknown ? 'unknown' : receipts.length ? 'sent' : 'cancelled', at: Date.now(), receipts, ...(imageFailures ? { imageFailures } : {}) }
      await this.state.save()
    })
    const settled = operation.finally(() => binding.replyContexts?.delete(id))
    this.deliveries.set(session.id, settled)
    void settled.catch(() => { this.deliveryError = true })
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
      if (binding.key !== key || (message.chatType !== 'group' && binding.senderId !== message.senderId)) continue
      if (message.chatType === 'group') {
        const contexts = [...binding.turnContexts ?? [], ...binding.replyContexts?.values() ?? [], ...binding.claimedContexts?.values() ?? []].flat().concat([...this.inputs.values()]).filter(c => c?.key === key && c.senderId === message.senderId)
        for (const context of contexts) context.controller.abort(failure('CANCELLED'))
        for (const pending of [...binding.agent.inbox.nextTurn, ...binding.agent.inbox.nextStep]) {
          const source = this.inputs.get(pending.id) ?? this.orchestrator.contextForChild(binding.agent, pending.source.senderSessionId)
          if (source?.key === key && source.senderId === message.senderId) {
            binding.agent.inbox.remove(pending.id)
            this.inputs.delete(pending.id)
            cancelled = true
          }
        }
        const current = binding.claimedContexts?.size ? [...binding.claimedContexts.values()].filter(Boolean) : binding.currentContexts ?? []
        if (current.length && current.every(c => c.senderId === message.senderId) && binding.agent.status === 'running') {
          binding.agent.cancel({ kind: 'hook', reason: 'Feishu requester cancelled own group turn' }, { keepInbox: true })
          // Wake preserved input after the aborted driver retires, without
          // cloning it or changing its attested native message identity.
          const wake = binding.agent.inbox.nextTurn.at(-1) ?? binding.agent.inbox.nextStep.at(-1)
          if (wake) { binding.agent.inbox.remove(wake.id); binding.agent.send(wake, 'next-turn', true) }
          cancelled = true
        }
        const result = await this.orchestrator.cancelForSender(binding.agent, message.senderId)
        cancelled ||= contexts.length > 0 || result.stopped.length > 0
        continue
      }
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
    if (message.chatType !== 'group' || running?.agent.status !== 'running') this.running.delete(key)
    return cancelled
  }
  async reset(message, ticket) {
    const key = conversationKey(message)
    try {
      const handle = await this.get(key)
      const { agent } = handle
      if (message.chatType === 'group' && this.otherSenderActive(message)) throw failure('OTHER_SENDER_ACTIVE')
      if (ticket?.cancelled) throw failure('CANCELLED')
      const binding = this.bindings.get(agent.id)
      await binding?.stopping
      if (message.chatType === 'group' && this.otherSenderActive(message)) throw failure('OTHER_SENDER_ACTIVE')
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
      for (const [id, context] of this.inputs) if (context.agent === agent) {
        context.controller.abort(failure('CANCELLED'))
        this.inputs.delete(id)
      }
      delete this.state.value.orchestratorInputs[agent.id]
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
    const binding = [...this.bindings.values()].find(b => b.key === conversationKey(message) && (message.chatType === 'group' || b.senderId === message.senderId))
    if (!binding) return '本聊天：尚无编排会话。'
    const role = this.orchestrator.roleOf(binding.agent)
    const tasks = role.suspended ? [] : await this.orchestrator.list(binding.agent)
    const unknown = Object.entries(this.state.value.orchestratorDeliveries).filter(([id, receipt]) => id.startsWith(`${binding.agent.id}:`) && ['sending', 'unknown'].includes(receipt.status)).length
    return `主会话：${role.suspended ? '已停止，等待新消息' : binding.agent.status}\n子任务（执行状态不代表业务完成）：${tasks.slice(-6).map(t => `${t.label} ${t.status}${message.chatType === 'group' ? `（发起人 ${t.senderId}）` : ''}`).join('；') || '无'}\n发送结果待核实：${unknown}${this.deliveryError ? '\n有回复持久化失败，请检查本机日志。' : ''}`
  }
  otherSenderActive(message) {
    if (message.chatType !== 'group') return super.otherSenderActive(message)
    const key = conversationKey(message)
    const started = this.started.get(key)
    if (started && started.senderId !== message.senderId && !started.cancelled) return true
    if ([...this.waiting.get(key) ?? []].some(t => t.senderId !== message.senderId && !t.cancelled)) return true
    if ([...this.inputs.values()].some(c => c.key === key && c.senderId !== message.senderId && !c.controller.signal.aborted)) return true
    const binding = [...this.bindings.values()].find(b => b.key === key)
    return !!binding && (this.orchestrator.hasOtherActive(binding.agent, message.senderId)
      || [...binding.replyContexts?.values() ?? []].flat().some(c => c.senderId !== message.senderId && !c.controller.signal.aborted)
      || [...binding.claimedContexts?.values() ?? []].some(c => c && c.senderId !== message.senderId && !c.controller.signal.aborted)
      || binding.agent.status === 'running' && (binding.currentContexts ?? []).some(c => c.senderId !== message.senderId && !c.controller.signal.aborted))
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
    this.inputs.clear()
    if (failures.length) throw new AggregateError(failures, '编排停机清理失败；所有会话已撤权，请核实停止结果。')
  }
}
