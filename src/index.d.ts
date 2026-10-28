import type { Application } from 'dsh-feishu/contracts'
export { contractVersion } from 'dsh-feishu/contracts'
export const baseVersion: string
export const name: string
export const inject: string[]
export function createApplication(ctx: unknown, config: Record<string, unknown>, application?: Application): Promise<Record<string, unknown>>
export function apply(ctx: unknown, config?: Record<string, unknown>): Promise<void>
