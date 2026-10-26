import type {
  SandboxInfo,
  SandboxProvider,
  SiteLeaseAuthority,
  SiteLeaseStore,
  TurnAssignment,
  TurnAssignmentStore,
} from '@repo/domain'

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
    /** Recovery moves a turn to a newer epoch; its container keeps the epoch it was created with. */
    private readonly assignments: Pick<TurnAssignmentStore, 'unfinished'>,
    /**
     * Containers this process holds whatever their labels say: a warm one waiting for the next
     * turn of its task, or taken by that turn (spec §8, «Тёплая песочница»).
     */
    private readonly held: (containerId: string) => boolean = () => false,
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = { removed: [], preserved: [], uncertain: [] }
    const candidates = await this.sandboxes.list()
    if (candidates.length === 0) return result
    // Without the owners an adopted container cannot be told from an orphan: nothing is removed.
    const owners = await this.assignments.unfinished().catch(() => null)
    if (!owners) {
      result.uncertain.push(...candidates.map((candidate) => candidate.id))
      return result
    }
    for (const candidate of candidates) {
      if (this.held(candidate.id)) {
        result.preserved.push(candidate.id)
        continue
      }
      try {
        const authority = await this.leases.inspect(candidate.labels.siteId)
        if (!this.stale(candidate, authority, owners)) {
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
        if (
          this.held(candidate.id) ||
          !this.stale(candidate, await this.leases.inspect(candidate.labels.siteId), owners)
        ) {
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

  private stale(
    candidate: SandboxInfo,
    authority: SiteLeaseAuthority | null,
    owners: readonly TurnAssignment[],
  ): boolean {
    if (!authority || authority.taskId === null) return true
    if (authority.taskId !== candidate.labels.taskId || authority.operation !== 'turn') return true
    // Old fixtures without an epoch can be kept; assigning them the current epoch would be unsafe.
    const epoch = candidate.labels.leaseEpoch
    if (epoch === undefined) return false
    const live =
      !authority.heldForOperator &&
      authority.expiresAt !== null &&
      authority.expiresAt.getTime() > authority.serverNow.getTime()
    if (authority.epoch === epoch) return !live
    // Taken over by recovery: the turn's assignment holds the current epoch and this container.
    const adopted = owners.some(
      (owner) =>
        owner.fence.siteId === candidate.labels.siteId &&
        owner.fence.taskId === candidate.labels.taskId &&
        owner.sessionId === candidate.labels.sessionId &&
        owner.turn === candidate.labels.turn &&
        owner.fence.epoch === authority.epoch &&
        epoch >= owner.firstEpoch &&
        epoch < owner.fence.epoch &&
        (owner.containerId === null || owner.containerId === candidate.id),
    )
    // A warm container a later turn of the session took (spec §8, «Тёплая песочница»): it keeps
    // the turn and epoch it was created with, and that turn's assignment names its id.
    const taken = owners.some(
      (owner) =>
        owner.containerId === candidate.id &&
        owner.fence.siteId === candidate.labels.siteId &&
        owner.fence.taskId === candidate.labels.taskId &&
        owner.sessionId === candidate.labels.sessionId &&
        owner.turn > candidate.labels.turn &&
        owner.fence.epoch === authority.epoch &&
        epoch < owner.firstEpoch,
    )
    return !((adopted || taken) && live)
  }
}
