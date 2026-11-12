import { readFileSync } from 'node:fs'
import { createOrchestrator } from './orchestrator.mjs'
import { OrchestratedConversations } from './feishu.mjs'

export { createOrchestrator, OrchestratedConversations }

// Presets are registered only for the opt-in backend. Custom presets remain
// owned by the consumer and must already exist in the host registry.
export async function createNativeConversations(deps, config, state, ctx) {
  if (config.groupPolicy !== 'disabled') throw new Error('Native orchestration currently requires groupPolicy: disabled')
  if (config.maxTurnMs !== 0) throw new Error('Native orchestration currently requires maxTurnMs: 0; use /cancel to stop tasks')
  for (const service of ['subagents', 'systemPrompt', 'tools', 'workingDirectory']) {
    if (!ctx[service]) throw new Error(`Native orchestration requires host service: ${service}`)
  }
  const options = config.orchestration ?? {}
  const frontdeskPreset = options.frontdeskPreset ?? 'orchestrator-frontdesk'
  const workerPreset = options.workerPreset ?? 'orchestrator-worker'
  if (typeof frontdeskPreset !== 'string' || !frontdeskPreset || typeof workerPreset !== 'string' || !workerPreset || frontdeskPreset === workerPreset) throw new Error('Distinct frontdeskPreset and workerPreset are required')
  const presets = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'))
  const disposers = []
  let orchestrator
  try {
    for (const id of [frontdeskPreset, workerPreset]) {
      const builtin = presets.find(p => p.id === id)
      if (builtin) disposers.push(await ctx.agentPresets.register(builtin))
    }
    orchestrator = createOrchestrator(ctx, { ...options, frontdeskPreset, workerPreset })
    const dispose = orchestrator.dispose
    orchestrator.dispose = async () => { try { await dispose() } finally { for (const fn of disposers.splice(0).reverse()) await fn() } }
    const bridge = new OrchestratedConversations(deps, {
      ...config, sessionNamespace: `${config.sessionNamespace}-orchestrated`, agentPreset: frontdeskPreset,
    }, state, ctx, orchestrator)
    // Registry diagnostics may wait for the host Loader row to finish. Run
    // them from deferred startup, after publishing the host service.
    bridge.prepare = async () => { await ctx.agentPresets.resolve(frontdeskPreset); await ctx.agentPresets.resolve(workerPreset) }
    return bridge
  } catch (error) {
    await orchestrator?.dispose()
    for (const fn of disposers.splice(0).reverse()) await fn()
    throw error
  }
}
