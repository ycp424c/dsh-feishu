import { createLarkChannel, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { startFeishu } from './host.mjs'
export { baseVersion } from './host.mjs'
export { contractVersion } from './contracts/index.mjs'
export const name = 'dsh-feishu'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'agentPresets', 'workspaceRegistry', 'credentials', 'webServer', 'connection', 'attachments', 'llm', 'approval', 'tools', 'shellEnv', 'workingDirectory']
export const orchestrationInject = [...inject, 'subagents', 'systemPrompt']
export async function createApplication(ctx, config, application = {}) {
  const start = ctx => startFeishu(ctx, config, application, { createLarkChannel, Domain, LoggerLevel, installModelSelection, createUserMessage, SessionId, credentialRef })
  if (config.conversationMode !== 'orchestrated') return start(ctx)
  let runtime
  await ctx.inject(orchestrationInject, async scoped => { runtime = await start(scoped) })
  if (!runtime) throw new Error('Native orchestration host services are unavailable')
  return runtime
}
export async function apply(ctx, config = {}) { await createApplication(ctx, config) }
