import type { SandboxInfo, SandboxProvider, SiteLeaseAuthority, SiteLeaseStore } from '@repo/domain'

export interface ReconcileResult {
  removed: string[]
  preserved: string[]
  uncertain: string[]
}

/** Unavailable authority fails closed; a successful lookup with no lease proves an orphan. */
export class TurnReconciler {
  constructor(
    private readonly sandboxes: SandboxProvider,
    private readonly leases: SiteLeaseStore,
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { removed: [], preserved: [], uncertain: [] }
    const candidates = await this.sandboxes.list()
    for (const candidate of candidates) {
      try {
        const authority = await this.leases.inspect(candidate.labels.siteId)
        if (!this.stale(candidate, authority)) {
          result.preserved.push(candidate.id)
          continue
        }
        // Also a container that can no longer run anything, such as one whose gateway died.
        const sandbox = await this.sandboxes.getForRemoval(candidate.id)
        if (!sandbox) continue
        // The provider must return the exact immutable container id, never a reused name.
        if (
          sandbox.id !== candidate.id ||
          Object.entries(candidate.labels).some(
            ([key, value]) => sandbox.labels[key as keyof typeof sandbox.labels] !== value,
          )
        ) {
          result.uncertain.push(candidate.id)
          continue
        }
        if (!this.stale(candidate, await this.leases.inspect(candidate.labels.siteId))) {
          result.preserved.push(candidate.id)
          continue
        }
        await sandbox.destroy('gc')
        result.removed.push(candidate.id)
      } catch {
        result.uncertain.push(candidate.id)
      }
    }
    return result
  }

  private stale(candidate: SandboxInfo, authority: SiteLeaseAuthority | null): boolean {
    if (!authority || authority.taskId === null) return true
    if (authority.taskId !== candidate.labels.taskId || authority.operation !== 'turn') return true
    // Old fixtures without an epoch can be kept; assigning them the current epoch would be unsafe.
    if (candidate.labels.leaseEpoch === undefined) return false
    if (authority.epoch !== candidate.labels.leaseEpoch) return true
    return (
      authority.heldForOperator ||
      authority.expiresAt === null ||
      authority.expiresAt.getTime() <= authority.serverNow.getTime()
    )
  }
}
