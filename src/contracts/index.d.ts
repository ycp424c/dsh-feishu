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
export interface Application {
  label?: string
  version?: string
  source?: string
  enabled?: boolean
  apiPrefix?: string
  sessionNamespace?: string
  requiredExtensions?: string[]
  approvalOptions?: { brand?: string; approvalIdKey?: string; presenter?: (request: unknown, verifiedArguments: unknown) => unknown }
  createOperations?: (options: Record<string, unknown>) => unknown
  setup?: (runtime: Record<string, unknown>) => Promise<void> | void
}
