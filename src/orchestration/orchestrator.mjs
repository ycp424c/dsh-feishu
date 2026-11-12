import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { markAdjacentAgentSendMessageTool } from '@deepseek-ai/dsh-subagent/internal'
import { denial, mainTools, permitsTool } from './policy.mjs'

const persona = role => readFileSync(new URL(`./personas/${role}.md`, import.meta.url), 'utf8')
const frontdesk = persona('frontdesk'), worker = persona('worker')
const text = value => ({ type: 'text', text: value })
const idParameter = { type: 'string', required: true, description: '本主会话创建的子代理 ID；子代理发问时为 parent_id。' }
const attachmentParameter = { type: 'array', items: { type: 'string' }, description: '从当前运行上下文选择的 attachment_id；省略表示不传附件。' }
const requestParameter = { type: 'string', description: '群聊当前步骤中的可信 request_id；多人请求并行时必须明确选择。' }
const error = message => { throw new Error(message) }
export const originOf = context => context && ({ senderId: context.senderId, key: context.key, message: Object.fromEntries(['chatType', 'chatId', 'senderId', 'messageId', 'threadId', 'rootId', 'conversationId'].filter(key => context.message[key] !== undefined).map(key => [key, context.message[key]])) })

export function createOrchestrator(ctx, config = {}) {
  const roles = new WeakMap(), roots = new Set(), tasks = new Map()
  const frontdeskPreset = config.frontdeskPreset ?? 'orchestrator-frontdesk'
  const workerPreset = config.workerPreset ?? 'orchestrator-worker'
  const maxActive = config.maxActive ?? 2
  const maxRelay = config.maxRelay ?? 16
  for (const value of [maxActive, maxRelay]) if (!Number.isSafeInteger(value) || value < 1) error('编排并发数和消息上限必须为正整数。')
  let closing = false

  function roleOf(agent) { return roles.get(agent) }
  function requireRole(agent, kind) {
    const role = roles.get(agent)
    if (!role || ctx.agents.get(agent.id) !== agent || (kind && role.kind !== kind) || role.revoked || role.root.revoked || role.root.suspended || closing) error('当前代理没有此操作权限。')
    return role
  }
  function attachments(root) {
    const found = new Map()
    const events = [...root.agent.session.snapshotEvents()]
    if (root.sharedGroup) for (const context of root.executionContexts ?? []) if (context.nativeMessage) events.push({ type: 'user/message', data: context.nativeMessage })
    for (const event of events) {
      if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue
      for (const [index, block] of (event.data.content ?? []).entries()) {
        if (!block.attachment) continue
        const path = root.attachmentPath(block.attachment)
        if (path && root.allowedFiles.has(path)) found.set(`att-${root.sharedGroup ? event.data.id : event.seq}-${index}`, { block, path })
      }
    }
    return found
  }
  function selectAttachments(role, ids = []) {
    if (!Array.isArray(ids) || ids.length > 16) error('每次最多交接 16 个附件。')
    const available = attachments(role.root)
    return [...new Set(ids)].map(id => {
      const item = available.get(id)
      if (!item || (role.kind === 'worker' && !role.allowedFiles.has(item.path))) error('附件不属于本次任务。')
      return item
    })
  }
  function install(agent, role) {
    roles.set(agent, role)
    // Frontdesk stays small. Workers see installed execution capabilities,
    // including tools added later; a snapshot allowlist would hide those again.
    if (role.kind === 'frontdesk') agent.ctx.tools.restrict({ allow: agent.ctx.tools.schemas(scopeOf(agent.ctx)).map(tool => tool.name).filter(name => mainTools.includes(name) && !name.startsWith('orchestrator_')) })
    agent.ctx.tools.guard(exec => denial(ctx, role, exec))
    agent.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      result.tools = result.tools.filter(tool => permitsTool(role, tool.name))
      return result
    })
    agent.ctx.systemPrompt.section({ name: 'orchestrator-role', order: 10000, text: role.kind === 'frontdesk' ? frontdesk : worker })
    agent.ctx.systemPrompt.context({ name: 'orchestrator-task-context', order: 10000, required: true, text: () => {
      const refs = [...attachments(role.root)].filter(([, item]) => role.kind === 'frontdesk' || role.allowedFiles.has(item.path)).map(([id]) => id)
      const contexts = role.kind === 'frontdesk' ? role.root.executionContexts ?? [] : [role.inputContext].filter(Boolean)
      const requests = role.root.sharedGroup ? `\n本步骤可信请求=${JSON.stringify(contexts.filter(c => !c.controller.signal.aborted).map(c => ({ request_id: c.message.messageId, sender_id: c.senderId })))}\n群话题共享上下文；工具须选择实际请求者，不能将他人的任务转给当前发言人。` : ''
      return `Orchestration role=${role.kind}\nparent_id=${role.kind === 'worker' ? role.root.agent.id : '(none)'}\n可用 attachment_id=${JSON.stringify(refs)}${requests}${role.kind === 'frontdesk' ? '\n执行方式：orchestrator_delegate → 执行子代理（独立工具目录，使用宿主已加载的执行能力）。主会话没有执行工具不是缺权限；执行请求先委派，再简短告知已开始，不等待子任务完成。' : ''}`
    } })
    for (const definition of definitions(role.kind)) agent.ctx.tools.register(definition)
  }
  function bindRoot(agent, { workspace, attachmentPath, allowedFiles = [], taskRecords = [], saveTask }) {
    if (closing || ctx.agents.get(agent.id) !== agent || agent.session.header?.parentSession || ctx.agentPresets.composedPreset(agent.ctx) !== frontdeskPreset) error('需要绑定本运行时的 orchestrator-frontdesk 根会话。')
    const existing = roles.get(agent)
    if (existing) return existing
    if (typeof saveTask !== 'function') error('缺少编排任务元数据持久化接口。')
    const root = { kind: 'frontdesk', agent, workspace, attachmentPath, saveTask, allowedFiles: new Set(allowedFiles), revoked: false, epoch: 0 }
    root.root = root
    roots.add(root)
    for (const record of taskRecords) {
      if (typeof record.childId !== 'string' || typeof record.label !== 'string' || !Array.isArray(record.allowedFiles) || record.allowedFiles.some(path => typeof path !== 'string')) error('编排任务元数据无效。')
      const inputContext = record.origin && { ...record.origin, allowedFiles: record.allowedFiles, controller: new AbortController() }
      root.sharedGroup ||= inputContext?.message.chatType === 'group'
      tasks.set(record.childId, { ...record, root, inputContext, starting: false, relay: 0, controller: new AbortController(), ...(record.revoked ? { stopRecorded: true, stopPersisted: true } : {}) })
    }
    install(agent, root)
    return root
  }
  function acceptInput(agent, allowedFiles, inputContext) {
    const current = roles.get(agent)
    if (current?.kind === 'frontdesk') current.suspended = false
    const root = requireRole(agent, 'frontdesk')
    for (const path of allowedFiles) root.allowedFiles.add(path)
    root.inputContext = inputContext
    root.sharedGroup ||= inputContext?.message.chatType === 'group'
    root.epoch++
  }
  function setExecutionContexts(agent, contexts) {
    const root = roles.get(agent)
    if (!root || root.kind !== 'frontdesk') return
    root.executionContexts = [...new Map(contexts.map(c => [JSON.stringify([c.senderId, c.message.messageId]), c])).values()]
    for (const context of root.executionContexts) for (const path of context.allowedFiles ?? []) root.allowedFiles.add(path)
    root.inputContext = root.executionContexts.length === 1 ? root.executionContexts[0] : undefined
  }
  function contextForChild(agent, childId) {
    const root = roles.get(agent), task = tasks.get(childId)
    return root && task?.root === root && !task.revoked ? task.inputContext ?? (root.sharedGroup ? undefined : root.inputContext) : undefined
  }
  function requester(root, requestId, task) {
    if (!root.sharedGroup) return root.inputContext
    let contexts = (root.executionContexts ?? []).filter(c => !c.controller.signal.aborted)
    if (requestId) contexts = contexts.filter(c => c.message.messageId === requestId)
    if (task) contexts = contexts.filter(c => c.senderId === task.origin?.senderId)
    if (contexts.length !== 1) error('请从本步骤可信请求中选择明确的 request_id；只能控制该发起人的任务。')
    return contexts[0]
  }
  function childCreated({ agent }) {
    const task = tasks.get(agent.id)
    if (!task) {
      if ([frontdeskPreset, workerPreset].includes(ctx.agentPresets.composedPreset(agent.ctx))) {
        agent.ctx.tools.guard(exec => roles.has(exec.agent) ? undefined : '此编排预设尚未绑定可信通道或父任务。')
      }
      return
    }
    if (agent.session.header?.parentSession !== task.root.agent.id || !ctx.agents.isOwnedBy(agent.id, task.root.agent)) error('子代理归属校验失败。')
    const role = { kind: 'worker', root: task.root, workspace: task.root.workspace, allowedFiles: new Set(task.allowedFiles), controller: task.controller, get inputContext() { return task.inputContext ?? task.root.inputContext }, get revoked() { return task.revoked } }
    install(agent, role)
  }
  const unlistenCreated = ctx.on('agent/created', childCreated)
  const unlistenDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const role = roles.get(agent)
    if (role?.kind === 'frontdesk') {
      roots.delete(role)
      for (const [id, task] of tasks) if (task.root === role) tasks.delete(id)
    }
    roles.delete(agent)
  })
  const activeCount = root => [...tasks.values()].filter(t => t.root === root && !t.revoked && (t.starting || t.resuming || ctx.agents.get(t.childId)?.status === 'running')).length

  async function delegate(agent, args, signal) {
    const root = requireRole(agent, 'frontdesk')
    const inputContext = requester(root, args.request_id)
    if (typeof args.task !== 'string' || !args.task.trim() || typeof args.label !== 'string' || !args.label.trim()) error('需要完整任务与简短名称。')
    if (activeCount(root) >= maxActive) error(`同时最多执行 ${maxActive} 个子任务，请先处理已有任务。`)
    const selected = selectAttachments(root, args.attachments)
    const childId = `orchestrator-worker-${randomUUID()}`
    const record = { childId, label: args.label, allowedFiles: selected.map(a => a.path), origin: originOf(inputContext) }
    const ready = Promise.withResolvers()
    const task = { ...record, root, inputContext, starting: true, startingDone: ready.promise, relay: 0, controller: new AbortController() }
    tasks.set(childId, task)
    try {
      await root.saveTask('created', record)
      await ctx.sessions.flush(root.agent.session)
      requireRole(agent, 'frontdesk')
      if (task.revoked) error('任务已取消。')
      const activation = await ctx.subagents.startActivation({
        childId, provider: 'spawn', label: args.label, delivery: 'parent', signal: AbortSignal.any([signal, task.controller.signal]),
        request: { parent: agent, agentPreset: workerPreset, cwd: root.workspace, maxDepth: 1,
          prompt: [text(args.task), ...selected.map(a => structuredClone(a.block))] },
      })
      // Native parent delivery owns the outcome. Observe rejection without a second delivery.
      void activation.result.catch(() => {})
      if (task.revoked) { await activation.dispose(); error('任务已取消。') }
      return { childId: activation.childId, status: 'accepted' }
    } catch (cause) {
      task.revoked = true
      await root.saveTask('cancelled', { childId, reason: 'start-failed' })
      throw cause
    } finally { task.starting = false; ready.resolve() }
  }
  async function message(agent, args, signal) {
    const role = requireRole(agent)
    const task = tasks.get(role.kind === 'worker' ? agent.id : args.agent_id)
    if (!task || task.root !== role.root || task.revoked || (role.kind === 'worker' && args.agent_id !== role.root.agent.id)) error('只能与本任务的直接父子代理通信。')
    if (typeof args.message !== 'string' || !args.message.trim()) error('消息不能为空。')
    const inputContext = role.kind === 'frontdesk' ? requester(role.root, args.request_id, task) : undefined
    if (task.epoch !== role.root.epoch) { task.epoch = role.root.epoch; task.relay = 0 }
    if (task.relay >= maxRelay) error('内部沟通次数已达本轮上限，请等待用户补充或汇报阻塞。')
    const selected = selectAttachments(role, args.attachments)
    const resume = role.kind === 'frontdesk' && ctx.agents.get(task.childId)?.status !== 'running'
    if (resume && !task.resuming && activeCount(role.root) >= maxActive) error(`同时最多执行 ${maxActive} 个子任务。`)
    if (resume) task.resuming = (task.resuming ?? 0) + 1
    task.relay++
    const sending = (async () => {
      if (role.kind === 'frontdesk') {
        task.inputContext = inputContext
        task.origin = originOf(inputContext)
        for (const item of selected) {
          if (!task.allowedFiles.includes(item.path)) task.allowedFiles.push(item.path)
          roles.get(ctx.agents.get(task.childId))?.allowedFiles.add(item.path)
        }
        // Persist the updated grant before a cold resume can materialize the child.
        await role.root.saveTask('created', { childId: task.childId, label: task.label, allowedFiles: task.allowedFiles, origin: task.origin })
        await ctx.sessions.flush(role.agent.session)
      }
      requireRole(agent)
      if (task.revoked) error('任务已取消。')
      return { messageId: await ctx.subagents.sendMessage(agent, args.agent_id, [text(args.message), ...selected.map(a => structuredClone(a.block))], { signal: AbortSignal.any([signal, task.controller.signal]) }) }
    })()
    task.pendingMessages ??= new Set()
    task.pendingMessages.add(sending)
    try { return await sending }
    finally { task.pendingMessages.delete(sending); if (resume) task.resuming-- }
  }
  async function cancel(agent, childId, requestId) {
    const root = requireRole(agent, 'frontdesk')
    const task = childId && tasks.get(childId)
    const source = requester(root, requestId, task)
    return stopTasks(root, childId, root.sharedGroup ? source.senderId : undefined)
  }
  async function stopTasks(root, childId, senderId) {
    const agent = root.agent
    if (childId && tasks.get(childId)?.root !== root) error('该任务不属于当前主会话。')
    if (childId && senderId && tasks.get(childId)?.origin?.senderId !== senderId) error('只能取消自己发起的任务。')
    const selected = [...tasks.values()].filter(t => t.root === root && (!senderId || t.origin?.senderId === senderId) && (!t.stopped || !t.stopPersisted) && (childId === undefined || t.childId === childId))
    const failures = []
    for (const task of selected) {
      task.revoked = true // Revoke before await; admission cannot race the stop request.
      task.controller.abort()
    }
    for (const task of selected) {
      if (task.stopRecorded) continue
      try {
        await root.saveTask('cancelled', { childId: task.childId, label: task.label, allowedFiles: task.allowedFiles, reason: 'cancelled' })
        task.stopRecorded = true
      } catch (cause) { failures.push(cause) }
    }
    try {
      await ctx.sessions.flush(agent.session)
      for (const task of selected) task.stopPersisted = task.stopRecorded === true
    } catch (cause) { failures.push(cause) }
    await Promise.all(selected.filter(t => t.starting).map(t => t.startingDone))
    await Promise.allSettled(selected.flatMap(t => [...t.pendingMessages ?? []]))
    // Persistence failure must not leave an executing child behind. Revocation,
    // durable cancellation and confirmed native teardown are separate facts.
    try {
      await ctx.subagents.drainChildren(agent, selected.filter(t => !t.stopped).map(t => t.childId))
      for (const task of selected) task.stopped = true
    } catch (cause) { failures.push(cause) }
    if (failures.length) throw new AggregateError(failures, '任务停止或取消记录保存失败，请重试并核实。')
    return { stopped: selected.map(t => t.childId), priorEffects: '已完成的操作不会自动撤销。' }
  }
  async function list(agent) {
    const root = requireRole(agent, 'frontdesk')
    const catalog = await ctx.subagents.listChildren(agent.id)
    return catalog.filter(row => tasks.get(row.id)?.root === root).map(row => ({
      childId: row.id, label: row.label,
      senderId: tasks.get(row.id).origin?.senderId,
      status: tasks.get(row.id).revoked ? (tasks.get(row.id).stopped ? 'cancelled' : 'stop-unconfirmed') : ctx.agents.get(row.id)?.status ?? 'not-resident',
      businessCompletion: '请核对执行报告和工具证据。',
    }))
  }
  function tool(name, description, parameters, execute) {
    return defineTool({ name, description, parameters, output: { schema: { type: 'string' }, render: (_, value) => [text(value)] },
      async execute(args, exec) { return JSON.stringify(await execute(exec.agent, args, exec.signal)) } })
  }
  function definitions(kind) {
    const relay = markAdjacentAgentSendMessageTool(tool('send_message', '向直接父子代理补充要求或提问，返回接收凭据，不等待答复。', { agent_id: idParameter, message: { type: 'string', required: true }, attachments: attachmentParameter, request_id: requestParameter }, message))
    if (kind === 'worker') return [relay]
    return [relay,
      tool('orchestrator_delegate', '将联网检索、找图下载、Shell、文件操作等执行任务交给独立上下文的原生子代理；子代理使用自己的完整执行工具目录。返回 accepted 后简短告知用户已开始，结束当前轮，不等待任务完成。', { label: { type: 'string', required: true }, task: { type: 'string', required: true }, attachments: attachmentParameter, request_id: requestParameter }, delegate),
      tool('orchestrator_tasks', '读取本会话子代理原生状态；空闲不代表业务完成。', {}, agent => list(agent)),
      tool('orchestrator_cancel', '撤销当前请求者子任务的工具权限并等待其停止。省略 ID 则停止该发起人的全部子任务。', { agent_id: { type: 'string', description: idParameter.description }, request_id: requestParameter }, (agent, args) => cancel(agent, args.agent_id, args.request_id)),
    ]
  }
  async function unbindRoot(agent) {
    const root = roles.get(agent)
    if (!root || root.kind !== 'frontdesk' || root.closed) return
    root.revoked = true
    await stopTasks(root)
    roots.delete(root)
    root.closed = true
  }
  async function stopRoot(agent) {
    const root = roles.get(agent)
    if (!root || root.kind !== 'frontdesk' || root.closed) return { stopped: [] }
    root.suspended = true
    agent.cancel({ kind: 'hook', reason: 'Orchestration channel cancellation' })
    return stopTasks(root)
  }
  async function dispose() {
    closing = true
    for (const root of roots) { root.revoked = true; root.agent.cancel({ kind: 'hook', reason: 'Orchestration plugin stopping' }) }
    for (const task of tasks.values()) task.controller.abort()
    await ctx.subagents.drainDescendants([...roots].map(r => r.agent))
    roots.clear()
    tasks.clear()
    unlistenCreated()
    unlistenDisposed()
  }
  function hasOtherActive(agent, senderId) {
    const root = roles.get(agent)
    return [...tasks.values()].some(t => t.root === root && t.origin?.senderId !== senderId && !t.revoked && (t.starting || t.resuming || ctx.agents.get(t.childId)?.status === 'running'))
  }
  async function cancelForSender(agent, senderId) {
    const root = roles.get(agent)
    if (!root || root.kind !== 'frontdesk' || root.closed) return { stopped: [] }
    for (const task of tasks.values()) if (task.root === root && task.origin?.senderId === senderId) task.inputContext?.controller.abort()
    return stopTasks(root, undefined, senderId)
  }
  return { bindRoot, acceptInput, setExecutionContexts, contextForChild, hasOtherActive, cancelForSender, roleOf, delegate, message, cancel, list, stopRoot, unbindRoot, dispose }
}
