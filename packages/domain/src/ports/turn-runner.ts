import { z } from 'zod'

import { DomainError, isDomainError, isTooLarge } from '../errors.ts'
import {
  publicationShaSchema,
  type PublicationMetadata,
  type PublicationSource,
} from '../git/publication.ts'
import {
  agentEventSchema,
  agentOutputLimits,
  nativeSessionIdSchema,
  turnResultSchema,
} from './agent-driver.ts'
import { execCursorSchema } from './sandbox-provider.ts'

export const siteLeaseOperations = ['turn', 'deploy', 'revert'] as const
export type SiteLeaseOperation = (typeof siteLeaseOperations)[number]

/** A fenced publication may spend 60s in a native command after core dies; retain 30s cleanup margin. */
export const TURN_PUBLICATION_GRACE_MS = 90_000

/**
 * The turn limit covers publication too: the agent's exec ends this much earlier, leaving time
 * for quiesce, capture, the candidate commit and its secret scan, the snapshot save and push.
 */
export const TURN_FINALIZE_RESERVE_MS = 3 * 60_000

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
  /**
   * The release barrier (docs/plan/53-chat-preview-release.md, Р9): a release whose deploy may
   * still write. While it stands no one acquires the site, expired or not, and the lease is
   * neither released nor freed — the release clears it first, under its own fence.
   */
  inflightReleaseId: string | null
}

/** Every mutation is conditional on the entire fence, never merely the task id. */
export interface SiteLeaseStore {
  /**
   * null while another owner holds the site, an operator holds it, a content write is in flight
   * or a release barrier stands (even under an expired lease).
   */
  acquire(input: Omit<SiteLeaseFence, 'epoch'> & { ttlMs: number }): Promise<SiteLeaseGrant | null>
  /**
   * Turns never renew: one grant covers the hard limit plus TURN_PUBLICATION_GRACE_MS. Kept for
   * long deploy/revert operations (P12, up to 45 minutes), which will renew under their fence.
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

export type TurnWorkspaceSource = PublicationSource

/** A host-owned candidate; its patch includes newly created files. */
export interface TurnPublication {
  baseSha: string
  headSha: string
  patch: Uint8Array
  /** An empty, valid compressed archive: newly created files belong to headSha now. */
  untracked: Uint8Array
  /**
   * The working-set commit of `baseSha` (plan 53, Р11), derived again by publication: the turn
   * and its recovery compare it with the one the sandbox got. Absent without a working set.
   */
  sandboxBaseSha?: string
  /** After the last fence assertion, native publication must be bounded to 60 seconds. */
  publish(assertFence: () => Promise<void>): Promise<void>
  dispose(): Promise<void>
}

/**
 * The base checkout as a git bundle without credentials: objects and the single ref
 * `refs/heads/raditi-base` at `baseSha`. Imported through exec stdin into /workspace/repo on
 * `branch`, after its size and SHA-256 are checked.
 */
export interface TurnBundleSource {
  baseSha: string
  /**
   * With a working set (plan 53, Р11) the single ref points at this root commit instead, and
   * `baseSha` stays the full tree publication starts from. Absent — the bundle is the full tree.
   */
  sandboxBaseSha?: string
  branch: string
  sha256: string
  sizeBytes: number
  read(): AsyncIterable<Uint8Array>
}

export interface TurnWorkspace {
  /**
   * Bundles `expectedBaseSha` for the turn's executor, or with a working set its root commit
   * made at `committedAt` (required then, plan 53, Р11).
   */
  buildBaseBundle(source: TurnWorkspaceSource, committedAt?: string): Promise<TurnBundleSource>
  /**
   * The working-set commit of the source at `committedAt`, the same `buildBaseBundle` puts in the
   * bundle; null without a working set. Recovery of a turn derives it here instead of storing it;
   * a workspace without it cannot recover a turn that has a working set.
   */
  sandboxBase?(source: TurnWorkspaceSource, committedAt: string): Promise<string | null>
  /**
   * `credentials` are the turn's own (turnCredentials): a changed file of the candidate that
   * contains one verbatim, binary ones included, is refused as snapshotHasCredential().
   * Required like protectedPaths, so a caller cannot silently skip the check. `refusedValues`
   * are the values of the client's variables the turn's commands got (docs/plan/53-chat-preview-
   * release.md, Р13): a changed file or path that holds one, in any spelling `envValueForms`
   * knows, is refused as envValueInChange().
   */
  preparePublication(
    input: PublicationMetadata & {
      patch: Uint8Array
      untracked: Uint8Array
      credentials: readonly string[]
      refusedValues?: readonly string[]
    },
  ): Promise<TurnPublication>
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
    candidateHeadSha: publicationShaSchema.optional(),
    baseSha: publicationShaSchema.optional(),
    /**
     * The working-set commit the sandbox was checked out at (plan 53, Р11). The candidate's patch
     * is against `baseSha`, the full tree, with the same paths.
     */
    sandboxBaseSha: publicationShaSchema.optional(),
    committedAt: z.iso.datetime().optional(),
    /** The driver session the turn resumed (turn n−1): recovery derives the session state from it. */
    nativeSessionId: nativeSessionIdSchema.optional(),
    recoveredFromEpoch: z.number().int().positive().optional(),
    /**
     * What a `failed` entry closes the assignment with: `lost` when recovery gave the turn up,
     * never billed (P12). A pass that finds the update lost closes it the same way.
     */
    outcome: z.enum(['failed', 'lost']).optional(),
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
