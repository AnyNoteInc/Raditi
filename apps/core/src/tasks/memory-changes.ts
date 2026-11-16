import {
  applyMemoryChange,
  chatMemory,
  closeStaleMemoryReservations,
  failMemoryTurn,
  insertFeedEvent,
  pendingMemoryChanges,
  refuseMemoryChange,
  type PendingMemoryChange,
  type PrismaClient,
} from '@repo/db'
import {
  isDomainError,
  memoryReservationPayloadSchema,
  memoryTextHasSecret,
  type MemoryChangeKind,
  type MemoryLeftReason,
  type MemoryPassConditions,
  type MemoryPassEvidence,
} from '@repo/domain'

// What a turn asked of the memory of its chat (docs/plan/84-projects.md, ПР18, §4.3, step 8):
// `memory_save`, `memory_update` and `memory_forget` reserved it during the turn; when the pass
// completed core applies each in the order asked, after the answer, the files and the pages — only
// core knows the client's words of the pass, what came into it from outside and the values of the
// client. A note that looks like a secret, a key of the turn or a value of a variable is refused;
// whether a kept one is active at once or «Предложено» is the domain's rule (passMayRemember). Each
// is told by `feed.memory_change` or `feed.memory_left`. A failed or cancelled pass applies none.

type Refuses = (text: string) => 'turn_key' | 'client_value' | null

/**
 * The internal row of `task_events` a chat gets once a pass of it took in something from outside
 * or ran a command (`{ v: 1, turn }`, never shown): the session of the agent goes on across passes,
 * so what came in once stays in its context, and no later note of the chat is active at once
 * (ревью, безопасность 3; ПР18).
 */
export const MEMORY_OUTSIDE_EVENT = 'memory.outside'

export interface MemoryChangesDependencies {
  db: Pick<PrismaClient, '$transaction' | 'memoryReservation' | 'task' | 'taskEvent' | 'taskTurn'>
  logger?: { log(message: string): void; warn(message: string): void }
}

/** What the pass gives the end of its turn. */
export interface MemoryPassFacts {
  /** The client's own words of the pass ask to remember (PassPlan.remember). */
  remember: boolean
  /** What the turn took in from outside; absent — not known, counted as outside. */
  evidence?: MemoryPassEvidence
  /** The chat has a repository (none since plan 83; the slices of the repository set it). */
  repository?: boolean
  /** Nobody watches the pass: a run of a scheduled task (Э5) may only propose. */
  unattended?: boolean
}

export class MemoryChanges {
  readonly #deps: MemoryChangesDependencies

  constructor(deps: MemoryChangesDependencies) {
    this.#deps = deps
  }

  /**
   * The changes of a completed pass. `refusesText` null — Vault did not answer, the values of the
   * client cannot be checked: every change is closed failed. Never throws.
   */
  async apply(
    taskId: string,
    turn: number,
    refusesText: Refuses | null,
    pass: MemoryPassFacts,
  ): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const earlier = await db.taskEvent.findFirst({
        where: { taskId, type: MEMORY_OUTSIDE_EVENT },
        select: { id: true },
      })
      const now = pass.evidence === undefined || pass.evidence.outside || pass.evidence.commands
      if (now && earlier === null)
        await db.taskEvent.create({
          data: { taskId, type: MEMORY_OUTSIDE_EVENT, payload: { v: 1, turn } },
        })
      const changes = await pendingMemoryChanges(db, taskId, turn)
      if (changes.length === 0) return
      const turnId = await this.#turnId(taskId, turn)
      const where = { taskId, turnId, turn }
      if (!refusesText) {
        for (const change of changes) await this.#left(change, 'failed', where, 'failed')
        return
      }
      const memory = await chatMemory(db, taskId)
      const conditions: MemoryPassConditions = {
        asked: pass.remember,
        outside: (pass.evidence?.outside ?? true) || earlier !== null,
        commands: pass.evidence?.commands ?? true,
        repository: pass.repository ?? false,
        unattended: pass.unattended ?? false,
      }
      for (const change of changes) {
        if (!memory) {
          await this.#left(change, 'off', where)
          continue
        }
        const payload = memoryReservationPayloadSchema.safeParse(change.payload)
        const text = payload.success ? payload.data.text : undefined
        if (text !== undefined && (memoryTextHasSecret(text) || refusesText(text) !== null)) {
          await this.#left(change, 'secret', where)
          continue
        }
        await this.#one(change, memory, conditions, where)
      }
    } catch (error) {
      logger?.warn(
        `memory_changes_failed task=${taskId} turn=${turn} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
    }
  }

  /** The changes of a failed or cancelled pass, closed at once and told. Never throws. */
  async fail(taskId: string, turn: number): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const closed = await failMemoryTurn(db, taskId, turn)
      if (closed.length === 0) return
      const turnId = await this.#turnId(taskId, turn)
      for (const change of closed) await this.#tell(change.kind, 'failed', { taskId, turnId })
    } catch {
      logger?.warn(`memory_changes_fail_failed task=${taskId} turn=${turn}`)
    }
  }

  /**
   * Changes of passes that never ended — lost with their turn — older than `before`: closed failed
   * by the sweep of core. Nothing is told: the pass that would have told is gone. The count.
   */
  async sweep(before: Date): Promise<number> {
    return (await closeStaleMemoryReservations(this.#deps.db, before)).length
  }

  async #turnId(taskId: string, turn: number): Promise<string | null> {
    const row = await this.#deps.db.taskTurn.findFirst({
      where: { taskId, turnNo: turn },
      select: { id: true },
    })
    return row?.id ?? null
  }

  async #one(
    change: PendingMemoryChange,
    memory: { workspaceId: string; userId: string; projectId: string | null },
    conditions: MemoryPassConditions,
    where: { taskId: string; turnId: string | null; turn: number },
  ): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const done = await applyMemoryChange(db, {
        reservationId: change.id,
        taskId: where.taskId,
        turnNo: where.turn,
        memory: {
          workspaceId: memory.workspaceId,
          userId: memory.userId,
          projectId: memory.projectId,
        },
        conditions,
      })
      if (!done) return
      if (done.outcome === 'refused') {
        await this.#tell(done.action, done.reason, where)
        return
      }
      await insertFeedEvent(db, {
        taskId: where.taskId,
        turnId: where.turnId,
        row: {
          type: 'feed.memory_change',
          payload: {
            v: 1,
            action: done.action,
            entryId: done.entryId,
            kind: done.kind,
            text: done.text,
          },
        },
      })
      logger?.log(`memory_changed task=${where.taskId} turn=${where.turn} action=${done.action}`)
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      logger?.warn(`memory_change_failed task=${where.taskId} turn=${where.turn} reason=${code}`)
      await this.#left(change, 'failed', where, 'failed')
    }
  }

  /** A change closed undone, and told. */
  async #left(
    change: Pick<PendingMemoryChange, 'id' | 'kind'>,
    reason: MemoryLeftReason,
    where: { taskId: string; turnId: string | null },
    outcome: 'refused' | 'failed' = 'refused',
  ): Promise<void> {
    try {
      if (!(await refuseMemoryChange(this.#deps.db, change.id, outcome, reason))) return
      await this.#tell(change.kind, reason, where)
    } catch {
      this.#deps.logger?.warn(`memory_change_left_failed task=${where.taskId}`)
    }
  }

  async #tell(
    action: MemoryChangeKind,
    reason: MemoryLeftReason,
    where: { taskId: string; turnId: string | null },
  ): Promise<void> {
    await insertFeedEvent(this.#deps.db, {
      taskId: where.taskId,
      turnId: where.turnId,
      row: { type: 'feed.memory_left', payload: { v: 1, action, reason } },
    })
  }
}
