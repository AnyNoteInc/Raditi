import { z } from 'zod'

import { DomainError, isDomainError, isTooLarge } from '../errors.ts'
import {
  agentEventSchema,
  agentOutputLimits,
  nativeSessionIdSchema,
  turnResultSchema,
} from './agent-driver.ts'
import { execCursorSchema, execExitSchema } from './sandbox-provider.ts'

export const siteLeaseOperations = ['turn'] as const
export type SiteLeaseOperation = (typeof siteLeaseOperations)[number]

/**
 * The row of `site_leases` the turns of a chat are fenced by — what `site_id` holds in
 * `turn_assignments`, `SiteLeaseFence` and the labels of a turn — and the scope its contact maps
 * are kept under: the chat itself. The name of the table and of its key stays from the leases of
 * sites, which went with projects (docs/plan/83-remove-projects.md, БП6).
 */
export const leaseScopeOf = (task: { id: string }): string => task.id

/** The same row for a turn, its `/undo` and its `/redo`. */
export const turnLeaseOf = (task: { id: string }): string => leaseScopeOf(task)

/** A fenced publication may spend 60s in a native command after core dies; retain 30s cleanup margin. */
export const TURN_PUBLICATION_GRACE_MS = 90_000

/**
 * A turn has no time limit (docs/plan/70-turn-without-time-limit.md, ВР1): it lives while its
 * supervisor renews it. One renewal grants this much — the lease, the assignment's deadline, the
 * turn's keys and its container's lease — so a turn whose supervisor died is gone this long
 * after its last renewal. Longer than the publication grace: a push started before the death
 * still ends under the fence.
 */
export const TURN_LEASE_TTL_MS = 3 * 60_000

/** How often a live supervisor renews its turn (TURN_LEASE_TTL_MS). */
export const TURN_RENEW_INTERVAL_MS = 30_000

/**
 * What the steps after the agent may take together — quiesce, capture, the candidate commit and
 * its secret scan, the snapshot save and push. The agent has no time limit; these platform steps
 * do (docs/plan/70-turn-without-time-limit.md, ВР7): a save or a push that never answers does not
 * keep the turn for good.
 */
export const TURN_FINALIZE_MS = 3 * 60_000

/** Another operation owns the site. */
export const siteBusy = (): DomainError =>
  new DomainError('SITE_BUSY', 'The site is already running an operation', 409)

/** The site waits for an operator after an ambiguous write: retrying does not help. */
export const siteHeld = (): DomainError =>
  new DomainError('SITE_HELD', 'The site is held for operator recovery', 409)

const SNAPSHOT_CREDENTIAL = 'snapshot_credential'

/**
 * A captured snapshot part contains a turn credential (the LLM key, the MCP token or a secret
 * file's value). Nothing is written and the site is released; the value is never reported.
 */
export const snapshotHasCredential = (): DomainError =>
  new DomainError(
    'SNAPSHOT_NOT_WRITTEN',
    'Snapshot contains a turn credential; nothing was written',
    502,
    { reason: SNAPSHOT_CREDENTIAL },
  )

export function isSnapshotCredential(error: unknown): error is DomainError {
  return (
    isDomainError(error) &&
    error.code === 'SNAPSHOT_NOT_WRITTEN' &&
    (error.details as { reason?: unknown } | undefined)?.reason === SNAPSHOT_CREDENTIAL
  )
}

/** A fenced write found that this owner no longer holds its site lease. */
export const leaseLost = (message = 'Site lease is no longer owned'): DomainError =>
  new DomainError('LEASE_LOST', message, 409)

/** The agent's exec or container of a recovered turn is missing or foreign: it is given up. */
export const execLost = (message = 'The agent process of the turn was lost'): DomainError =>
  new DomainError('EXEC_LOST', message, 502)

/**
 * A snapshot save that failed this way wrote nothing: its checks, Vault or sealing failed, or
 * it stopped before its reservation. The site is released and the turn may be retried.
 */
export function snapshotSaveWroteNothing(error: unknown): boolean {
  return isDomainError(error) && (error.code === 'SNAPSHOT_NOT_WRITTEN' || isTooLarge(error))
}

export interface SiteLeaseFence {
  siteId: string
  taskId: string
  operation: SiteLeaseOperation
  epoch: number
}

/** The DB clock accompanies expiry so callers never assume synchronized host clocks. */
export interface SiteLeaseGrant extends SiteLeaseFence {
  expiresAt: Date
  serverNow: Date
}

export interface SiteLeaseAuthority {
  siteId: string
  taskId: string | null
  operation: SiteLeaseOperation | null
  epoch: number
  expiresAt: Date | null
  serverNow: Date
  heldForOperator: boolean
}

/** Every mutation is conditional on the entire fence, never merely the task id. */
export interface SiteLeaseStore {
  /**
   * null while another owner holds the lease or an operator holds it (even under an expired
   * lease).
   */
  acquire(input: Omit<SiteLeaseFence, 'epoch'> & { ttlMs: number }): Promise<SiteLeaseGrant | null>
  /**
   * Moves the expiry of a live lease to `ttlMs` from now, under its whole fence; null when the
   * fence no longer owns it. Turns renew through TurnAssignmentStore.renewTurn, which moves their
   * assignment and keys in the same statement (TURN_LEASE_TTL_MS).
   */
  renew(fence: SiteLeaseFence, ttlMs: number): Promise<SiteLeaseGrant | null>
  assert(fence: SiteLeaseFence): Promise<boolean>
  release(fence: SiteLeaseFence): Promise<boolean>
  inspect(siteId: string): Promise<SiteLeaseAuthority | null>
  /**
   * Preserve an ambiguous write for reconciliation; never clear it on a timeout alone. Recovery
   * moves a held epoch on only with its assignment (TurnAssignmentStore.takeOver).
   */
  holdForRecovery(fence: SiteLeaseFence): Promise<boolean>
  /**
   * Recovery only, with proof that the turn's container is gone or its deadline passed: frees the
   * exact epoch, held or expired alike, in one statement. false when another owner has the site.
   */
  free(fence: SiteLeaseFence): Promise<boolean>
}

export const turnPhases = [
  'leased',
  'created',
  'restored',
  'running',
  'output',
  /** A recovered owner re-attached to the agent's exec from the journal cursor (recoveredFromEpoch). */
  'resumed',
  'quiesced',
  'checkpointing',
  'checkpointed',
  'destroyed',
  'publishing',
  'completed',
  'publication_recovered',
  /**
   * Recovery finished the checkpoint of a turn without a repository
   * (docs/plan/57-browser-tasks.md, Б6): its containers are removed and its manifest is the one
   * stored. Such a turn has no candidate and no publication; it ends `completed`.
   */
  'checkpoint_recovered',
  'failed',
  'recovery',
  /**
   * The owner gave the turn up without proof that the container of its prepare is gone: the
   * lease is neither released nor held, it expires by itself (spec §8).
   */
  'vacating',
] as const
export type TurnPhase = (typeof turnPhases)[number]

const evidenceId = z.uuid()

/** A full git SHA of history entries (turns with a repository, before plan 83). */
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/)

/** Strips other keys: a SiteLeaseGrant's expiry and server clock are not part of the fence. */
export const siteLeaseFenceSchema = z.object({
  siteId: evidenceId,
  taskId: evidenceId,
  operation: z.enum(siteLeaseOperations),
  epoch: z.number().int().positive(),
}) satisfies z.ZodType<SiteLeaseFence>

const evidenceTextId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

/** Bounded operational evidence, with no prepared configs, credentials or raw error strings. */
export const turnEvidenceSchema = z
  .object({
    fence: siteLeaseFenceSchema,
    sessionId: evidenceTextId,
    turn: z.number().int().positive().max(999_999),
    sequence: z.number().int().positive().max(1_000_000),
    phase: z.enum(turnPhases),
    containerId: evidenceTextId.optional(),
    execId: evidenceTextId.optional(),
    cursor: execCursorSchema.optional(),
    events: z.array(agentEventSchema).max(agentOutputLimits.turnEvents).optional(),
    snapshotPrefix: z
      .string()
      .max(256)
      .regex(/^sessions\/[A-Za-z0-9_-]+\/turns\/[0-9]+\/$/)
      .optional(),
    // History: the candidate and base of a turn with a repository, before plan 83.
    candidateHeadSha: gitShaSchema.optional(),
    baseSha: gitShaSchema.optional(),
    /**
     * The working-set commit the sandbox was checked out at (plan 53, Р11). The candidate's patch
     * is against `baseSha`, the full tree, with the same paths.
     */
    sandboxBaseSha: gitShaSchema.optional(),
    committedAt: z.iso.datetime().optional(),
    /** The driver session the turn resumed (turn n−1): recovery derives the session state from it. */
    nativeSessionId: nativeSessionIdSchema.optional(),
    recoveredFromEpoch: z.number().int().positive().optional(),
    /**
     * What a `failed` entry closes the assignment with: `lost` when recovery gave the turn up,
     * never billed (P12). A pass that finds the update lost closes it the same way.
     */
    outcome: z.enum(['failed', 'lost']).optional(),
    /**
     * How the agent's exec ended, on the `failed` entry of a turn whose agent did not finish: a
     * code and a fixed reason, never its output.
     */
    exit: execExitSchema.optional(),
    result: turnResultSchema.optional(),
    reason: z
      .enum([
        'cancelled',
        'timeout',
        'lease_lost',
        'run_failed',
        'snapshot_ambiguous',
        'snapshot_credential',
        'publication_ambiguous',
        'destroy_failed',
        // Recovery found the agent's exec or container missing or foreign: the turn is given up.
        'exec_lost',
        // A checkpoint waits to be published until its runner is back or the deadline and grace
        // passed: its container's removal is not confirmed yet.
        'awaiting_runner',
      ])
      .optional(),
  })
  .strict()
export type TurnEvidence = z.input<typeof turnEvidenceSchema>

/** The caller must supply durable storage; there is no in-memory production fallback. */
export interface TurnJournal {
  record(evidence: TurnEvidence): Promise<void>
}
