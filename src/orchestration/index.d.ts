import type { ConversationBackend, ConversationDependencies, ConversationMessage, ConversationState } from 'dsh-feishu/contracts'

export interface OrchestrationOptions {
  maxActive?: number
  maxRelay?: number
  frontdeskPreset?: string
  workerPreset?: string
}
export interface Orchestrator {
  bindRoot(agent: any, options: { workspace: string; attachmentPath: (ref: any) => string; allowedFiles?: string[]; taskRecords?: any[]; saveTask: (type: string, data: any) => Promise<void> }): any
  acceptInput(agent: any, allowedFiles: string[], inputContext?: object): void
  setExecutionContexts(agent: any, contexts: any[]): void
  contextForChild(agent: any, childId: string): any
  hasOtherActive(agent: any, senderId: string): boolean
  cancelForSender(agent: any, senderId: string): Promise<{ stopped: string[] }>
  roleOf(agent: any): any
  delegate(agent: any, args: { label: string; task: string; attachments?: string[]; request_id?: string }, signal: AbortSignal): Promise<{ childId: string; status: string }>
  message(agent: any, args: { agent_id: string; message: string; attachments?: string[]; request_id?: string }, signal: AbortSignal): Promise<{ messageId: string }>
  cancel(agent: any, childId?: string, requestId?: string): Promise<{ stopped: string[] }>
  list(agent: any): Promise<any[]>
  stopRoot(agent: any): Promise<{ stopped: string[] }>
  unbindRoot(agent: any): Promise<void>
  dispose(): Promise<void>
}
export function createOrchestrator(ctx: any, config?: OrchestrationOptions): Orchestrator
export function createNativeConversations(deps: ConversationDependencies, config: Record<string, any>, state: ConversationState, ctx: any): Promise<OrchestratedConversations>
export class OrchestratedConversations implements ConversationBackend {
  constructor(deps: ConversationDependencies, config: Record<string, any>, state: ConversationState, ctx: any, orchestrator: Orchestrator)
  readonly managedReplies: true
  readonly orchestrator: Orchestrator
  readonly config: Record<string, any>
  running: Map<string, any>
  queues: Map<string, Promise<unknown>>
  prepare?(): Promise<void>
  get(key: string): Promise<any>
  enqueue(message: ConversationMessage, callback: (ticket: any) => unknown, onCancel?: () => unknown): Promise<any>
  reply(message: ConversationMessage, ticket?: any): Promise<any>
  cancel(message: ConversationMessage): Promise<boolean>
  reset(message: ConversationMessage, ticket?: any): Promise<void>
  otherSenderActive(message: ConversationMessage): boolean
  runningForAgent(agent: any): any
  statusText(message: ConversationMessage): Promise<string>
  dispose(): Promise<void>
}
