import { z } from 'zod'

import { turnSkillsSchema } from '../agent/skills.ts'
import { attachmentLimits } from '../attachments/rules.ts'
import { badRequest } from '../errors.ts'
import { snapshotIdSchema, snapshotReferenceSchema } from '../sessions/snapshot-manifest.ts'
import type { SnapshotManifest, SnapshotReference } from '../sessions/snapshot-manifest.ts'
import { taskRequirementsSchema, type TaskRequirements } from '../tasks/task-requirements.ts'
import {
  agentDriverIds,
  nativeSessionIdSchema,
  SANDBOX_INBOX,
  turnActions,
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
import type { SiteLeaseFence } from './turn-runner.ts'
import {
  turnCredentialGrantSchema,
  type TurnCredentialGrant,
  type TurnCredentialPolicy,
} from './turn-credential-grant.ts'

/** Where a turn's container runs: core's own Docker (PoC, tests) or a runner VM. */
export const turnExecutorKinds = ['local', 'runner'] as const
export type TurnExecutorKind = (typeof turnExecutorKinds)[number]

/**
 * Turn executor port — spec §8. The supervisor in core keeps the lease, the journal and the
 * driver; an executor owns the turn's container. `LocalTurnExecutor` drives a local
 * SandboxProvider (PoC, tests); the remote one sends the same steps to a runner VM over the
 * pull protocol (runner/protocol.ts). An executor never holds platform credentials: S3 objects
 * arrive as presigned requests, data keys through functions of core. A turn has no repository
 * (docs/plan/83-remove-projects.md): its working directory is empty.
 */
export interface TurnExecutor {
  readonly kind: TurnExecutorKind
  /** Claim a remote assignment and return its trusted VM address before issuing its key. */
  credentialAddress?(assignmentId: string, signal: AbortSignal): Promise<string>
  /** Clear any local claim cache when issuance or prepare ends. Does not release the site. */
  forgetCredentialAddress?(assignmentId: string): void
  /**
   * How many turns it can run at once now, the running ones included: for runner VMs the places
   * their runners report (docs/plan/70-turn-without-time-limit.md, ВР17). Absent — any number.
   */
  slots?(): number
  /**
   * Create the container with an empty working directory, restore turn n−1, put the client's
   * files, write the driver files.
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
  /**
   * The first lease of the container when the step is issued; the turn extends it while it lives
   * (TurnExecution.extend), and the container never outlives its last lease.
   */
  remainingMs: number
  restore?: TurnRestoreSource
  /**
   * The files the client sent with the task, as the plan names them (`input.attachments`): the
   * executor writes each at its path, read-only, after the restore (turnMayHoldInbox,
   * assertTurnInbox); absent — none.
   */
  inbox?: readonly TurnInboxFile[]
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
   * Called once the container exists, before the restore. From then on the caller owns
   * its removal through this execution, even when prepare fails later; a rejection stops prepare.
   */
  created(execution: TurnExecution): Promise<void>
  /** From now on a container of this prepare may exist: the caller frees the site only with proof. */
  dispatched(): void
  /** Proof that this prepare left no container and never will. May come after the caller gave up. */
  vacated(): void
}

/**
 * Turn n−1: the manifest is already checked by core; its part is verified before any write. Only
 * `home` is restored: a snapshot of a chat that had a project (before plan 83) also names a patch
 * and new files of its working copy, which a turn without a repository has no place for — they
 * stay in S3 and are not fetched; the home part opens under the manifest's AAD as before.
 */
export interface TurnRestoreSource {
  manifest: SnapshotManifest
  parts: { home: PresignedRequest }
  /** The unwrapped data key; the executor zeroes it right after use. */
  dataKey(): Promise<Uint8Array>
}

/**
 * A file the client sent with the task, as the host puts it into a turn (spec §8, «Подготовка»): at `path` (turnInboxPath), read-only for the agent. Never a key or an
 * address of the object: core reads it from the inbox, a runner fetches it from core.
 */
export interface TurnInboxFile {
  path: string
  sizeBytes: number
  /** The file's bytes; a body longer or shorter than `sizeBytes` is refused. */
  read(): AsyncIterable<Uint8Array>
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
  /**
   * Start the agent; the caller asserted its fence right before. The agent has no time limit
   * (docs/plan/70-turn-without-time-limit.md, ВР1): it runs until it ends, is killed or loses
   * its container.
   */
  launch(): Promise<TurnAgentExec>
  /**
   * The turn was renewed: its container and the gateway of its attempt live `remainingMs` from
   * now (TURN_LEASE_TTL_MS plus the publication grace), never less than before (ВР4, ВР5).
   */
  extend(remainingMs: number): Promise<void>
  /** Re-attach to the agent's exec from the journal state; null when the exec is lost. */
  attach(from: TurnAttachState): Promise<TurnAgentExec | null>
  /** Stop the agent's processes; idempotent. */
  quiesce(): Promise<void>
  /**
   * Idempotent; the home archive stays with the executor until seal(). Only `home` is taken: the
   * working directory is not read (a turn has no repository).
   */
  capture(input: { home: SessionState }): Promise<CapturedTurn>
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

/** What a capture took: the home part alone — the snapshot of a turn is that part. */
export interface CapturedTurn {
  /** The sealed home part has exactly this size: AES-GCM adds no padding. */
  homeBytes: number
  /**
   * The files the agent left for the client in SANDBOX_OUT (docs/plan/66-chat-visuals.md, В8):
   * a ustar archive in zstd, checked where it was taken; untrusted until core reads it again.
   * Absent when the folder was empty or its files were dropped. Never a part of the snapshot.
   */
  outbox?: Uint8Array
}

export interface TurnSealInput {
  /** Snapshot metadata bound into the AAD, including createdAt. */
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
  /**
   * Whether the pool would give the task's next turn a key, asked before the turn holds a lease
   * or an assignment: it writes nothing and throws only the pool's refusals (SUBSCRIPTION_BUSY,
   * SUBSCRIPTION_WAIT, SUBSCRIPTION_OPERATOR_REQUIRED). `issue` still decides under the lease.
   * Absent — the source has no pool to ask.
   */
  admit?(taskId: string, policy: TurnCredentialPolicy): Promise<void>
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
   * What the turn's environment needs (docs/plan/57-browser-tasks.md, Б3): never a repository.
   * Absent — nothing (requirementsOf).
   */
  requirements?: TaskRequirements
  /** Trusted persisted time; retries use the identical value. */
  committedAt: string
  previous?: SnapshotReference
  /**
   * The turn before it was undone (`/undo`, docs/plan/61-chats-first.md, §5.14): the session goes
   * back to the checkpoint that turn started from.
   */
  rewound?: true
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

/** A path of the plan's `input.attachments`: normalized, under SANDBOX_INBOX. */
export const turnInboxPathSchema = z
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
    attachments: z.array(turnInboxPathSchema).max(turnPlanLimits.attachments),
    action: z.enum(turnActions).optional(),
  })
  .strict() satisfies z.ZodType<TurnInput>

/**
 * What one turn gets of the files of its task: the latest, at most this many and this many
 * bytes together. A full message (ten files of 20 MiB) always fits in the 512 MiB tmpfs of
 * /workspace.
 */
export const turnInboxLimits = Object.freeze({
  files: 50,
  bytes: attachmentLimits.perMessage * attachmentLimits.fileBytes,
})

const inboxId = z.uuid()

/**
 * Where the host puts a file of the client: its own folder, named by the attachment's id, holds
 * it under the name the client gave it (already cleaned: no separator, no control character).
 * null when the path would not pass the plan's rule.
 */
export function turnInboxPath(attachmentId: string, fileName: string): string | null {
  if (!inboxId.safeParse(attachmentId).success || fileName.includes('/')) return null
  const path = `${SANDBOX_INBOX}/${attachmentId.toLowerCase()}/${fileName}`
  return turnInboxPathSchema.safeParse(path).success ? path : null
}

/** The attachment a path of turnInboxPath() names; null for any other path. */
export function turnInboxAttachmentId(path: string): string | null {
  const [id, name, ...rest] = path.startsWith(`${SANDBOX_INBOX}/`)
    ? path.slice(SANDBOX_INBOX.length + 1).split('/')
    : []
  if (id === undefined || name === undefined || rest.length > 0) return null
  return turnInboxPath(id, name) === path ? id : null
}

/**
 * Whether the sandbox of a turn may hold the client's files: the turn of a chat, whose lease is
 * its own id (`leaseScopeOf`, docs/plan/61-chats-first.md, К14, К16). The labels are the second
 * line against a planner that names another lease.
 */
export const turnMayHoldInbox = (labels: Pick<SandboxLabels, 'siteId' | 'taskId'>): boolean =>
  labels.siteId === labels.taskId

/**
 * The files of a prepare, as both executors and the runner protocol take them: only a turn
 * turnMayHoldInbox() lets hold them, each at a path of turnInboxPath() once, each of a file's
 * size, all within turnInboxLimits.
 */
export function assertTurnInbox(
  files: readonly Pick<TurnInboxFile, 'path' | 'sizeBytes'>[],
  mayHold: boolean,
): void {
  if (files.length === 0) return
  if (!mayHold) throw badRequest('Files of the client go only to the turn of their chat')
  if (files.length > turnInboxLimits.files) throw badRequest('Too many files for one turn')
  let bytes = 0
  const paths = new Set<string>()
  for (const file of files) {
    if (turnInboxAttachmentId(file.path) === null || paths.has(file.path))
      throw badRequest('Invalid path of a file of the client')
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 1 ||
      file.sizeBytes > attachmentLimits.fileBytes
    )
      throw badRequest('Invalid size of a file of the client')
    paths.add(file.path)
    bytes += file.sizeBytes
  }
  if (bytes > turnInboxLimits.bytes) throw badRequest('Files of the client too large for one turn')
}

/**
 * A TurnRequest without its credentials, as turn_assignments.plan keeps it for recovery.
 * Strict objects refuse an LLM key or an MCP token instead of silently storing them. A plan of a
 * turn with a repository (before plan 83: `workspace`, `replacesTurn`, `rebased`) is refused.
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
    requirements: taskRequirementsSchema
      .refine((r) => !r.repository, 'a turn has no repository')
      .optional(),
    committedAt: z.iso.datetime(),
    previous: snapshotReferenceSchema.optional(),
    rewound: z.literal(true).optional(),
  })
  .strict()
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
