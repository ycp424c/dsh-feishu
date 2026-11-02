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
export const createApplication = (ctx, config, application = {}) => startFeishu(ctx, config, application, { createLarkChannel, Domain, LoggerLevel, installModelSelection, createUserMessage, SessionId, credentialRef })
export async function apply(ctx, config = {}) { await createApplication(ctx, config) }
