export const contractVersion = 1
export class ExtensionRegistry {
  constructor(required = []) { this.required = new Set(required); this.entries = new Map(); this.waiters = new Set() }
  register(id, version = contractVersion) {
    if (typeof id !== 'string' || !id || version !== contractVersion || this.entries.has(id)) throw new Error('Invalid, duplicate or incompatible extension')
    this.entries.set(id, { ready: false, version }); this.notify()
    return () => { this.entries.delete(id); this.notify() }
  }
  ready(id) { const entry = this.entries.get(id); if (!entry) throw new Error('Unknown extension'); entry.ready = true; this.notify() }
  get isReady() { return [...this.required].every(id => this.entries.get(id)?.ready) }
  snapshot() { return { contractVersion, ready: this.isReady, required: [...this.required], extensions: [...this.entries].map(([id, entry]) => ({ id, ...entry })) } }
  notify() { for (const fn of this.waiters) fn() }
  async waitReady(timeoutMs = 15000, signal) {
    signal?.throwIfAborted()
    if (this.isReady) return
    await new Promise((resolve, reject) => {
      const check = () => { if (this.isReady) { cleanup(); resolve() } }
      const abort = () => { cleanup(); reject(signal.reason) }
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(check); signal?.removeEventListener('abort', abort) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('Required Feishu extensions are not ready')) }, timeoutMs)
      this.waiters.add(check); signal?.addEventListener('abort', abort, { once: true }); check()
    })
  }
}
