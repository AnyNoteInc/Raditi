// In-memory TurnAssignmentStore for *.test.ts files: the rules of the PostgreSQL store (one
// unfinished assignment per turn, claims of unclaimed runner turns, epoch-conditional writes)
// without the site lease check of `open`, which packages/db tests against PostgreSQL. A takeover
// reclaims and the sweep of orphaned holds frees through the site lease store it is given.
import { randomUUID } from 'node:crypto'

import type {
  OpenTurnAssignment,
  SiteLeaseFence,
  SiteLeaseGrant,
  SiteLeaseStore,
  TurnAssignment,
  TurnAssignmentOutcome,
  TurnAssignmentStore,
} from '@repo/domain'

export class MemoryTurnAssignments implements TurnAssignmentStore {
  readonly rows = new Map<string, TurnAssignment>()
  readonly seenAt = new Map<string, number>()

  constructor(
    private readonly leases?: Pick<SiteLeaseStore, 'reclaimForRecovery'> &
      Partial<Pick<SiteLeaseStore, 'inspect' | 'free'>>,
  ) {}

  async open(input: OpenTurnAssignment): Promise<TurnAssignment | null> {
    for (const row of this.rows.values())
      if (row.fence.taskId === input.fence.taskId && row.turn === input.turn && !row.outcome)
        return null
    const now = Date.now()
    const row: TurnAssignment = {
      id: randomUUID(),
      fence: { ...input.fence },
      firstEpoch: input.fence.epoch,
      sessionId: input.sessionId,
      turn: input.turn,
      executor: input.executor,
      plan: structuredClone(input.plan),
      deadlineAt: new Date(now + input.remainingMs),
      serverNow: new Date(now),
      runner: null,
      containerId: null,
      recoveryAttempts: 0,
      outcome: null,
    }
    this.rows.set(row.id, row)
    return this.#copy(row)
  }

  async get(id: string): Promise<TurnAssignment | null> {
    const row = this.rows.get(id)
    return row ? this.#copy(row) : null
  }

  async claim(input: {
    ids: readonly string[]
    runnerId: string
    runnerSession: string
    limit: number
  }): Promise<TurnAssignment[]> {
    const claimed: TurnAssignment[] = []
    for (const id of input.ids) {
      const row = this.rows.get(id)
      if (claimed.length >= input.limit) break
      if (!row || row.executor !== 'runner' || row.runner || row.outcome) continue
      if (row.deadlineAt.getTime() <= Date.now()) continue
      row.runner = { id: input.runnerId, session: input.runnerSession }
      claimed.push(this.#copy(row))
    }
    return claimed
  }

  async abandon(id: string, outcome: TurnAssignmentOutcome = 'failed'): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.executor !== 'runner' || row.runner || row.outcome) return false
    row.outcome = outcome
    return true
  }

  async recordContainer(input: {
    id: string
    epoch: number
    containerId: string
  }): Promise<boolean> {
    const row = this.rows.get(input.id)
    if (!row || row.outcome || row.fence.epoch !== input.epoch) return false
    if (row.containerId !== null && row.containerId !== input.containerId) return false
    row.containerId = input.containerId
    return true
  }

  async seen(input: {
    runnerId: string
    runnerSession: string
    ids: readonly string[]
  }): Promise<void> {
    for (const id of input.ids) {
      const row = this.rows.get(id)
      if (row?.runner?.id === input.runnerId && row.runner.session === input.runnerSession)
        this.seenAt.set(id, Date.now())
    }
  }

  async takeOver(input: {
    id: string
    fence: SiteLeaseFence
    ttlMs: number
    runnerSession?: string
    countAttempt?: boolean
  }): Promise<{ assignment: TurnAssignment; grant: SiteLeaseGrant } | null> {
    if (!this.leases) throw new Error('A takeover needs the site lease store')
    const row = this.rows.get(input.id)
    if (!row) return null
    const current = () =>
      !row.outcome &&
      row.fence.siteId === input.fence.siteId &&
      row.fence.taskId === input.fence.taskId &&
      row.fence.epoch === input.fence.epoch &&
      (!input.runnerSession || row.runner !== null)
    if (!current()) return null
    const grant = await this.leases.reclaimForRecovery(input.fence, input.ttlMs)
    if (!grant) return null
    // One statement in PostgreSQL: a test that changes the row meanwhile has a race it cannot have.
    if (!current()) throw new Error('The assignment changed during its takeover')
    row.fence = { ...row.fence, epoch: grant.epoch }
    if (input.countAttempt ?? true) row.recoveryAttempts += 1
    if (input.runnerSession && row.runner)
      row.runner = { ...row.runner, session: input.runnerSession }
    return { assignment: this.#copy(row), grant }
  }

  async countAttempt(input: { id: string; epoch: number }): Promise<boolean> {
    const row = this.rows.get(input.id)
    if (!row || row.outcome || row.fence.epoch !== input.epoch) return false
    row.recoveryAttempts += 1
    return true
  }

  async finish(input: {
    id: string
    epoch: number
    outcome: TurnAssignmentOutcome
  }): Promise<boolean> {
    const row = this.rows.get(input.id)
    if (!row || row.outcome || row.fence.epoch !== input.epoch) return false
    row.outcome = input.outcome
    return true
  }

  async freeOrphanedHolds(): Promise<number> {
    const { inspect, free } = this.leases ?? {}
    if (!inspect || !free) throw new Error('A sweep needs the site lease store')
    let freed = 0
    const rows = [...this.rows.values()]
    for (const siteId of new Set(rows.map((row) => row.fence.siteId))) {
      const lease = await inspect.call(this.leases, siteId)
      if (!lease?.heldForOperator || lease.operation !== 'turn' || !lease.taskId) continue
      const ofTask = rows.filter(
        (row) => row.fence.siteId === siteId && row.fence.taskId === lease.taskId,
      )
      if (!ofTask.some((row) => row.outcome && row.fence.epoch === lease.epoch)) continue
      if (ofTask.some((row) => !row.outcome)) continue
      const fence = { siteId, taskId: lease.taskId, operation: lease.operation, epoch: lease.epoch }
      if (await free.call(this.leases, fence)) freed += 1
    }
    return freed
  }

  async unfinished(filter: { runnerId?: string } = {}): Promise<TurnAssignment[]> {
    return [...this.rows.values()]
      .filter((row) => !row.outcome && (!filter.runnerId || row.runner?.id === filter.runnerId))
      .map((row) => this.#copy(row))
  }

  #copy(row: TurnAssignment): TurnAssignment {
    return { ...structuredClone(row), serverNow: new Date() }
  }
}
