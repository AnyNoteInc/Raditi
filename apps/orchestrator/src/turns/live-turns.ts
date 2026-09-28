import type { SiteLeaseFence } from '@repo/domain'

const key = (fence: Pick<SiteLeaseFence, 'siteId' | 'epoch'>) => `${fence.siteId}:${fence.epoch}`

/**
 * The fences this core process drives a turn under right now: the supervisor enters its lease
 * before it opens the assignment, recovery the epoch it takes over. Recovery never takes over a
 * live turn. P2 runs one core replica; several replicas need an owner in the database instead.
 */
export class LiveTurns {
  readonly #fences = new Set<string>()

  /** false when the fence is already driven here. */
  enter(fence: Pick<SiteLeaseFence, 'siteId' | 'epoch'>): boolean {
    const id = key(fence)
    if (this.#fences.has(id)) return false
    this.#fences.add(id)
    return true
  }

  leave(fence: Pick<SiteLeaseFence, 'siteId' | 'epoch'>): void {
    this.#fences.delete(key(fence))
  }

  has(fence: Pick<SiteLeaseFence, 'siteId' | 'epoch'>): boolean {
    return this.#fences.has(key(fence))
  }
}
