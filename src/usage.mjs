import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from './digest.mjs'

export function usageRecord(session, event, model) {
  if (event.type !== 'assistant/message' || !event.data?.usage) return null
  const usage = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = event.data.usage[key]
    if (Number.isFinite(value) && value >= 0) usage[key] = value
  }
  return { id: digest([String(session.id), event.seq]), at: new Date(event.timestamp ?? event.time ?? Date.now()).toISOString(), event: 'model.usage', session: digest(String(session.id)), model, usage }
}

export async function installUsage(ctx, config, bridge) {
  const root = join(config.stateDir, 'usage'); await mkdir(root, { recursive: true, mode: 0o700 })
  let tail = Promise.resolve()
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const turn = [...bridge.running.values()].find(t => t.agent.session === session)
    if (!turn) return
    const record = usageRecord(session, event, `${config.provider}/${config.model}`)
    if (record) record.source = turn.senderId === 'local-probe' ? 'probe' : 'feishu'
    if (record) tail = tail.catch(() => {}).then(() => appendFile(join(root, 'metadata.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 }))
  }), 'Feishu usage metadata without conversation bodies')
  ctx.effect(() => () => tail, 'Feishu usage writer drain')
  return { flush: () => tail }
}
