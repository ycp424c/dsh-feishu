import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
export class State {
  constructor(path) { this.path = path; this.value = { generations: {}, receipts: {} }; this.pending = Promise.resolve() }
  async load() {
    try { this.value = JSON.parse(await readFile(this.path, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  save() {
    const data = JSON.stringify(this.value)
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', data, { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}
