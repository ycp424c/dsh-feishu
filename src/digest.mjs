import { createHash } from 'node:crypto'
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
