import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { publicationSourceSchema, type PublicationSource } from '../git/publication.ts'
import { snapshotIdSchema, snapshotReferenceSchema } from '../sessions/snapshot-manifest.ts'
import type {
  SnapshotManifest,
  SnapshotPartName,
  SnapshotReference,
} from '../sessions/snapshot-manifest.ts'
import {
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
  type SandboxLabels,
  type SandboxSpec,
} from './sandbox-provider.ts'
import type { SiteLeaseFence, TurnBundleSource } from './turn-runner.ts'

/**
 * Turn executor port — spec §8. The supervisor in core keeps the lease, the journal, the driver
 * and publication; an executor owns the turn's container. `LocalTurnExecutor` drives a local
 * SandboxProvider (PoC, tests); the remote one sends the same steps to a runner VM over the
 * pull protocol (runner/protocol.ts). An executor never holds platform credentials: S3 objects
 * arrive as presigned requests, data keys and the base bundle through functions of core.
 */
export interface TurnExecutor {
  /** Create the container, import the base bundle, restore turn n−1, write the driver files. */
  prepare(input: TurnPrepareInput, signal: AbortSignal): Promise<TurnExecution>
  /**
   * Take over the container of an unfinished turn after a restart, under the recovered fence.
   * null when the container is missing or not this turn's. `removal` only allows destroy().
   */
  adopt(input: TurnAdoptInput, signal: AbortSignal): Promise<TurnExecution | null>
}

export interface TurnPrepareInput {
  fence: SiteLeaseFence
  /** Without secrets: turn secrets are written only after restore (`prepared.secrets`). */
  sandbox: SandboxSpec
  /** What remains of the whole turn when the step is issued; the container never outlives it. */
  remainingMs: number
  bundle: TurnBundleSource
  restore?: TurnRestoreSource
  /** Selects the stateless event parser on the executor side. */
  driverId: AgentDriverId
  /** Already checked by core (preparedRunSchema, preparedRunExposesSecret). */
  prepared: PreparedFiles
  argv: string[]
  /** turnCredentials(): agent output and captured parts containing one are refused. */
  credentials: readonly string[]
}

/** Turn n−1: the manifest is already checked by core; parts are verified before any write. */
export interface TurnRestoreSource {
  manifest: SnapshotManifest
  parts: Record<SnapshotPartName, PresignedRequest>
  /** The unwrapped data key; the executor zeroes it right after use. */
  dataKey(): Promise<Uint8Array>
}

export type TurnAdoptInput = {
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
       * Omitted only when the executor may still hold them (a runner that outlived core);
       * an executor without them cannot filter output and gives the turn up (exec_lost).
       */
      credentials?: readonly string[]
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
  /** Idempotent; the home archive stays with the executor until seal(). */
  capture(input: { home: SessionState; baseSha: string }): Promise<CapturedTurn>
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

export interface CapturedTurn {
  /** Untrusted until core builds the candidate: the patch against baseSha and new files. */
  patch: Uint8Array
  untracked: Uint8Array
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
}

/**
 * The LiteLLM key and MCP token of one turn (P3, P6). They live in memory only, so a restarted
 * core recovers them here or gives the turn up; P2 has only test implementations.
 */
export interface TurnCredentialSource {
  issue(turn: TurnCredentialRef): Promise<TurnCredentialValues>
  /** null: the running agent's credentials cannot be recovered and the turn is given up. */
  recover(turn: TurnCredentialRef): Promise<TurnCredentialValues | null>
  /** Idempotent; after the turn ends or is given up. */
  revoke(turn: TurnCredentialRef): Promise<void>
}

// --- Turn request and its persisted plan ------------------------------------------------------

export interface TurnRequest {
  sandbox: SandboxSpec
  context: RunContext
  input: TurnInput
  driverVersion: string
  workspace: PublicationSource
  /** Trusted persisted time; retries use the identical value for deterministic publication. */
  committedAt: string
  previous?: SnapshotReference
}

export const turnPlanLimits = Object.freeze({
  prompt: 100_000,
  instructions: 256 * 1024,
  attachments: 100,
  url: 2048,
})

const httpUrl = z.url({ protocol: /^https?$/ }).max(turnPlanLimits.url)

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
 * Strict objects refuse an LLM key or an MCP token instead of silently storing them.
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
        llm: z.object({ baseUrl: httpUrl, model: z.string().min(1).max(200) }).strict(),
        mcp: z.object({ url: httpUrl }).strict(),
        instructions: z.string().max(turnPlanLimits.instructions),
        nativeSessionId: nativeSessionIdSchema.optional(),
      })
      .strict(),
    input: turnInputSchema,
    driverVersion: snapshotReferenceSchema.shape.driver.shape.version,
    workspace: publicationSourceSchema,
    committedAt: z.iso.datetime(),
    previous: snapshotReferenceSchema.optional(),
  })
  .strict()
export type TurnPlan = z.infer<typeof turnPlanSchema>

/** The request without the LLM key and MCP token; refuses anything the plan cannot hold. */
export function toTurnPlan(request: TurnRequest): TurnPlan {
  const { llm, mcp, ...context } = request.context
  const parsed = turnPlanSchema.safeParse({
    ...request,
    context: { ...context, llm: { baseUrl: llm.baseUrl, model: llm.model }, mcp: { url: mcp.url } },
  })
  // Issues name paths only: the request carries credentials and client text.
  if (!parsed.success) throw badRequest('Invalid turn plan')
  return parsed.data
}

export function withTurnCredentials(
  plan: TurnPlan,
  credentials: TurnCredentialValues,
): TurnRequest {
  return {
    ...plan,
    context: {
      ...plan.context,
      llm: { ...plan.context.llm, apiKey: credentials.llmApiKey },
      mcp: { ...plan.context.mcp, token: credentials.mcpToken },
    },
  }
}
