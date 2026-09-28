import { z } from 'zod'

import {
  conflict,
  DomainError,
  driverPrepareInvalid,
  isDomainError,
  publicationTooLarge,
  repositoryTooLarge,
  repositoryUnsupported,
  sandboxCommandFailed,
  snapshotTooLarge,
  turnOutputRejected,
  turnOutputTooLarge,
} from '../errors.ts'
import {
  publicationLimits,
  publicationShaSchema,
  publicationSourceSchema,
} from '../git/publication.ts'
import { sessionStateSchema, snapshotLimits } from '../sessions/session-state.ts'
import {
  SNAPSHOT_SCHEMA_VERSION,
  snapshotManifestSchema,
  snapshotMetadataSchema,
} from '../sessions/snapshot-manifest.ts'
import {
  agentDriverIds,
  agentEventSchema,
  agentOutputLimits,
  preparedFilesSchema,
  preparedRunLimits,
} from '../ports/agent-driver.ts'
import {
  execCursorSchema,
  execSpecSchema,
  MAX_SANDBOX_TURN_MS,
  sandboxLabelsSchema,
  sandboxSpecSchema,
  type DestroyReason,
  type ExecExit,
} from '../ports/sandbox-provider.ts'
import { execLost, siteLeaseFenceSchema, snapshotHasCredential } from '../ports/turn-runner.ts'

/**
 * Pull protocol between core and a runner VM — spec §8 «Раннер на песочной ВМ». The runner
 * long-polls core for commands and posts reports; it has no inbound port and no platform
 * credentials. Every message is a strict zod object: unknown fields are refused, not ignored.
 */

export const RUNNER_API_PREFIX = '/runner/v1'
export const runnerApiPaths = Object.freeze({
  poll: `${RUNNER_API_PREFIX}/poll`,
  reports: `${RUNNER_API_PREFIX}/reports`,
  reconcile: `${RUNNER_API_PREFIX}/reconcile`,
})
const assignmentPath = (assignmentId: string) =>
  `${RUNNER_API_PREFIX}/assignments/${z.uuid().parse(assignmentId)}`
/** GET: the base bundle of a prepare command. */
export const runnerBundlePath = (assignmentId: string) => `${assignmentPath(assignmentId)}/bundle`
/** GET: 32 bytes of the data key, `no-store`; only for an open restore or seal command. */
export const runnerKeyPath = (assignmentId: string, purpose: 'restore' | 'seal') =>
  `${assignmentPath(assignmentId)}/keys/${purpose}`
/** PUT: an untrusted captured part, before the captured report. */
export const runnerCandidatePath = (assignmentId: string, part: 'patch' | 'untracked') =>
  `${assignmentPath(assignmentId)}/candidate/${part}`

/** The fence of the binary endpoints above, which have no JSON body. */
export const runnerHeaders = Object.freeze({
  session: 'x-raditi-runner-session',
  epoch: 'x-raditi-epoch',
  command: 'x-raditi-command',
})

/** Domain constants, not configuration: both sides must agree on them. */
export const runnerTimings = Object.freeze({
  /** Core holds a poll without commands this long. */
  pollHoldMs: 25_000,
  /** The poll is the heartbeat: a runner silent this long has lost its turns. */
  silentAfterMs: 90_000,
  /** A prepare command no runner took in this time fails the turn (RUNNER_UNAVAILABLE). */
  claimTimeoutMs: 30_000,
})

export const runnerLimits = Object.freeze({
  /** Serialized events of one output report. */
  outputBatchBytes: 1024 * 1024,
  /** A JSON request body: an output batch plus its envelope. */
  bodyBytes: 1024 * 1024 + 64 * 1024,
  commands: 64,
  capacity: 64,
  /** Waiting assignments one claim offers the store, oldest first. */
  claimIds: 256,
  inventory: 256,
  /** turnCredentials(): the LLM key, the MCP token and every secret file. */
  credentials: preparedRunLimits.secretFiles + 2,
  events: agentOutputLimits.turnEvents,
})

// --- Runner identity ---------------------------------------------------------------------------

const RUNNER_ID = '[a-z0-9][a-z0-9-]{0,62}'
export const runnerIdSchema = z.string().regex(new RegExp(`^${RUNNER_ID}$`))
const RUNNER_TOKEN = new RegExp(`^rnr_(${RUNNER_ID})\\.[A-Za-z0-9_-]{43}$`)

/**
 * `rnr_<runnerId>.<256-bit base64url secret>`, read from RUNNER_TOKEN_FILE on the VM. Core keeps
 * only SHA-256 hashes of whole tokens. null for anything else; the token is never echoed.
 */
export function parseRunnerToken(token: string): { runnerId: string } | null {
  const match = RUNNER_TOKEN.exec(token)
  return match?.[1] ? { runnerId: match[1] } : null
}

// --- Shared pieces -----------------------------------------------------------------------------

const uuid = z.uuid()
const epoch = z.number().int().positive()
const sandboxRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
const turnMs = z.number().int().positive().max(MAX_SANDBOX_TURN_MS)
const fence = siteLeaseFenceSchema.strict()

/**
 * A presigned S3 request on the wire. A bearer capability: never logged, never in a sandbox.
 * The expiry is signed into the URL; the runner learns nothing else about S3.
 */
const presignedSchema = z
  .object({
    method: z.enum(['GET', 'PUT']),
    url: z
      .url({ protocol: /^https?$/ })
      .max(8192)
      .refine((url) => {
        const parsed = URL.parse(url)
        return parsed?.username === '' && parsed.password === '' && parsed.hash === ''
      }, 'expected a URL without credentials or fragment'),
    headers: z
      .record(z.string().regex(/^[a-z0-9-]{1,64}$/), z.string().max(1024))
      .refine((headers) => Object.keys(headers).length <= 8, 'too many signed headers'),
  })
  .strict()
export const presignedGetSchema = presignedSchema.extend({ method: z.literal('GET') }).strict()
/** Create-only: `If-None-Match: *` is signed, so the URL never overwrites an object. */
export const presignedPutSchema = presignedSchema
  .extend({ method: z.literal('PUT') })
  .strict()
  .refine((put) => put.headers['if-none-match'] === '*', 'expected a create-only PUT')

const destroyReasonSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'gc',
]) satisfies z.ZodType<DestroyReason>

export const execExitSchema = z
  .object({
    code: z.number().int().min(-1).max(255).nullable(),
    reason: z.enum(['exited', 'timeout', 'cancelled', 'oom', 'lost']),
  })
  .strict() satisfies z.ZodType<ExecExit>

/** What the home part's AAD binds: the manifest without its parts (snapshotAad). */
export const snapshotSealBaseSchema = snapshotMetadataSchema
  .extend({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    createdAt: z.iso.datetime(),
  })
  .strict()

// --- Commands: core → runner -------------------------------------------------------------------

const command = <K extends string, T extends z.ZodRawShape>(type: K, shape: T) =>
  z
    .object({
      type: z.literal(type),
      commandId: uuid,
      assignmentId: uuid,
      fence,
      /** Validity from receipt: the runner drops an expired command unanswered. */
      ttlMs: turnMs,
      ...shape,
    })
    .strict()

const prepareCommand = command('prepare', {
  sandbox: sandboxSpecSchema,
  /**
   * Left of the whole turn when a poll takes the command; the runner counts it from sending that
   * poll, so the container's deadline never outlives the turn's (spec §8).
   */
  remainingMs: turnMs,
  /** Fetched from runnerBundlePath() and checked before the import. */
  bundle: z
    .object({
      /** Its single ref points here; the agent's branch starts from it. */
      baseSha: publicationShaSchema,
      branch: publicationSourceSchema.shape.branch,
      sha256: sha256Hex,
      sizeBytes: z.number().int().positive().max(publicationLimits.bundleBytes),
    })
    .strict(),
  restore: z
    .object({
      /** Checked by core against the trusted snapshot reference. */
      manifest: snapshotManifestSchema,
      parts: z
        .object({
          home: presignedGetSchema,
          untracked: presignedGetSchema,
          patch: presignedGetSchema,
        })
        .strict(),
    })
    .strict()
    .optional(),
  driverId: z.enum(agentDriverIds),
  /** Checked by core (preparedRunSchema, preparedRunExposesSecret) and again by the runner. */
  prepared: preparedFilesSchema,
  argv: execSpecSchema.shape.argv,
  credentials: z
    .array(z.string().min(1).max(preparedRunLimits.secretChars))
    .min(1)
    .max(runnerLimits.credentials),
})

const adoptCommand = command('adopt', {
  containerId: sandboxRef,
  labels: sandboxLabelsSchema,
  /** `removal` allows only destroy; `work` re-checks the container for quiesce and capture. */
  purpose: z.enum(['work', 'removal']),
  work: z
    .object({
      remainingMs: turnMs,
      driverId: z.enum(agentDriverIds),
      /** Omitted when the runner session that prepared the turn still holds them. */
      credentials: z
        .array(z.string().min(1).max(preparedRunLimits.secretChars))
        .min(1)
        .max(runnerLimits.credentials)
        .optional(),
    })
    .strict()
    .optional(),
})

export const runnerCommandSchema = z
  .discriminatedUnion('type', [
    prepareCommand,
    /** Only after core asserted its fence. */
    command('launch', { timeoutMs: turnMs }),
    adoptCommand,
    /** Re-attach to the agent after a restart, from the journal cursor. */
    command('resume', {
      execId: sandboxRef,
      cursor: execCursorSchema,
      eventCount: z.number().int().nonnegative().max(runnerLimits.events),
    }),
    command('quiesce', {}),
    command('capture', { home: sessionStateSchema, baseSha: publicationShaSchema }),
    command('seal', {
      base: snapshotSealBaseSchema,
      /** The captured home size, signed into the PUT as its Content-Length. */
      sizeBytes: z.number().int().nonnegative().max(snapshotLimits.archiveBytes),
      put: presignedPutSchema,
    }),
    /** Kill the agent's exec now; the container stays for capture or destroy. */
    command('abort', {}),
    command('destroy', { reason: destroyReasonSchema }),
  ])
  .superRefine((cmd, ctx) => {
    const labels =
      cmd.type === 'prepare' ? cmd.sandbox.labels : cmd.type === 'adopt' ? cmd.labels : null
    if (
      labels &&
      (labels.siteId !== cmd.fence.siteId ||
        labels.taskId !== cmd.fence.taskId ||
        (cmd.type === 'prepare' && labels.leaseEpoch !== cmd.fence.epoch))
    )
      ctx.addIssue({ code: 'custom', message: 'sandbox labels differ from the fence' })
    if (cmd.type === 'prepare') {
      if (cmd.sandbox.secrets.length !== 0)
        ctx.addIssue({ code: 'custom', message: 'turn secrets are installed only after restore' })
      if (cmd.sandbox.hardTimeoutMs > cmd.remainingMs)
        ctx.addIssue({ code: 'custom', message: 'the container would outlive the turn' })
    }
    if (cmd.type === 'adopt' && (cmd.purpose === 'work') !== (cmd.work !== undefined))
      ctx.addIssue({ code: 'custom', message: 'adoption for work needs its turn state' })
  })
export type RunnerCommand = z.infer<typeof runnerCommandSchema>

// --- Poll and reconcile ------------------------------------------------------------------------

/** Phases of an assignment as the runner sees it, for the poll's view of active turns. */
export const runnerAssignmentPhases = [
  'preparing',
  'prepared',
  'running',
  'exited',
  'quiesced',
  'captured',
  'sealed',
  'destroyed',
  'failed',
] as const

/** A turn container the runner's Docker holds, found by labels. */
const runnerContainerSchema = z
  .object({
    containerId: sandboxRef,
    labels: sandboxLabelsSchema,
    ageMs: z.number().int().nonnegative(),
  })
  .strict()

export const runnerPollRequestSchema = z
  .object({
    /** A fresh uuid per process start: a restarted runner is a new session. */
    runnerSession: uuid,
    capacity: z.number().int().nonnegative().max(runnerLimits.capacity),
    inventory: z.array(runnerContainerSchema).max(runnerLimits.inventory),
    active: z
      .array(
        z.object({ assignmentId: uuid, epoch, phase: z.enum(runnerAssignmentPhases) }).strict(),
      )
      .max(runnerLimits.capacity),
  })
  .strict()
export type RunnerPollRequest = z.infer<typeof runnerPollRequestSchema>

/**
 * The envelope of a poll's answer. The runner checks each command on its own with
 * runnerCommandSchema, so one it cannot read does not drop the others.
 */
export const runnerPollResponseSchema = z
  .object({ commands: z.array(z.unknown()).max(runnerLimits.commands) })
  .strict()

export const runnerReconcileRequestSchema = z
  .object({
    runnerSession: uuid,
    inventory: z.array(runnerContainerSchema).max(runnerLimits.inventory),
  })
  .strict()

/** Containers no assignment at its current epoch owns; the runner removes them. */
export const runnerReconcileResponseSchema = z
  .object({ remove: z.array(sandboxRef).max(runnerLimits.inventory) })
  .strict()

// --- Reports: runner → core --------------------------------------------------------------------

/**
 * Codes a runner may report for a failed command or a lost turn. Core rebuilds the error with
 * its own message (runnerFailure): runner text never reaches the journal or the client.
 */
export const runnerFailureCodes = [
  'CONFLICT',
  'DRIVER_PREPARE_INVALID',
  'SANDBOX_COMMAND_FAILED',
  'SNAPSHOT_LOAD_FAILED',
  'SNAPSHOT_NOT_WRITTEN',
  'SNAPSHOT_CREDENTIAL',
  'SNAPSHOT_SAVE_FAILED',
  'SNAPSHOT_TOO_LARGE',
  'PUBLICATION_TOO_LARGE',
  'REPOSITORY_TOO_LARGE',
  'REPOSITORY_UNSUPPORTED',
  'TURN_OUTPUT_REJECTED',
  'TURN_OUTPUT_TOO_LARGE',
  'EXEC_LOST',
  'CREDENTIALS_LOST',
] as const
export type RunnerFailureCode = (typeof runnerFailureCodes)[number]

const report = <K extends string, T extends z.ZodRawShape>(type: K, shape: T) =>
  z
    .object({
      type: z.literal(type),
      runnerSession: uuid,
      assignmentId: uuid,
      epoch,
      ...shape,
    })
    .strict()

const candidatePart = (maxBytes: number) =>
  z.object({ sha256: sha256Hex, sizeBytes: z.number().int().nonnegative().max(maxBytes) }).strict()

export const runnerReportSchema = z
  .discriminatedUnion('type', [
    /**
     * The container of a prepare exists; sent before the bundle import. From its answer on core
     * owns the container's removal, and the runner waits for that answer before importing. The
     * answer may wait for a destroy of the same assignment: commands keep arriving meanwhile.
     */
    report('created', { commandId: uuid, containerId: sandboxRef }),
    report('prepared', { commandId: uuid, containerId: sandboxRef }),
    /** Answers adopt; a missing container answers it with `destroyed`, another one with CONFLICT. */
    report('adopted', { commandId: uuid, containerId: sandboxRef }),
    /** Answers launch or resume. */
    report('running', { commandId: uuid, execId: sandboxRef }),
    /** Accepted only when `from` equals the journal cursor; `to` at or before it is a replay. */
    report('output', {
      execId: sandboxRef,
      from: execCursorSchema,
      to: execCursorSchema,
      events: z.array(agentEventSchema).max(runnerLimits.events),
    }),
    report('exited', { execId: sandboxRef, exit: execExitSchema }),
    report('quiesced', { commandId: uuid }),
    /** Sent after both candidate parts were uploaded to core. */
    report('captured', {
      commandId: uuid,
      homeBytes: z.number().int().nonnegative().max(snapshotLimits.archiveBytes),
      patch: candidatePart(snapshotLimits.patchBytes),
      untracked: candidatePart(snapshotLimits.archiveBytes),
    }),
    report('sealed', {
      commandId: uuid,
      sha256: sha256Hex,
      sizeBytes: z.number().int().nonnegative().max(snapshotLimits.archiveBytes),
      iv: z.string().regex(/^[0-9a-f]{24}$/),
      tag: z.string().regex(/^[0-9a-f]{32}$/),
    }),
    /** Without a command when the runner removed the container on its own (LEASE_LOST). */
    report('destroyed', { commandId: uuid.optional(), containerId: sandboxRef }),
    report('failed', {
      commandId: uuid.optional(),
      code: z.enum(runnerFailureCodes),
      /**
       * Answers a prepare: it created no container, or its provider removed the one it created.
       * Core may then free the site at once (spec §8).
       */
      absent: z.literal(true).optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.type === 'failed' && value.absent && value.commandId === undefined)
      ctx.addIssue({ code: 'custom', message: 'only the answer to a prepare can be absent' })
    if (value.type !== 'output') return
    if (value.to.stdout < value.from.stdout || value.to.stderr < value.from.stderr)
      ctx.addIssue({ code: 'custom', message: 'the output cursor moved backwards' })
    if (
      new TextEncoder().encode(JSON.stringify(value.events)).byteLength >
      runnerLimits.outputBatchBytes
    )
      ctx.addIssue({ code: 'custom', message: 'output batch exceeds its limit' })
  })
export type RunnerReport = z.infer<typeof runnerReportSchema>

/**
 * 409 answers. FENCE_SUPERSEDED: recovery took the turn over under a newer fence; the runner
 * switches to it, drops the reports of commands issued under the older epoch and sends output
 * again only after the next resume. LEASE_LOST: kill the exec and remove the container.
 * SESSION_RETIRED: this runner session is no longer the runner's (a newer one polls, or core
 * gave it up as silent): it stops without touching any container — the newer session or
 * recovery may hold them — and the runner restarts under a new session.
 */
export const runnerConflictSchema = z.discriminatedUnion('error', [
  z.object({ error: z.literal('FENCE_SUPERSEDED'), fence }).strict(),
  z.object({ error: z.literal('LEASE_LOST') }).strict(),
  z.object({ error: z.literal('SESSION_RETIRED') }).strict(),
  /** A gap in the output: the runner re-attaches from `expected`. */
  z.object({ error: z.literal('CURSOR_MISMATCH'), expected: execCursorSchema }).strict(),
])
export type RunnerConflict = z.infer<typeof runnerConflictSchema>

/**
 * Every other refusal is `{ error }` with one of these codes and nothing about the cause.
 * COMMAND_CLOSED: core no longer waits for this command or exec; the runner drops that work and
 * waits for the next command. UNAVAILABLE: retry with backoff until the turn deadline.
 */
export const runnerApiErrors = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  COMMAND_CLOSED: 410,
  TOO_LARGE: 413,
  INTERNAL: 500,
  UNAVAILABLE: 503,
})
export type RunnerApiErrorCode = keyof typeof runnerApiErrors
export const runnerErrorSchema = z
  .object({
    error: z.enum(Object.keys(runnerApiErrors) as [RunnerApiErrorCode, ...RunnerApiErrorCode[]]),
  })
  .strict()

// --- Errors ------------------------------------------------------------------------------------

/** No runner took the turn in time; nothing ran, and the turn may be retried. */
export const runnerUnavailable = (message = 'No sandbox runner took the turn'): DomainError =>
  new DomainError('RUNNER_UNAVAILABLE', message, 503)

/**
 * This core stops: the runners keep their turns, and the next core's recovery takes them over.
 * Unlike RUNNER_UNAVAILABLE, nothing is known to be wrong with the runner or the turn.
 */
export const coreStopping = (): DomainError =>
  new DomainError('CORE_STOPPING', 'Core is shutting down', 503)

export const isCoreStopping = (error: unknown): boolean =>
  isDomainError(error) && error.code === 'CORE_STOPPING'

/** The error core raises for a runner's failure report, with a message of its own. */
export function runnerFailure(code: RunnerFailureCode): DomainError {
  switch (code) {
    case 'CONFLICT':
      return conflict('A container already exists for this turn')
    case 'DRIVER_PREPARE_INVALID':
      return driverPrepareInvalid('The runner refused the prepared turn files')
    case 'SANDBOX_COMMAND_FAILED':
      return sandboxCommandFailed('The runner could not complete a sandbox command')
    case 'SNAPSHOT_LOAD_FAILED':
      return new DomainError('SNAPSHOT_LOAD_FAILED', 'The runner could not restore the turn', 502)
    case 'SNAPSHOT_NOT_WRITTEN':
      return new DomainError(
        'SNAPSHOT_NOT_WRITTEN',
        'The runner could not capture the turn; nothing was written',
        502,
      )
    case 'SNAPSHOT_CREDENTIAL':
      return snapshotHasCredential()
    case 'SNAPSHOT_SAVE_FAILED':
      return new DomainError(
        'SNAPSHOT_SAVE_FAILED',
        'The runner could not store the home part',
        502,
      )
    case 'SNAPSHOT_TOO_LARGE':
      return snapshotTooLarge()
    case 'PUBLICATION_TOO_LARGE':
      return publicationTooLarge()
    case 'REPOSITORY_TOO_LARGE':
      return repositoryTooLarge()
    case 'REPOSITORY_UNSUPPORTED':
      return repositoryUnsupported()
    case 'TURN_OUTPUT_REJECTED':
      return turnOutputRejected()
    case 'TURN_OUTPUT_TOO_LARGE':
      return turnOutputTooLarge()
    case 'EXEC_LOST':
      return execLost()
    case 'CREDENTIALS_LOST':
      return execLost('The runner no longer holds the turn credentials')
  }
}
