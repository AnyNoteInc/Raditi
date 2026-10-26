import { z } from 'zod'

import { turnSkillsSchema } from '../agent/skills.ts'
import { badRequest } from '../errors.ts'
import { publicationSourceSchema, type PublicationSource } from '../git/publication.ts'
import { snapshotIdSchema, snapshotReferenceSchema } from '../sessions/snapshot-manifest.ts'
import type {
  SnapshotManifest,
  SnapshotPartName,
  SnapshotReference,
} from '../sessions/snapshot-manifest.ts'
import {
  requirementsOf,
  taskRequirementsSchema,
  type TaskRequirements,
} from '../tasks/task-requirements.ts'
import {
  agentDriverIds,
  nativeSessionIdSchema,
  SANDBOX_INBOX,
  type AgentDriverId,
  type AgentEvent,
  type PreparedFiles,
  type RunContext,
  type SessionState,
  type TurnInput,
} from './agent-driver.ts'
import type { PresignedRequest } from './object-storage.ts'
import {
  sandboxSpecSchema,
  type DestroyReason,
  type ExecCursor,
  type ExecExit,
  type SandboxInfo,
  type SandboxLabels,
  type SandboxSpec,
} from './sandbox-provider.ts'
import type { SiteLeaseFence, TurnBundleSource } from './turn-runner.ts'
import { turnCredentialGrantSchema, type TurnCredentialGrant } from './turn-credential-grant.ts'

/** Where a turn's container runs: core's own Docker (PoC, tests) or a runner VM. */
export const turnExecutorKinds = ['local', 'runner'] as const
export type TurnExecutorKind = (typeof turnExecutorKinds)[number]

/**
 * Turn executor port — spec §8. The supervisor in core keeps the lease, the journal, the driver
 * and publication; an executor owns the turn's container. `LocalTurnExecutor` drives a local
 * SandboxProvider (PoC, tests); the remote one sends the same steps to a runner VM over the
 * pull protocol (runner/protocol.ts). An executor never holds platform credentials: S3 objects
 * arrive as presigned requests, data keys and the base bundle through functions of core.
 */
export interface TurnExecutor {
  readonly kind: TurnExecutorKind
  /** Claim a remote assignment and return its trusted VM address before issuing its key. */
  credentialAddress?(assignmentId: string, signal: AbortSignal): Promise<string>
  /** Clear any local claim cache when issuance or prepare ends. Does not release the site. */
  forgetCredentialAddress?(assignmentId: string): void
  /**
   * Create the container, import the base bundle — without one an empty working directory
   * (docs/plan/57-browser-tasks.md, Б4) — restore turn n−1, write the driver files.
   */
  prepare(input: TurnPrepareInput, signal: AbortSignal): Promise<TurnExecution>
  /**
   * Take over the container of an unfinished turn after a restart, under the recovered fence.
   * null when the container is gone; CONFLICT when the container found under `containerId` has
   * other labels. `work` refuses a container that can no longer run the agent (its gateway
   * died) and a turn whose credentials the executor lacks with EXEC_LOST; `removal` reaches
   * such a container too and only allows destroy().
   */
  adopt(input: TurnAdoptInput, signal: AbortSignal): Promise<TurnExecution | null>
  /** Turn containers the executor holds, found by labels: what recovery must adopt or remove. */
  list(filter: Partial<SandboxLabels>): Promise<SandboxInfo[]>
  /**
   * Whether recovery can take an unfinished assignment over now. null while the runner that
   * holds it is away: it may come back before the turn's deadline.
   */
  takeover(assignment: { runner: TurnAssignmentRunner | null }): TurnTakeover | null
  /**
   * The working tree of a running turn against the commit its sandbox was given
   * (docs/plan/53-chat-preview-release.md, Р23): what a preview overlays before an action of the
   * agent's browser. The agent goes on; nothing is stopped or captured. Untrusted like a capture:
   * core validates the archive as `untracked.tar.zst` and every path as a candidate's. An
   * executor without it refuses the sync (NOT_SUPPORTED).
   */
  exportWorkingTree?(input: TurnWorkingTreeInput, signal: AbortSignal): Promise<TurnWorkingTree>
}

export interface TurnWorkingTreeInput {
  /** The open assignment of the turn and its container, as the journal holds them. */
  assignmentId: string
  containerId: string
  labels: SandboxLabels
  /** The commit the sandbox was checked out at: `sandboxBaseSha`, else `expectedBaseSha`. */
  baseSha: string
  /** New files below them are taken even when an ignore file of the site hides them (Р12). */
  addOnlyPaths?: readonly string[]
  /**
   * Paths an earlier export of the same turn wrote: taken as they are now — the agent may have
   * put them back as they were — or listed as deleted when they are gone.
   */
  alsoPaths?: readonly string[]
}

export interface TurnWorkingTree {
  /** A ustar tar in zstd of the changed and new regular files, as `untracked.tar.zst`. */
  archive: Uint8Array
  /** Files of the base the working tree no longer has, and `alsoPaths` that are gone. */
  deletes: string[]
}

/** The runner session an assignment is bound to (TurnAssignment.runner). */
export interface TurnAssignmentRunner {
  id: string
  session: string
}

export interface TurnTakeover {
  /** The runner session the assignment moves to; none for the local executor. */
  runnerSession?: string
  /**
   * The session that launched the agent is still there and filters its output itself: recovery
   * does not send it the credentials again. Core checks the output against them all the same, so
   * recovery takes them from TurnCredentialSource either way, or gives the turn up.
   */
  holdsCredentials: boolean
}

export interface TurnPrepareInput {
  /** The turn's open assignment (TurnAssignmentStore.open): what a runner claims. */
  assignmentId: string
  fence: SiteLeaseFence
  /** Without secrets: turn secrets are written only after restore (`prepared.secrets`). */
  sandbox: SandboxSpec
  /** What remains of the whole turn when the step is issued; the container never outlives it. */
  remainingMs: number
  /**
   * The repository of the turn. Absent for a turn without one (plan 57, Б4): the executor makes
   * SANDBOX_WORKDIR an empty directory — no clone, no `git init`, no commit — and the turn's
   * capture takes `home` alone.
   */
  bundle?: TurnBundleSource
  restore?: TurnRestoreSource
  /** Selects the stateless event parser on the executor side. */
  driverId: AgentDriverId
  /** Already checked by core (preparedRunSchema, preparedRunExposesSecret). */
  prepared: PreparedFiles
  argv: string[]
  /** turnCredentials(): agent output and captured parts containing one are refused. */
  credentials: readonly string[]
  /**
   * The values of the client's variables the run's commands get (runEnvValues; plan 53, Р13):
   * the executor masks them in the agent's output before it is parsed, and refuses a home
   * archive that still holds one. Absent — none.
   */
  envValues?: readonly string[]
  /**
   * Called once the container exists, before the bundle import. From then on the caller owns
   * its removal through this execution, even when prepare fails later; a rejection stops prepare.
   */
  created(execution: TurnExecution): Promise<void>
  /** From now on a container of this prepare may exist: the caller frees the site only with proof. */
  dispatched(): void
  /** Proof that this prepare left no container and never will. May come after the caller gave up. */
  vacated(): void
}

/** Turn n−1: the manifest is already checked by core; parts are verified before any write. */
export interface TurnRestoreSource {
  manifest: SnapshotManifest
  /**
   * Exactly the parts of the manifest (snapshotPartNamesOf): `home` alone in a snapshot without
   * a repository, which restores nothing into the working directory (plan 57, Б4).
   */
  parts: { home: PresignedRequest } & Partial<Record<SnapshotPartName, PresignedRequest>>
  /** The unwrapped data key; the executor zeroes it right after use. */
  dataKey(): Promise<Uint8Array>
}

export type TurnAdoptInput = {
  assignmentId: string
  fence: SiteLeaseFence
  containerId: string
  labels: SandboxLabels
} & (
  | { purpose: 'removal' }
  | {
      purpose: 'work'
      remainingMs: number
      driverId: AgentDriverId
      /**
       * turnCredentials() of the run, recovered by core: output that contains one is refused.
       * An executor without them cannot filter output and gives the turn up (exec_lost).
       */
      credentials: readonly string[]
      /**
       * The executor still holds them (TurnTakeover.holdsCredentials): core checks the output
       * against them itself and does not send them again.
       */
      holdsCredentials?: boolean
      /** As TurnPrepareInput.envValues; sent again only with the credentials. */
      envValues?: readonly string[]
    }
)

export interface TurnExecution {
  readonly containerId: string
  /** Start the agent; the caller asserted its fence right before. */
  launch(timeoutMs: number): Promise<TurnAgentExec>
  /** Re-attach to the agent's exec from the journal state; null when the exec is lost. */
  attach(from: TurnAttachState): Promise<TurnAgentExec | null>
  /** Stop the agent's processes; idempotent. */
  quiesce(): Promise<void>
  /**
   * Idempotent; the home archive stays with the executor until seal(). The patch is taken
   * against `sandboxBaseSha` when the sandbox got a working set (plan 53, Р11), else `baseSha`.
   * New files below `addOnlyPaths` (Р12) are taken even when an ignore file hides them.
   * Without `baseSha` — a turn without a repository (plan 57, Б4) — only `home` is taken: the
   * working directory is not read, and the result has neither `patch` nor `untracked`.
   * `sandboxBaseSha` and `addOnlyPaths` come only with `baseSha`. An executor refuses a capture
   * whose `baseSha` disagrees with its prepare: with one after a prepare without a bundle, or
   * without one after a prepare with a bundle.
   */
  capture(input: {
    home: SessionState
    baseSha?: string
    sandboxBaseSha?: string
    addOnlyPaths?: readonly string[]
  }): Promise<CapturedTurn>
  /** Encrypt the captured home archive and store it with a create-only presigned PUT. */
  seal(input: TurnSealInput): Promise<SealedTurnPart>
  destroy(reason: DestroyReason): Promise<void>
}

export interface TurnAttachState {
  execId: string
  cursor: ExecCursor
  /** Events already journaled: the per-turn event limit spans the reconnect. */
  eventCount: number
}

/** Only complete stdout lines move the cursor; the journal acknowledges it with the events. */
export interface TurnOutputBatch {
  from: ExecCursor
  to: ExecCursor
  events: AgentEvent[]
}

export interface TurnAgentExec {
  readonly execId: string
  /**
   * Resolves once the output ended. The next batch is read only after `record` resolved, so a
   * durable cursor never runs ahead of the journal; a rejection stops reading.
   */
  output(record: (batch: TurnOutputBatch) => Promise<void>): Promise<void>
  wait(): Promise<ExecExit>
  kill(): Promise<void>
}

/**
 * `patch` and `untracked` are there exactly when the capture had a `baseSha`: a turn without a
 * repository (plan 57, Б4) has neither, and its snapshot is the home part alone.
 */
export interface CapturedTurn {
  /** Untrusted until core builds the candidate: the patch against baseSha and new files. */
  patch?: Uint8Array
  untracked?: Uint8Array
  /** The sealed home part has exactly this size: AES-GCM adds no padding. */
  homeBytes: number
}

export interface TurnSealInput {
  /** Snapshot metadata bound into the AAD, including the candidate headSha and createdAt. */
  base: Omit<SnapshotManifest, 'parts'>
  dataKey(): Promise<Uint8Array>
  put: PresignedRequest
}

export interface SealedTurnPart {
  sha256: string
  sizeBytes: number
  iv: string
  tag: string
}

// --- Turn credentials -------------------------------------------------------------------------

export interface TurnCredentialRef {
  taskId: string
  sessionId: string
  turn: number
  epoch: number
}

export interface TurnCredentialValues {
  llmApiKey: string
  mcpToken: string
  /**
   * The client's variables the agent's commands may use (docs/plan/53-chat-preview-release.md,
   * Р13), by name: only those with `to_agent`. The driver writes them to a file in tmpfs that
   * the shell of its command tool reads through BASH_ENV; the agent process never gets them.
   * Absent — none.
   */
  envValues?: Readonly<Record<string, string>>
}

/**
 * The subscription gateway key and MCP token of one turn (P3, P6). They live in memory only, so a restarted
 * core recovers them here or gives the turn up; P2 has only test implementations.
 */
export interface TurnCredentialSource {
  issue(turn: TurnCredentialRef, grant: TurnCredentialGrant): Promise<TurnCredentialValues>
  /** null: the running agent's credentials cannot be recovered and the turn is given up. */
  recover(turn: TurnCredentialRef): Promise<TurnCredentialValues | null>
  /** Idempotent; after the turn ends or is given up. */
  revoke(turn: TurnCredentialRef): Promise<void>
  /**
   * The current values of every variable of the turn's site, whatever their recipients and the
   * version the turn got (plan 53, Р13): a value the client changed since — one the preview may
   * show the agent — is refused in the candidate as well. Absent — the source keeps none.
   */
  siteValues?(turn: TurnCredentialRef): Promise<string[]>
}

// --- Turn request and its persisted plan ------------------------------------------------------

export interface TurnRequest {
  sandbox: SandboxSpec
  context: RunContext
  input: TurnInput
  driverVersion: string
  /**
   * What the turn's environment needs (docs/plan/57-browser-tasks.md, Б3). Absent in requests
   * and plans written before it: a repository alone (requirementsOf).
   */
  requirements?: TaskRequirements
  /** Present exactly when the turn has a repository. */
  workspace?: PublicationSource
  /** Trusted persisted time; retries use the identical value for deterministic publication. */
  committedAt: string
  previous?: SnapshotReference
  /**
   * Trusted user action: replace the latest run, restoring its input checkpoint after undo.
   * Only with a repository: what a turn without one did on the site is not undone (plan 57, Б1).
   */
  replacesTurn?: number
  /**
   * The first turn after «Обновить» moved the dialog onto a new `main`
   * (docs/plan/53-chat-preview-release.md, Р27): a new session of the agent, no previous
   * snapshot is restored; the feed keeps its history. Only with a repository.
   */
  rebased?: boolean
}

/**
 * The supervisor installs issued values after opening the assignment; callers carry no key and
 * no value of a client's variable.
 */
export type UnkeyedTurnRequest = Omit<TurnRequest, 'context'> & {
  context: Omit<RunContext, 'llm' | 'mcp' | 'envValues'> & {
    llm: Omit<RunContext['llm'], 'apiKey'>
    mcp: Omit<RunContext['mcp'], 'token'>
  }
}

export function withoutTurnCredentials(request: TurnRequest): UnkeyedTurnRequest {
  const { apiKey: _key, ...llm } = request.context.llm
  const { token: _token, ...mcp } = request.context.mcp
  const { envValues: _values, ...context } = request.context
  return { ...request, context: { ...context, llm, mcp } }
}

export const turnPlanLimits = Object.freeze({
  prompt: 100_000,
  instructions: 256 * 1024,
  attachments: 100,
  url: 2048,
})

/** A credential inside the URL would be kept in turn_assignments.plan: only the address. */
const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(turnPlanLimits.url)
  .refine((url) => {
    const parsed = URL.parse(url)
    return parsed !== null && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
  }, 'expected a URL without credentials, query or fragment')

const inboxPath = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path.startsWith(`${SANDBOX_INBOX}/`) &&
      ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
      path
        .slice(1)
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    `expected a normalized path under ${SANDBOX_INBOX}`,
  )

export const turnInputSchema = z
  .object({
    prompt: z.string().min(1).max(turnPlanLimits.prompt),
    attachments: z.array(inboxPath).max(turnPlanLimits.attachments),
  })
  .strict() satisfies z.ZodType<TurnInput>

/**
 * A TurnRequest without its credentials, as turn_assignments.plan keeps it for recovery.
 * Strict objects refuse an LLM key or an MCP token instead of silently storing them. A plan
 * stored before the requirements has a workspace and no `requirements`: a repository turn.
 */
export const turnPlanSchema = z
  .object({
    sandbox: sandboxSpecSchema.refine(
      (spec) => spec.secrets.length === 0,
      'turn secrets are installed only after restore',
    ),
    context: z
      .object({
        taskId: snapshotIdSchema,
        sessionId: snapshotIdSchema,
        turn: z.number().int().positive().max(999_999),
        llm: z
          .object({
            baseUrl: httpUrl,
            model: z.string().min(1).max(200),
            reasoningEffort: turnCredentialGrantSchema.shape.reasoningEffort.optional(),
          })
          .strict(),
        mcp: z.object({ url: httpUrl }).strict(),
        instructions: z.string().max(turnPlanLimits.instructions),
        nativeSessionId: nativeSessionIdSchema.optional(),
        /** The address only (plan 53, Р13); the values of the variables are never kept here. */
        egressProxy: httpUrl.optional(),
        internet: z.literal(true).optional(),
        skills: turnSkillsSchema.optional(),
      })
      .strict()
      .refine(
        (context) =>
          (context.internet === undefined || context.egressProxy !== undefined) &&
          (context.skills === undefined || context.internet === true),
        'the open internet goes through the egress proxy, and skills need it',
      ),
    input: turnInputSchema,
    /** Recovery picks the driver of the turn by it: extractResult, sessionState, the parser. */
    driverId: z.enum(agentDriverIds),
    driverVersion: snapshotReferenceSchema.shape.driver.shape.version,
    requirements: taskRequirementsSchema.optional(),
    workspace: publicationSourceSchema.optional(),
    committedAt: z.iso.datetime(),
    previous: snapshotReferenceSchema.optional(),
    replacesTurn: z.number().int().positive().max(999_999).optional(),
    rebased: z.boolean().optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const { repository } = requirementsOf(plan)
    if (repository !== (plan.workspace !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['workspace'],
        message: repository
          ? 'a turn with a repository needs its workspace'
          : 'a turn without a repository has no workspace',
      })
    // Both are git notions: a replacement undoes content of the previous turn, a rebased start
    // follows «Обновить» onto a new `main`.
    if (!repository)
      for (const key of ['replacesTurn', 'rebased'] as const)
        if (plan[key] !== undefined)
          ctx.addIssue({ code: 'custom', path: [key], message: 'only a turn with a repository' })
  })
export type TurnPlan = z.infer<typeof turnPlanSchema>

/** The request without the LLM key and MCP token; refuses anything the plan cannot hold. */
export function toTurnPlan(
  request: TurnRequest | UnkeyedTurnRequest,
  driverId: AgentDriverId,
): TurnPlan {
  const { llm, mcp, ...context } = request.context
  const parsed = turnPlanSchema.safeParse({
    ...request,
    driverId,
    context: {
      ...context,
      llm: {
        baseUrl: llm.baseUrl,
        model: llm.model,
        ...(llm.reasoningEffort !== undefined ? { reasoningEffort: llm.reasoningEffort } : {}),
      },
      mcp: { url: mcp.url },
    },
  })
  // Issues name paths only: the request carries credentials and client text.
  if (!parsed.success) throw badRequest('Invalid turn plan')
  return parsed.data
}

export function withTurnCredentials(
  plan: TurnPlan,
  credentials: TurnCredentialValues,
): TurnRequest {
  const { driverId: _driverId, ...request } = plan
  const envValues = credentials.envValues ?? {}
  return {
    ...request,
    context: {
      ...plan.context,
      llm: { ...plan.context.llm, apiKey: credentials.llmApiKey },
      mcp: { ...plan.context.mcp, token: credentials.mcpToken },
      ...(Object.keys(envValues).length ? { envValues: { ...envValues } } : {}),
    },
  }
}
