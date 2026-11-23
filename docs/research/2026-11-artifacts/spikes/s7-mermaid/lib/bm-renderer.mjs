// beautiful-mermaid in a worker thread with a per-diagram timeout (terminate and respawn).
import { Worker } from 'node:worker_threads'

export class BmPool {
  constructor() { this.worker = null; this.seq = 0; this.pending = new Map() }

  spawn() {
    this.worker = new Worker(new URL('./bm-worker.mjs', import.meta.url))
    this.worker.on('message', (m) => { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m) } })
    this.worker.on('error', (e) => { for (const p of this.pending.values()) p({ error: String(e.message || e), stage: 'worker' }); this.pending.clear(); this.worker = null })
  }

  async render(src, options = {}, timeoutMs = 10000, structure = true) {
    if (!this.worker) this.spawn()
    const id = ++this.seq
    const started = Date.now()
    let timer
    const result = await new Promise((resolve) => {
      this.pending.set(id, resolve)
      timer = setTimeout(() => { this.pending.delete(id); resolve({ timedOut: true }) }, timeoutMs)
      this.worker.postMessage({ id, src, options, structure })
    })
    clearTimeout(timer)
    result.wallMs = Date.now() - started
    if (result.timedOut) { await this.worker.terminate(); this.worker = null }
    return result
  }

  async close() { if (this.worker) await this.worker.terminate(); this.worker = null }
}
