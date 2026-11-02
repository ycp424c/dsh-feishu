import { randomUUID, createHash } from 'node:crypto'

export const defaultApprovalTimeoutMs = 5 * 60 * 1000
const maxDetailChars = 3500

function displayDetails(request, turn, presenter, sessionDirectory) {
  if (!request.callId || !request.agent?.session?.snapshotEvents) return null
  const calls = request.agent.session.snapshotEvents(turn.startSeq).filter(event =>
    event.type === 'tool/call' && event.data?.callId === request.callId)
  if (calls.length !== 1) return null
  const call = calls[0]
  if (!call || call.data?.name !== request.toolName) return null
  let args = call.data.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return null }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  if (request.argumentDigest && createHash('sha256').update(JSON.stringify(args)).digest('hex') !== request.argumentDigest) return null
  const presentation = presenter?.(request, args) ?? {}
  const workflow = request.business === true && presentation.workflow === true
  const detail = workflow ? presentation.detail : JSON.stringify(args, null, 2)
  const reason = request.reason ?? '未提供原因'
  const sessionCwd = sessionDirectory?.(request.agent) ?? request.agent.session.header?.cwd
  if (request.toolName === 'bash' && typeof sessionCwd !== 'string') return null
  const workdirNote = request.toolName === 'bash'
    ? args.workdir === undefined
      ? `未指定 workdir；会话目录为 ${sessionCwd}，沙箱根目录可能覆盖默认执行目录。`
      : `会话目录：${sessionCwd}（相对 workdir 依此或沙箱根目录解析）。`
    : undefined
  if (!detail || detail.length > (request.business ? 20000 : maxDetailChars) || reason.length > 1000) return null
  return { detail, reason, workdirNote, business: request.business === true, workflow, previewLabel: presentation.previewLabel ?? '流程预览', approveLabel: presentation.approveLabel ?? '确认并执行' }
}

function card({ toolName, detail, reason, workdirNote, business, workflow, previewLabel, approveLabel, brand, approvalIdKey, id, timeoutMs }, outcome) {
  const title = `${brand} · ${outcome === undefined ? business ? '业务写入确认' : '权限审批' : '审批已结束'}`
  const content = `${workflow ? previewLabel : `工具：${toolName}`}\n原因：${reason}${workdirNote ? `\n工作目录：${workdirNote}` : ''}\n${workflow ? '完整执行内容' : '待执行参数'}：\n${detail}\n\n${outcome === undefined
    ? `此卡片发给任务发起人，${Math.ceil(timeoutMs / 60000)} 分钟内有效。${workflow ? '批准后执行卡片中的完整流程；无需再回复文字确认。' : '批准只适用于这一条操作。'}`
    : `结果：${{ 'allowed-once': '已批准一次', rejected: '已拒绝', cancelled: '已取消', unavailable: '已过期或不可用' }[outcome]}`}`
  return {
    config: { enable_forward: false, update_multi: false },
    header: { title: { tag: 'plain_text', content: title }, template: outcome === undefined ? 'orange' : 'grey' },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content } },
      ...(outcome === undefined ? [{
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: workflow ? approveLabel : '批准本次操作' }, type: 'primary',
            value: { [approvalIdKey]: id, decision: 'allow' },
            ...(workflow ? {} : { confirm: { title: { tag: 'plain_text', content: '确认批准' }, text: { tag: 'plain_text', content: '只批准卡片中展示的这一条操作。' } } }) },
          { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger',
            value: { [approvalIdKey]: id, decision: 'reject' } },
        ],
      }] : []),
    ],
  }
}

export class FeishuApprovals {
  constructor({ runningForAgent, sendCard, updateCard, audit = async () => {}, timeoutMs = defaultApprovalTimeoutMs, brand = 'DSH Feishu Bot', approvalIdKey = 'feishuApprovalId', presenter, sessionDirectory }) {
    this.runningForAgent = runningForAgent
    this.sendCard = sendCard
    this.updateCard = updateCard
    this.audit = audit
    this.timeoutMs = timeoutMs
    Object.assign(this, { brand, approvalIdKey, presenter, sessionDirectory })
    this.presenters = new Map()
    this.pending = new Set()
    this.byMessageId = new Map()
    this.disposed = false
  }

  registerPresenter(toolName, presenter) {
    if (this.presenters.has(toolName)) throw new Error('Duplicate approval presenter')
    this.presenters.set(toolName, presenter)
    let active = true
    return () => { if (active) { active = false; this.presenters.delete(toolName) } }
  }

  request(request, next) {
    const turn = this.runningForAgent(request.agent)
    if (!turn) return next()
    if (this.disposed || request.signal?.aborted || turn.controller.signal.aborted) return Promise.resolve('cancelled')
    const details = displayDetails(request, turn, (req, args) => (this.presenters.get(req.toolName) ?? this.presenter)?.(req, args), this.sessionDirectory)
    if (!details || !turn.senderId?.startsWith('ou_')) {
      void this.audit('approval.unavailable', { reason: 'unpresentable' }).catch(() => {})
      return Promise.resolve('unavailable')
    }
    const id = randomUUID()
    const shown = { toolName: request.toolName, ...details, brand: this.brand, approvalIdKey: this.approvalIdKey, id, timeoutMs: this.timeoutMs }
    const pending = { id, turn, shown, messageId: undefined, settled: false, deadline: Date.now() + this.timeoutMs }
    const result = new Promise(resolve => { pending.resolve = resolve })
    const audit = (event, fields = {}) => { void this.audit(event, { request: id, tool: request.toolName, ...fields }).catch(() => {}) }
    const settle = outcome => {
      if (pending.settled) return
      pending.settled = true
      pending.outcome = outcome
      clearTimeout(pending.timer)
      request.signal?.removeEventListener('abort', onAbort)
      turn.controller.signal.removeEventListener('abort', onAbort)
      turn.approvals?.delete(pending)
      if (turn.approvals?.size === 0) delete turn.approvals
      this.pending.delete(pending)
      if (pending.messageId) {
        this.byMessageId.delete(pending.messageId)
        void Promise.resolve().then(() => this.updateCard(pending.messageId, card(shown, outcome))).catch(() => audit('approval.card_update_failed'))
      }
      audit('approval.decided', { outcome })
      pending.resolve(outcome)
    }
    const onAbort = () => settle('cancelled')
    pending.settle = settle
    if (!turn.approvals) turn.approvals = new Set()
    turn.approvals.add(pending)
    this.pending.add(pending)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    turn.controller.signal.addEventListener('abort', onAbort, { once: true })
    pending.timer = setTimeout(() => settle('unavailable'), this.timeoutMs)
    audit('approval.requested')
    if (request.signal?.aborted || turn.controller.signal.aborted) onAbort()
    if (!pending.settled) {
      void Promise.resolve().then(() => this.sendCard(turn.senderId, card(shown))).then(receipt => {
        if (!receipt?.messageId) { settle('unavailable'); return }
        pending.messageId = receipt.messageId
        if (pending.settled) {
          void Promise.resolve().then(() => this.updateCard(receipt.messageId, card(shown, pending.outcome))).catch(() => audit('approval.card_update_failed'))
        } else {
          this.byMessageId.set(receipt.messageId, pending)
          audit('approval.card_sent')
        }
      }).catch(() => settle('unavailable'))
    }
    return result
  }

  onCardAction(event) {
    const pending = this.byMessageId.get(event.messageId)
    if (!pending || pending.settled || event.action?.tag !== 'button') return false
    const value = event.action.value
    if (!value || value[this.approvalIdKey] !== pending.id || !['allow', 'reject'].includes(value.decision)) return false
    if (event.operator?.openId !== pending.turn.senderId) {
      void this.audit('approval.unauthorized_click', { request: pending.id }).catch(() => {})
      return false
    }
    if (Date.now() >= pending.deadline) {
      pending.settle('unavailable')
      return false
    }
    pending.settle(value.decision === 'allow' ? 'allowed-once' : 'rejected')
    return true
  }

  dispose() {
    this.disposed = true
    for (const pending of [...this.pending]) pending.settle('cancelled')
  }

  get size() { return this.pending.size }
}
