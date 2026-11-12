export const contractVersion: 1
export interface ExtensionSnapshot { contractVersion: number; ready: boolean; required: string[]; extensions: { id: string; ready: boolean; version: number }[] }
export class ExtensionRegistry {
  constructor(required?: string[])
  register(id: string, version?: number): () => void
  ready(id: string): void
  readonly isReady: boolean
  snapshot(): ExtensionSnapshot
  waitReady(timeoutMs?: number, signal?: AbortSignal): Promise<void>
}
export interface ConversationMessage {
  chatType: string
  chatId: string
  senderId: string
  messageId: string
  content: string
  [key: string]: unknown
}
export interface ConversationState {
  value: Record<string, any>
  save(): Promise<void>
}
export interface ConversationDependencies {
  sendReply(message: ConversationMessage, content: string | Record<string, unknown>): Promise<{ messageId: string }>
  uploadImage(data: Uint8Array): Promise<string>
  [key: string]: any
}
export interface ConversationBackend {
  readonly managedReplies?: boolean
  running: Map<string, any>
  queues: Map<string, Promise<unknown>>
  prepare?(): Promise<void>
  enqueue(message: ConversationMessage, callback: (ticket: any) => unknown, onCancel?: () => unknown): Promise<any>
  reply(message: ConversationMessage, ticket?: any): Promise<any>
  cancel(message: ConversationMessage): boolean | Promise<boolean>
  reset(message: ConversationMessage, ticket?: any): Promise<void>
  otherSenderActive(message: ConversationMessage): boolean
  runningForAgent(agent: any): any
  statusText?(message: ConversationMessage): Promise<string>
  dispose(): Promise<void>
}
export interface Application {
  label?: string
  version?: string
  source?: string
  enabled?: boolean
  apiPrefix?: string
  sessionNamespace?: string
  requiredExtensions?: string[]
  approvalOptions?: { brand?: string; approvalIdKey?: string; presenter?: (request: unknown, verifiedArguments: unknown) => unknown }
  createConversations?: (deps: ConversationDependencies, config: Record<string, any>, state: ConversationState) => ConversationBackend | Promise<ConversationBackend>
  createOperations?: (options: Record<string, unknown>) => unknown
  setup?: (runtime: Record<string, unknown>) => Promise<void> | void
}
