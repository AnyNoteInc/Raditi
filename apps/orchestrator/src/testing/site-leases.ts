// In-memory SiteLeaseStore for *.test.ts files with the rules of the PostgreSQL store (every
// write conditional on the whole fence, holds that survive expiry, reclaim under the next epoch),
// so recovery tests see stale owners fenced as they would be. packages/db tests the real one.
import type {
  SiteLeaseAuthority,
  SiteLeaseFence,
  SiteLeaseGrant,
  SiteLeaseOperation,
  SiteLeaseStore,
} from '@repo/domain'

interface Row {
  taskId: string | null
  operation: SiteLeaseOperation | null
  epoch: number
  expiresAt: number | null
  held: boolean
}

export class MemorySiteLeases implements SiteLeaseStore {
  readonly rows = new Map<string, Row>()

  async acquire(
    input: Omit<SiteLeaseFence, 'epoch'> & { ttlMs: number },
  ): Promise<SiteLeaseGrant | null> {
    const row = this.rows.get(input.siteId)
    if (row && (row.held || (row.taskId !== null && row.expiresAt! > Date.now()))) return null
    const next: Row = {
      taskId: input.taskId,
      operation: input.operation,
      epoch: (row?.epoch ?? 0) + 1,
      expiresAt: Date.now() + input.ttlMs,
      held: false,
    }
    this.rows.set(input.siteId, next)
    return this.#grant(input.siteId, next)
  }

  async renew(fence: SiteLeaseFence, ttlMs: number): Promise<SiteLeaseGrant | null> {
    const row = this.#live(fence)
    if (!row) return null
    row.expiresAt = Date.now() + ttlMs
    return this.#grant(fence.siteId, row)
  }

  async assert(fence: SiteLeaseFence): Promise<boolean> {
    return this.#live(fence) !== null
  }

  async release(fence: SiteLeaseFence): Promise<boolean> {
    const row = this.#live(fence)
    if (!row) return false
    Object.assign(row, { taskId: null, operation: null, expiresAt: null })
    return true
  }

  async inspect(siteId: string): Promise<SiteLeaseAuthority | null> {
    const row = this.rows.get(siteId)
    return row
      ? {
          siteId,
          taskId: row.taskId,
          operation: row.operation,
          epoch: row.epoch,
          expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
          serverNow: new Date(),
          heldForOperator: row.held,
        }
      : null
  }

  async holdForRecovery(fence: SiteLeaseFence): Promise<boolean> {
    const row = this.#owned(fence)
    if (!row) return false
    row.held = true
    return true
  }

  async reclaimForRecovery(fence: SiteLeaseFence, ttlMs: number): Promise<SiteLeaseGrant | null> {
    const row = this.#owned(fence)
    if (!row?.held) return null
    Object.assign(row, { epoch: row.epoch + 1, held: false, expiresAt: Date.now() + ttlMs })
    return this.#grant(fence.siteId, row)
  }

  async free(fence: SiteLeaseFence): Promise<boolean> {
    const row = this.#owned(fence)
    if (!row) return false
    Object.assign(row, { taskId: null, operation: null, expiresAt: null, held: false })
    return true
  }

  /** The fence's row, expired or held alike. */
  #owned(fence: SiteLeaseFence): Row | null {
    const row = this.rows.get(fence.siteId)
    return row &&
      row.taskId === fence.taskId &&
      row.epoch === fence.epoch &&
      row.operation === fence.operation
      ? row
      : null
  }

  #live(fence: SiteLeaseFence): Row | null {
    const row = this.#owned(fence)
    return row && !row.held && row.expiresAt! > Date.now() ? row : null
  }

  #grant(siteId: string, row: Row): SiteLeaseGrant {
    return {
      siteId,
      taskId: row.taskId!,
      operation: row.operation!,
      epoch: row.epoch,
      expiresAt: new Date(row.expiresAt!),
      serverNow: new Date(),
    }
  }
}
