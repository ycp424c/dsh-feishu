import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { execution, dshSchema, validate, localMedia } from './shim.mjs'
import { registerFeishuDocTools, registerFeishuWikiTools, registerFeishuBitableTools } from './vendor/tools.mjs'
import { registerFeishuChatTools, registerFeishuDriveTools } from './vendor/drive.mjs'
import { minutesTool } from './minutes.mjs'

export { digest } from '../digest.mjs'
import { digest } from '../digest.mjs'
const mediaHash = buffer => createHash('sha256').update(buffer).digest('hex')
export const readActions = new Set(['read', 'list_blocks', 'get_block', 'spaces', 'nodes', 'get', 'search', 'list', 'list_comments', 'list_comment_replies', 'batch_query_comments', 'info', 'members', 'member_info'])
export function isWrite(name, args) {
  if (name.startsWith('feishu_bitable_')) return /_(create|update)_/.test(name)
  if (name === 'feishu_app_scopes') return false
  return !readActions.has(args.action)
}

export function toolCatalog() {
  const tools = []
  const api = { config: { channels: { feishu: {} } }, logger: { debug() {}, warn() {} }, registerTool(factory) { tools.push(factory) } }
  for (const register of [registerFeishuDocTools, registerFeishuWikiTools, registerFeishuDriveTools, registerFeishuChatTools, registerFeishuBitableTools]) register(api)
  tools.push({ name: 'feishu_discussion', description: '以 Bot 身份创建飞书讨论群，并加入可信当前发起人和经确认的其他成员。', parameters: { type: 'object', properties: { name: { type: 'string' }, members: { type: 'array', items: { type: 'string' } } }, required: ['name', 'members'] }, async execute(_, args) {
    const { client, turn } = execution.getStore()
    if (!turn?.senderId?.startsWith('ou_') || !args.name.trim() || args.name.length > 60 || args.members.some(id => !/^ou_[A-Za-z0-9_-]+$/.test(id))) throw new Error('Invalid discussion request')
    const res = await client.im.chat.create({ params: { user_id_type: 'open_id' }, data: { name: args.name, chat_type: 'private', user_id_list: [...new Set([turn.senderId, ...args.members])] } })
    if (res.code !== 0 || !res.data?.chat_id) throw new Error('Chat creation failed')
    return { details: { chat_id: res.data.chat_id, name: res.data.name } }
  } })
  tools.push({ name: 'message', description: '按明确请求发送飞书业务通知或截图/文件；须经发起人确认。文本用 message，附件用 media 本地路径，每次选一种。附件只可来自工作区或当前会话。一般最终回复由通道自动投递，不重复发送。', parameters: { type: 'object', properties: { action: { type: 'string', const: 'send' }, channel: { type: 'string', const: 'feishu' }, target: { type: 'string' }, message: { type: 'string' }, media: { type: 'string' } }, required: ['action', 'target'] }, async execute(_, args) {
    const { client, config, mediaDigest } = execution.getStore()
    if (!/^(?:oc_|ou_)[A-Za-z0-9_-]+$/.test(args.target)) throw new Error('Invalid Feishu target')
    if (!!args.media === !!args.message?.trim()) throw new Error('Select one non-empty text or media payload')
    let msg_type='post',content=JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: args.message }]] } })
    if (args.media) {
      const path=resolve(config.workspace,args.media),{buffer}=await localMedia(path,{maxBytes:50*1024*1024,localRoots:[config.workspace]})
      if (!mediaDigest || mediaHash(buffer)!==mediaDigest) throw new Error('Attachment changed after confirmation')
      const image=(buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || buffer[0]===255 && buffer[1]===216 || buffer.subarray(0,3).toString()==='GIF' || buffer.subarray(0,4).toString()==='RIFF' && buffer.subarray(8,12).toString()==='WEBP') && buffer.length<=10*1024*1024
      const uploaded=image?await client.im.image.create({data:{image_type:'message',image:buffer}}):await client.im.file.create({data:{file_type:'stream',file_name:basename(path),file:buffer}})
      const key=image?(uploaded?.image_key??uploaded?.data?.image_key):(uploaded?.file_key??uploaded?.data?.file_key)
      if (!key) throw new Error('Attachment upload failed')
      msg_type=image?'image':'file';content=JSON.stringify(image?{image_key:key}:{file_key:key})
    }
    const res = await client.im.message.create({ params: { receive_id_type: args.target.startsWith('oc_') ? 'chat_id' : 'open_id' }, data: { receive_id: args.target, msg_type, content } })
    if (res.code !== 0 || !res.data?.message_id) throw new Error('Message send failed')
    return { details: { message_id: res.data.message_id, target: args.target } }
  } })
  tools.push(minutesTool)
  return tools
}

export class FeishuTools {
  #grants = new WeakMap()
  constructor({ client, runningForAgent, approvals, config, audit = async () => {}, catalog = toolCatalog(), handlers = {}, policies = [] }) {
    Object.assign(this, { client, runningForAgent, approvals, config, audit })
    const groups = config.toolGroups
    const group = name => name.startsWith('feishu_bitable_') ? 'bitable' : ({ feishu_doc: 'doc', feishu_wiki: 'wiki', feishu_drive: 'drive', feishu_chat: 'chat', feishu_discussion: 'chat', feishu_app_scopes: 'scopes', feishu_minutes: 'minutes', message: 'message' }[name])
    if (groups && (!Array.isArray(groups) || groups.some(x => !['doc','wiki','drive','chat','bitable','scopes','minutes','message'].includes(x)))) throw new Error('Invalid Feishu tool groups')
    this.factories = catalog.filter(factory => { const tool = typeof factory === 'function' ? factory({}) : factory; return !groups || !group(tool.name) || groups.includes(group(tool.name)) })
    this.handlers = Object.assign(Object.create(null), handlers); this.policies = [...policies]
    this.ledger = {}; this.tail = Promise.resolve()
  }
  registerTool(factory, handler, { before } = {}) {
    const name = (typeof factory === 'function' ? factory({}) : factory).name
    if (!name || this.make(name) || Object.hasOwn(this.handlers, name)) throw new Error('Duplicate business tool')
    const index = this.factories.findIndex(f => (typeof f === 'function' ? f({}) : f).name === before)
    this.factories.splice(index < 0 ? this.factories.length : index, 0, factory)
    if (handler) this.handlers[name] = handler
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.factories.indexOf(factory)
      if (index >= 0) this.factories.splice(index, 1)
      delete this.handlers[name]
    }
  }
  registerPolicy(policy) {
    if (this.policies.includes(policy)) throw new Error('Duplicate write policy')
    this.policies.push(policy)
    let active = true
    return () => { if (!active) return; active = false; const index = this.policies.indexOf(policy); if (index >= 0) this.policies.splice(index, 1) }
  }
  get store() {
    const owner = this
    return Object.freeze({ get value() { return owner.ledger }, save: () => owner.save() })
  }
  async withApprovedWorkflow(request, run) {
    const approval = await this.approveWorkflow(request)
    if (approval.decision !== 'allowed-once') throw new Error(`Business confirmation ${approval.decision}`)
    try { return await run(approval) } finally { approval.dispose() }
  }
  async load() {
    this.path = join(this.config.stateDir, 'business-operations.json')
    try { this.ledger = JSON.parse(await readFile(this.path, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    // A process crash after dispatch cannot establish whether a write happened.
    for (const value of Object.values(this.ledger)) if (value.status === 'started') value.status = 'unknown'
  }
  async save() {
    this.tail = this.tail.catch(() => {}).then(async () => {
      await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', JSON.stringify(this.ledger), { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
    }); await this.tail
  }
  definitions() {
    return this.factories.map(factory => {
      const tool = typeof factory === 'function' ? factory({ fsPolicy: { workspaceOnly: true }, workspaceDir: this.config.workspace }) : factory
      return { name: tool.name, description: `${tool.description} 写操作会发送业务确认卡片；成功后回读。`, parameters: dshSchema(tool.parameters), output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: (args, exec) => this.execute(tool.name, args, exec) }
    })
  }
  make(name, turn) {
    const context = { agentAccountId: 'default', messageChannel: turn?.senderId?.startsWith('ou_') ? 'feishu' : undefined, requesterSenderId: turn?.senderId, fsPolicy: { workspaceOnly: true }, workspaceDir: this.config.workspace }
    return this.factories.map(f => typeof f === 'function' ? f(context) : f).find(t => t.name === name)
  }
  async invoke(name, args, turn, signal, mediaDigest, mediaHashes) {
    const tool = this.make(name, turn)
    if (!tool) throw new Error('Unknown business tool')
    validate(tool.parameters, args)
    const client = this.client()
    if (!client) throw new Error('Feishu business client unavailable')
    // SDK calls are not abandoned after cancellation: let an in-flight write
    // settle, and check cancellation before every subsequent request.
    const wrap = (obj, owner) => typeof obj === 'function' ? (...params) => { signal?.throwIfAborted(); return obj.apply(owner, params) } : obj && typeof obj === 'object' ? new Proxy(obj, { get: (o, k) => wrap(o[k], o) }) : obj
    const result = await execution.run({ client: wrap(client), turn, signal, config:this.config, mediaDigest, mediaHashes }, () => tool.execute('feishu', args))
    const value = JSON.parse(JSON.stringify(result.details ?? result))
    if (value.error) throw Object.assign(new Error(value.error), { businessError: value.error })
    return value
  }
  checkTarget(name, args, turn) {
    if (this.config.environment !== 'test') return
    const resources = this.config.testResources ?? {}
    if (name === 'feishu_discussion' && args.members.every(id => this.config.dmAllowlist.includes(id))) return
    if (name === 'message' && (args.target === turn.message.chatId || this.config.dmAllowlist.includes(args.target) || (resources.chatTokens ?? []).includes(args.target))) return
    if (name === 'feishu_doc' && args.action === 'create' || name === 'feishu_bitable_create_app') {
      if (args.folder_token) throw new Error('Test creation cannot use an arbitrary folder')
      return
    }
    if (name === 'feishu_doc' && args.doc_token && (resources.docTokens ?? []).includes(args.doc_token)) return
    if (name.startsWith('feishu_bitable_') && args.app_token && (resources.appTokens ?? []).includes(args.app_token)) return
    throw new Error('TEST_WRITE_TARGET_DENIED: 只允许独立测试资源')
  }
  async execute(name, args, exec) {
    args = structuredClone(args)
    const turn = this.runningForAgent(exec.agent)
    const handler = this.handlers[name]
    if (handler) return handler(this, args, exec, turn)
    const write = isWrite(name, args)
    if (!write) return this.invoke(name, args, turn, exec.signal)
    if (!turn?.senderId?.startsWith('ou_')) throw new Error('No trusted Feishu requester; write denied')
    for (const policy of this.policies) await policy({ executor: this, name, args, turn, exec })
    this.checkTarget(name, args, turn)
    validate(this.make(name, turn).parameters, args)
    if (name==='message' && !!args.media===!!args.message?.trim()) throw new Error('Select one non-empty text or media payload')
    let mediaDigest
    if (name==='message' && args.media) {
      const {buffer}=await execution.run({turn},()=>localMedia(resolve(this.config.workspace,args.media),{maxBytes:50*1024*1024,localRoots:[this.config.workspace]}))
      mediaDigest=mediaHash(buffer)
    }
    const key = digest([turn.message.messageId, name, args])
    if (this.ledger[key]) return { operation: key, ...this.ledger[key], repeatSuppressed: true, notice: '已执行或状态未知；先回读核对，不自动重复写入。' }
    const authorization = await this.approveWorkflow({ agent: exec.agent, callId: exec.callId, toolName: name, signal: exec.signal, argumentDigest: digest(args), reason: '业务写入确认：请核对目标和完整预览，批准仅适用于本次操作。'+(mediaDigest?' 附件摘要 '+mediaDigest:''), business: true })
    if (authorization.decision !== 'allowed-once') throw new Error(`Business confirmation ${authorization.decision}`)
    try { return await authorization.performWrite(name, args, turn, exec.signal, key, mediaDigest) }
    finally { authorization.dispose() }
  }
  // A grant is an execution-local capability, never a model-visible boolean.
  async approveWorkflow(request) {
    const turn = this.runningForAgent(request.agent)
    if (!turn?.senderId?.startsWith('ou_')) throw new Error('No trusted Feishu requester; write denied')
    const decision = await this.approvals.request(request, async () => 'unavailable')
    if (decision !== 'allowed-once') return { decision, dispose() {} }
    const grant = Object.freeze({})
    this.#grants.set(grant, { turn, request })
    return Object.freeze({
      decision,
      performWrite: (name, args, candidate, signal, key, mediaDigest, mediaHashes, verify) => this.performWrite(name, args, candidate, signal, key, mediaDigest, mediaHashes, verify, grant),
      dispose: () => this.#grants.delete(grant),
    })
  }
  // Only a live approved capability can enter the external step runner.
  async performWrite(name, args, turn, signal, key, mediaDigest, mediaHashes, verify, grant) {
    const authorized = this.#grants.get(grant)
    if (!authorized || authorized.turn !== turn || this.runningForAgent(authorized.request.agent) !== turn) throw new Error('Approved workflow capability required')
    authorized.request.signal?.throwIfAborted()
    turn.controller?.signal.throwIfAborted()
    signal?.throwIfAborted()
    for (const policy of this.policies) await policy({ executor: this, name, args, turn, authorization: { toolName: authorized.request.toolName }, exec: { agent: authorized.request.agent, signal } })
    this.checkTarget(name, args, turn)
    validate(this.make(name, turn).parameters, args)
    if (this.ledger[key]) return { operation: key, ...this.ledger[key], repeatSuppressed: true }
    this.ledger[key] = { status: 'started', tool: name, at: new Date().toISOString(), argumentDigest: digest(args) }
    await this.save()
    try {
      const result = await this.invoke(name, args, turn, signal, mediaDigest, mediaHashes)
      // Persist the receipt before verification: failed readback must never lead
      // the model to retry a successful external write.
      this.ledger[key] = { ...this.ledger[key], status: 'written', result }
      await this.save()
      await this.rememberCreated(name, args, result)
      const readback = verify ? await verify(result) : await this.readback(name, args, result, turn, signal)
      if (!readback?.verified) throw new Error('Write readback unavailable')
      this.ledger[key] = { ...this.ledger[key], status: 'verified', readback }
      await this.save(); await this.audit('business.verified', { operation: key, tool: name })
      return { operation: key, ...result, readback }
    } catch (error) {
      this.ledger[key].status = this.ledger[key].status === 'written' ? 'written-unverified' : 'unknown'
      await this.save(); await this.audit('business.unverified', { operation: key, tool: name, status: this.ledger[key].status })
      return { operation: key, status: this.ledger[key].status, result: this.ledger[key].result ?? null, error: '写入或回读未确认；先核对目标，禁止自动重试。' }
    }
  }
  async rememberCreated(name, args, result) {
    if (this.config.environment !== 'test') return
    const resources = this.config.testResources
    if (name === 'feishu_doc' && args.action === 'create' && result.document_id) resources.docTokens.push(result.document_id)
    if (name === 'feishu_bitable_create_app' && result.app_token) resources.appTokens.push(result.app_token)
    if (name === 'feishu_discussion' && result.chat_id) (resources.chatTokens ??= []).push(result.chat_id)
    await writeFile(join(this.config.stateDir, 'test-resources.json'), JSON.stringify(resources, null, 2) + '\n', { mode: 0o600 })
  }
  async readback(name, args, result, turn, signal) {
    let value
    if (name === 'feishu_doc') value = await this.invoke(name, { action: 'read', doc_token: result.document_id ?? args.doc_token }, turn, signal)
    else if (name === 'feishu_bitable_create_record' || name === 'feishu_bitable_update_record') value = await this.invoke('feishu_bitable_get_record', { app_token: args.app_token, table_id: args.table_id, record_id: result.record?.record_id ?? args.record_id }, turn, signal)
    else if (name === 'feishu_bitable_create_field') value = await this.invoke('feishu_bitable_list_fields', { app_token: args.app_token, table_id: args.table_id }, turn, signal)
    else if (name === 'feishu_bitable_create_app') value = await this.invoke('feishu_bitable_get_meta', { url: result.url }, turn, signal)
    else if (name === 'feishu_discussion') value = await this.invoke('feishu_chat', { action: 'info', chat_id: result.chat_id }, turn, signal)
    else if (name === 'message') {
      signal?.throwIfAborted()
      const res = await this.client().im.message.get({ path: { message_id: result.message_id } })
      if (res.code !== 0 || !res.data?.items?.some(item => item.message_id === result.message_id)) throw new Error('Message readback failed')
      value = { message_id: result.message_id, found: true }
    }
    else if (name === 'feishu_wiki') value = await this.invoke(name, { action: 'get', token: result.node_token ?? args.node_token }, turn, signal)
    // Listing a folder alone cannot prove a delete/move/comment succeeded.
    // Preserve the receipt for manual checking rather than mark it verified.
    else if (name === 'feishu_drive') throw new Error('Drive effect needs manual verification')
    else throw new Error('This write requires manual readback; receipt retained')
    return { verified: true, value }
  }
}
