import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import * as base from '../../src/index.mjs'
import { OrchestratedConversations } from '../../src/orchestration/index.mjs'
import { FeishuApprovals } from '../../src/approvals.mjs'
import { FeishuTools } from '../../src/business/index.mjs'
import { installPrivateBoundary } from '../../src/private-boundary.mjs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { host, text, call, until, llm } from './harness.mjs'

test('built-in main and worker presets preserve the host skill directory policy', { timeout: 15000 }, async () => {
  const approved = await mkdtemp(join(tmpdir(), 'feishu-approved-skills-'))
  const hold = Promise.withResolvers()
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) await hold.promise
    return text('ready')
  }, { skillFilesystem: { includeDefaultRoots: false, customSkillDirs: [approved], watch: false } })
  try {
    for (const [directory, name] of [[approved, 'approved-only'], [join(app.workspace, '.agents/skills'), 'unapproved-local']]) {
      const folder = join(directory, name); await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic scope regression.\n---\nSynthetic body.\n`)
    }
    await app.input('开始')
    const parent = await app.parent(); await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '技能范围', task: '等待检查。' }, new AbortController().signal)
    await until(() => app.ctx.agents.get(childId)?.status === 'running', 'worker starts')
    for (const agent of [parent, app.ctx.agents.get(childId)]) {
      const skills = await app.ctx.skills.list({ cwd: app.workspace, scope: scopeOf(agent.ctx) })
      assert.deepEqual(skills.map(skill => skill.name), ['approved-only'])
    }
  } finally { hold.resolve(); await app.dispose(); await rm(approved, { recursive: true, force: true }) }
})

for (const custom of [false, true]) test(`base entry enables native orchestration without consumer plugins (${custom ? 'custom' : 'built-in'} presets)`, { timeout: 15000 }, async () => {
  const app = await host(() => text('基础编排可用。'), { fullHost: true })
  const routes = []
  const before = process.env.DSH_FEISHU_ENABLED
  let runtime
  try {
    process.env.DSH_FEISHU_ENABLED = '0'
    app.ctx.provide('workspaceRegistry', { create: async () => {}, resolveByPath: async () => ({ attachSession: async () => {} }) })
    app.ctx.provide('credentials', { resolve: async () => { throw new Error('No credential reads allowed') } })
    app.ctx.provide('webServer', { register: route => { routes.push(route); return () => {} } })
    app.ctx.provide('connection', { requestRejection: () => undefined })
    app.ctx.provide('approval', {})
    if (custom) {
      const presets = JSON.parse(await readFile(new URL('../../src/orchestration/presets.json', import.meta.url), 'utf8'))
      for (const preset of presets) await app.ctx.agentPresets.register({ ...preset, id: `custom-${preset.id}` })
    }
    await app.ctx.plugin(base, {
      ...app.config, agentPreset: 'standard', conversationMode: 'orchestrated',
      ...(custom ? { orchestration: { frontdeskPreset: 'custom-orchestrator-frontdesk', workerPreset: 'custom-orchestrator-worker' } } : {}),
      stateDir: join(app.root, 'host'), businessEnabled: false,
    })
    runtime = app.ctx.get('dshFeishu')
    assert.ok(runtime, 'actual plugin publishes the host service')
    await runtime.whenReady
    assert.ok(runtime.bridge instanceof OrchestratedConversations)
    assert.equal(runtime.bridge.config.agentPreset, custom ? 'custom-orchestrator-frontdesk' : 'orchestrator-frontdesk')
    assert.equal(runtime.bridge.config.sessionNamespace, `${app.config.sessionNamespace}-orchestrated`)
    let status
    await routes.find(r => r.path.endsWith('/status')).handler({ method: 'GET', url: '/feishu/api/status' }, { writeHead() {}, end: body => { status = JSON.parse(body) } })
    assert.equal(status.conversationMode, 'orchestrated')
    assert.equal(status.ready, true)
    const result = await runtime.bridge.reply(app.message('本地验收', { chatId: 'local-probe:base', senderId: 'local-probe' }))
    const parent = app.ctx.agents.get(result.sessionId)
    await parent.whenIdle()
    assert.ok(parent.session.snapshotEvents().some(e => e.type === 'assistant/message'))
    const { childId } = await runtime.bridge.orchestrator.delegate(parent, { label: '入口委派', task: '报告当前编排可用。' }, new AbortController().signal)
    await until(() => app.events.get(childId)?.some(e => e.type === 'turn/end'), 'native child completes')
    assert.equal(Object.keys(runtime.bridge.state.value.orchestratorDeliveries).length, 0)
  } finally {
    if (before === undefined) delete process.env.DSH_FEISHU_ENABLED
    else process.env.DSH_FEISHU_ENABLED = before
    await app.dispose()
  }
})

test('worker workflow uses the original requester, stable capability, receipt and readback while parent keeps chatting', { timeout: 15000 }, async () => {
  let workerSteps = 0, delegated = false, writes = 0, readbacks = 0, childId
  const app = await host((request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) {
      childId = request.sessionId
      return ++workerSteps === 1 ? call('sample_write', {}) : text('已写入并读回。')
    }
    if (!delegated) { delegated = true; return call('orchestrator_delegate', { label: '保存', task: '执行 sample_write 并读回。' }) }
    return text('我在。')
  })
  let shown
  const approvals = new FeishuApprovals({
    runningForAgent: agent => app.bridge.runningForAgent(agent), timeoutMs: 10000,
    sendCard: async (recipient, card) => { shown = { recipient, card }; return { messageId: 'om_card' } }, updateCard: async () => {},
  })
  const factory = { name: 'sample_write', description: 'Synthetic confirmed write', parameters: { type: 'object', properties: {} }, execute: async () => { writes++; return { details: { id: 'synthetic-record' } } } }
  const operations = new FeishuTools({ client: () => ({}), runningForAgent: agent => app.bridge.runningForAgent(agent), approvals, catalog: [factory], config: { ...app.config, stateDir: app.root } })
  try {
    await operations.load()
    app.ctx.tools.register(defineTool({ name: 'sample_write', description: '保存合成记录并读回。', parameters: {},
      output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const turn = app.bridge.runningForAgent(exec.agent)
        return operations.withApprovedWorkflow({ agent: exec.agent, toolName: 'sample_write', callId: exec.callId, signal: exec.signal, business: true }, async grant => {
          const value = await grant.performWrite('sample_write', args, turn, exec.signal, 'synthetic-operation', undefined, undefined, async () => { readbacks++; return { verified: true } })
          return JSON.stringify(value)
        })
      },
    }))
    const first = app.message('保存记录', { senderId: 'ou_requester' })
    await app.bridge.enqueue(first, ticket => app.bridge.reply(first, ticket))
    await until(() => shown, 'approval card')
    assert.equal(shown.recipient, 'ou_requester')
    assert.equal(writes, 0)
    const child = app.ctx.agents.get(childId)
    const turn = app.bridge.runningForAgent(child)
    assert.equal(turn.message.messageId, first.messageId)
    assert.equal(turn, app.bridge.runningForAgent(child))
    await app.input('执行期间继续聊天', { senderId: 'ou_requester' })
    assert.equal(app.bridge.runningForAgent(child), turn, 'unrelated parent input retains the child approval source')
    const action = { tag: 'button', value: shown.card.elements.at(-1).actions[0].value }
    await until(() => approvals.byMessageId.has('om_card'), 'card receipt')
    assert.equal(approvals.onCardAction({ messageId: 'om_card', operator: { openId: 'ou_other' }, action }), false)
    assert.equal(writes, 0)
    assert.equal(approvals.onCardAction({ messageId: 'om_card', operator: { openId: 'ou_requester' }, action }), true)
    await until(() => operations.ledger['synthetic-operation']?.status === 'verified', 'verified write')
    assert.equal(writes, 1)
    assert.equal(readbacks, 1)
    assert.equal(operations.ledger['synthetic-operation'].result.id, 'synthetic-record')
  } finally { approvals.dispose(); await app.dispose() }
})

test('base private boundary still constrains delegated filesystem and shell access', { timeout: 15000 }, async () => {
  const hold = Promise.withResolvers(), started = Promise.withResolvers()
  const app = await host(async (request, ctx) => {
    if (ctx.agents.get(request.sessionId).session.header.parentSession) { started.resolve(); await hold.promise }
    return text('收到。')
  })
  try {
    installPrivateBoundary(app.ctx, { config: app.config, bridge: app.bridge })
    await writeFile(join(app.root, 'private.txt'), 'synthetic private content')
    await app.input('执行任务')
    const parent = await app.parent(); await parent.whenIdle()
    const { childId } = await app.ctx.orchestrator.delegate(parent, { label: '边界', task: '等候检查。' }, new AbortController().signal)
    await started.promise
    const child = app.ctx.agents.get(childId)
    const exec = (name, args) => app.ctx.tools.execute({ name, arguments: args, agent: child, callId: llm.ToolCallId(crypto.randomUUID()), signal: new AbortController().signal })
    assert.equal((await exec('read', { file_path: '../private.txt' })).isError, true)
    assert.equal((await exec('bash', { command: 'true', description: 'check', sandbox_permissions: 'danger-full-access' })).isError, true)
    const written = await exec('write', { file_path: 'result.txt', content: 'allowed' })
    assert.equal(written.isError, false, JSON.stringify(written))
    assert.equal(await readFile(join(app.workspace, 'result.txt'), 'utf8'), 'allowed')
  } finally { hold.resolve(); await app.dispose() }
})
