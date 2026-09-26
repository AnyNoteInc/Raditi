import type { AgentEvent, TurnResult } from './agent-driver.ts'
import type { RepoRef } from './git-provider.ts'
import type { ExecCursor, Sandbox } from './sandbox-provider.ts'

export type SiteLeaseOperation = 'turn' | 'deploy' | 'revert'

/** A fenced publication may spend 60s in a native command after core dies; retain 30s cleanup margin. */
export const TURN_PUBLICATION_GRACE_MS = 90_000

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
  acquire(input: Omit<SiteLeaseFence, 'epoch'> & { ttlMs: number }): Promise<SiteLeaseGrant | null>
  renew(fence: SiteLeaseFence, ttlMs: number): Promise<SiteLeaseGrant | null>
  assert(fence: SiteLeaseFence): Promise<boolean>
  release(fence: SiteLeaseFence): Promise<boolean>
  inspect(siteId: string): Promise<SiteLeaseAuthority | null>
  /** Preserve an ambiguous write for reconciliation; never clear it on a timeout alone. */
  holdForRecovery(fence: SiteLeaseFence): Promise<boolean>
  /** Explicit recovery only: a held exact epoch becomes a new fenced owner. */
  reclaimForRecovery(fence: SiteLeaseFence, ttlMs: number): Promise<SiteLeaseGrant | null>
}

export interface TurnWorkspaceSource {
  repo: RepoRef
  branch: string
  expectedBaseSha: string
  protectedPaths?: string[]
}

/** A host-owned candidate; its patch includes newly created files. */
export interface TurnPublication {
  baseSha: string
  headSha: string
  patch: Uint8Array
  /** An empty, valid compressed archive: newly created files belong to headSha now. */
  untracked: Uint8Array
  /** After the last fence assertion, native publication must be bounded to 60 seconds. */
  publish(assertFence: () => Promise<void>): Promise<void>
  dispose(): Promise<void>
}

export interface TurnWorkspace {
  prepareWorkspace(sandbox: Sandbox, source: TurnWorkspaceSource): Promise<void>
  preparePublication(
    input: TurnWorkspaceSource & {
      taskId: string
      turn: number
      createdAt: string
      patch: Uint8Array
      untracked: Uint8Array
    },
  ): Promise<TurnPublication>
}

export const turnPhases = [
  'leased',
  'created',
  'restored',
  'running',
  'output',
  'quiesced',
  'checkpointing',
  'checkpointed',
  'destroyed',
  'publishing',
  'completed',
  'publication_recovered',
  'failed',
  'recovery',
] as const
export type TurnPhase = (typeof turnPhases)[number]

/** Bounded operational evidence, with no prepared configs, credentials or raw error strings. */
export interface TurnEvidence {
  fence: SiteLeaseFence
  sessionId: string
  turn: number
  sequence: number
  phase: TurnPhase
  containerId?: string
  execId?: string
  cursor?: ExecCursor
  events?: AgentEvent[]
  snapshotPrefix?: string
  candidateHeadSha?: string
  baseSha?: string
  committedAt?: string
  recoveredFromEpoch?: number
  result?: TurnResult
  reason?:
    | 'cancelled'
    | 'timeout'
    | 'lease_lost'
    | 'run_failed'
    | 'snapshot_ambiguous'
    | 'publication_ambiguous'
    | 'destroy_failed'
    | 'journal_failed'
}

/** The caller must supply durable storage; there is no in-memory production fallback. */
export interface TurnJournal {
  record(evidence: TurnEvidence): Promise<void>
}
