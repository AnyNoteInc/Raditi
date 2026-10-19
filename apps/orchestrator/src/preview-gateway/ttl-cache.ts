/**
 * A small map whose entries live a fixed time and whose size has a ceiling: the oldest entry
 * leaves first. The gateway keeps what it read from the database here for a few seconds, so a
 * page with a hundred assets costs one lookup, and a flood of made-up hosts cannot grow it.
 */
export class TtlCache<K, V> {
  readonly #entries = new Map<K, { value: V; at: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The value, or undefined when there is none or it is older than the TTL. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() - entry.at >= this.ttlMs) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: K, value: V): void {
    this.#entries.delete(key)
    this.#entries.set(key, { value, at: this.now() })
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  /** Changes a fresh value in place, keeping its age; nothing when it is gone. */
  update(key: K, change: (value: V) => V): void {
    const entry = this.#entries.get(key)
    if (entry !== undefined && this.now() - entry.at < this.ttlMs) entry.value = change(entry.value)
  }

  delete(key: K): void {
    this.#entries.delete(key)
  }

  get size(): number {
    return this.#entries.size
  }
}
