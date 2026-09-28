import { z } from 'zod'

import {
  SANDBOX_SECRET_CHARS,
  SANDBOX_SECRET_FILES,
  SANDBOX_SECRETS_DIR,
  SANDBOX_SECRETS_TMPFS_BYTES,
} from './sandbox-provider.ts'

/**
 * Agent driver port — spec §8. The core knows only this interface and the common events;
 * every CLI-specific detail (flags, config files, event format) lives in the adapter
 * (packages/agent-drivers). No `if (driver === 'codex')` outside the driver.
 */
export const agentDriverIds = [
  'codex',
  'kimi',
  'qwen',
  'opencode',
  'gigacode',
  'sourcecraft',
] as const
export type AgentDriverId = (typeof agentDriverIds)[number]

export interface AgentCapabilities {
  /** Can continue a native session in a new container. */
  resume: boolean
  /** Streams JSONL events on stdout. */
  jsonEvents: boolean
  /** Can be forced to end with a JSON object matching a schema. */
  outputSchema: boolean
  mcp: boolean
  /** Accepts images as input. */
  images: boolean
}

/** Fixed paths: Kimi and Qwen bind their sessions to the working directory path. */
export const SANDBOX_WORKDIR = '/workspace/repo'
export const SANDBOX_INBOX = '/workspace/inbox'
export const SANDBOX_OUT = '/workspace/out'
export const SANDBOX_AGENT_HOME = '/agent-home'

/** Everything the orchestrator hands a driver for one turn. */
export interface RunContext {
  taskId: string
  sessionId: string
  turn: number
  /** Per-turn LiteLLM virtual key with a budget and TTL; the only LLM credential in the sandbox. */
  llm: { baseUrl: string; apiKey: string; model: string }
  /** Per-turn MCP token scoped to the site and the task. */
  mcp: { url: string; token: string }
  /** Platform AGENTS.md + site AGENTS.md; drivers that ignore AGENTS.md get it as a system prompt. */
  instructions: string
  /** Native session id of the previous turn, restored from its snapshot. */
  nativeSessionId?: string
}

export interface SandboxFile {
  path: string
  content: string
  mode?: number
}

export interface PreparedRun {
  context: RunContext
  /**
   * Driver config, AGENTS.md, output schema — written before the turn starts, only under
   * SANDBOX_AGENT_HOME. Never the working copy (SANDBOX_WORKDIR): capture would publish them
   * to the client's repository. preparedRunSchema enforces it.
   */
  files: SandboxFile[]
  /**
   * Non-secret variables of the agent exec only. The LLM key, the MCP token and every other
   * credential reach the agent only as `secrets` files; files and env carrying one are refused
   * (preparedRunExposesSecret): /agent-home is packed into the S3 snapshot.
   */
  env: Record<string, string>
  /** Per-turn secrets: only under SANDBOX_SECRETS_DIR (tmpfs), never part of a snapshot. */
  secrets: SandboxFile[]
}

/** tmpfs charges whole pages, so each secret file takes at least one. */
const TMPFS_PAGE_BYTES = 4096

export const preparedRunLimits = Object.freeze({
  files: 256,
  bytes: 4 * 1024 * 1024,
  path: 1024,
  /** Secret files in whole tmpfs pages: they must fit into the secrets tmpfs. */
  secretBytes: SANDBOX_SECRETS_TMPFS_BYTES,
  /**
   * Secret files and the characters of each secret — also the LLM key and the MCP token: a
   * runner takes a turn's credentials only within these (runnerLimits), so both executors do.
   */
  secretFiles: SANDBOX_SECRET_FILES,
  secretChars: SANDBOX_SECRET_CHARS,
})

/** Normalized absolute path strictly below `root`: no '.', '..', empty or `.git` segments. */
function isPreparedPath(path: string, root: string): boolean {
  return (
    path.startsWith(`${root}/`) &&
    !path.includes('\\') &&
    ![...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    path
      .slice(1)
      .split('/')
      .every(
        (part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
      )
  )
}

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const tmpfsBytes = (content: string) =>
  Math.max(1, Math.ceil(utf8Bytes(content) / TMPFS_PAGE_BYTES)) * TMPFS_PAGE_BYTES

const preparedFileSchema = (root: string, maxChars?: number) =>
  z
    .object({
      path: z
        .string()
        .max(preparedRunLimits.path)
        .refine((path) => isPreparedPath(path, root), `expected a normalized path under ${root}`),
      content: maxChars === undefined ? z.string() : z.string().max(maxChars),
      mode: z.number().int().min(0).max(0o777).optional(),
    })
    .strict()

const preparedFilesShape = {
  files: z.array(preparedFileSchema(SANDBOX_AGENT_HOME)).max(preparedRunLimits.files),
  env: z.record(z.string(), z.string()),
  secrets: z
    .array(preparedFileSchema(SANDBOX_SECRETS_DIR, preparedRunLimits.secretChars))
    .max(preparedRunLimits.secretFiles),
}

function checkPreparedFiles(
  run: Pick<PreparedRun, 'files' | 'secrets'>,
  ctx: z.RefinementCtx,
): void {
  const all = [...run.files, ...run.secrets]
  if (all.length > preparedRunLimits.files)
    ctx.addIssue({ code: 'custom', message: 'too many prepared files' })
  if (all.reduce((sum, file) => sum + utf8Bytes(file.content), 0) > preparedRunLimits.bytes)
    ctx.addIssue({ code: 'custom', message: 'prepared files are too large' })
  if (
    run.secrets.reduce((sum, file) => sum + tmpfsBytes(file.content), 0) >
    preparedRunLimits.secretBytes
  )
    ctx.addIssue({ code: 'custom', message: 'prepared secrets do not fit their tmpfs' })
  if (new Set(all.map((file) => file.path)).size !== all.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate prepared file path' })
}

/** What the orchestrator accepts from AgentDriver.prepare before writing anything. */
export const preparedRunSchema = z
  .object({
    context: z.custom<RunContext>((value) => typeof value === 'object' && value !== null),
    ...preparedFilesShape,
  })
  .strict()
  .superRefine(checkPreparedFiles)

/** The same rules for what reaches a sandbox without the run context (a runner's prepare). */
export const preparedFilesSchema = z
  .object(preparedFilesShape)
  .strict()
  .superRefine(checkPreparedFiles)
export type PreparedFiles = Pick<PreparedRun, 'files' | 'env' | 'secrets'>

/** Every credential of one turn: the LLM key, the MCP token and each secret file's content. */
export function turnCredentials(
  context: Pick<RunContext, 'llm' | 'mcp'>,
  secrets: readonly SandboxFile[],
): string[] {
  return [context.llm.apiKey, context.mcp.token, ...secrets.map((file) => file.content)].filter(
    (value) => value.length > 0,
  )
}

/** True when any value contains one of the credentials verbatim. */
export function containsCredential(
  values: readonly string[],
  credentials: readonly string[],
): boolean {
  const known = credentials.filter((value) => value.length > 0)
  return values.some((value) => known.some((credential) => value.includes(credential)))
}

/**
 * True when a driver file, env value or command argument carries a turn credential: files under
 * /agent-home end up in the S3 snapshot (home.tar.zst), env and argv in exec inspection output.
 */
export function preparedRunExposesSecret(
  run: Pick<PreparedRun, 'files' | 'env'>,
  credentials: readonly string[],
  argv: readonly string[] = [],
): boolean {
  return containsCredential(
    [...run.files.map((file) => file.content), ...Object.values(run.env), ...argv],
    credentials,
  )
}

export interface TurnInput {
  prompt: string
  /** Client files already placed under SANDBOX_INBOX. */
  attachments: string[]
}

/**
 * Where the driver keeps its native session; packed into home.tar.zst after each turn.
 * `include` is an allowlist of paths relative to `root` (missing ones are skipped): only session
 * data, never credentials, config with tokens, logs or CLI binaries. `exclude` narrows it further.
 */
export interface SessionState {
  root: string
  include: string[]
  exclude: string[]
}

const tokenCount = z.number().int().nonnegative()

/**
 * Token usage in one normalized shape. `output` already includes reasoning.
 * Informational only (live progress): billing uses the LLM gateway spend log, not the agent.
 */
export const tokenUsageSchema = z.object({
  inputUncached: tokenCount,
  cacheRead: tokenCount,
  cacheWrite: tokenCount,
  output: tokenCount,
  reasoning: tokenCount,
})
export type TokenUsage = z.infer<typeof tokenUsageSchema>

/**
 * Size limits for everything an agent prints. Agent output is untrusted: it is stored, streamed
 * over SSE and shown to the client, so every string and array is bounded. A driver that needs
 * to pass longer text (a long message) truncates it before validation.
 */
export const agentOutputLimits = Object.freeze({
  nativeSessionId: 200,
  messageText: 20_000,
  command: 10_000,
  path: 1024,
  tool: 200,
  questionText: 1000,
  questionOptions: 6,
  questionOption: 200,
  failureReason: 2000,
  summary: 500,
  clientMessage: 2000,
  filesChanged: 500,
  questions: 5,
  question: 500,
  /** Events of one turn across reconnects, on both executors. */
  turnEvents: 10_000,
})
const limits = agentOutputLimits

/** Native session ids end up in literal snapshot paths: validated whole, never truncated. */
export const nativeSessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/)

/** Common events — the only agent vocabulary the orchestrator, chat and billing see (CLAUDE.md, rule 8). */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    nativeSessionId: nativeSessionIdSchema.optional(),
  }),
  z.object({ type: z.literal('message'), text: z.string().max(limits.messageText) }),
  z.object({
    type: z.literal('command'),
    command: z.string().max(limits.command),
    exitCode: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal('file_change'),
    path: z.string().max(limits.path),
    change: z.enum(['add', 'update', 'delete']),
  }),
  z.object({ type: z.literal('tool_call'), tool: z.string().max(limits.tool), ok: z.boolean() }),
  z.object({
    type: z.literal('question'),
    text: z.string().max(limits.questionText),
    options: z.array(z.string().max(limits.questionOption)).max(limits.questionOptions),
  }),
  z.object({ type: z.literal('usage'), usage: tokenUsageSchema }),
  z.object({ type: z.literal('completed') }),
  /**
   * `reason` is raw CLI or provider text, often English: logs and operators only. The client
   * never sees it verbatim; the chat shows a Russian text chosen by the event type (spec §8).
   */
  z.object({ type: z.literal('failed'), reason: z.string().max(limits.failureReason) }),
])
export type AgentEvent = z.infer<typeof agentEventSchema>
export type AgentEventType = AgentEvent['type']

/**
 * Result of a turn — spec §8. Validated with this schema; on failure the agent gets one
 * attempt to fix it. `client_message` goes to the client verbatim: Russian, polite «вы», no jargon.
 */
export const turnResultSchema = z
  .object({
    summary: z.string().min(1).max(limits.summary),
    change_type: z.enum(['code', 'content', 'mixed', 'none']),
    client_message: z.string().min(1).max(limits.clientMessage),
    files_changed: z.array(z.string().min(1).max(limits.path)).max(limits.filesChanged),
    questions: z.array(z.string().min(1).max(limits.question)).max(limits.questions),
    needs_approval: z.boolean(),
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict()
export type TurnResult = z.infer<typeof turnResultSchema>

export interface AgentDriver {
  readonly id: AgentDriverId
  /** Sandbox image with the CLI, pinned by digest. */
  readonly image: string
  readonly capabilities: AgentCapabilities
  prepare(context: RunContext): Promise<PreparedRun>
  /** argv of the turn: a fresh run or a resume of `context.nativeSessionId`. */
  command(run: PreparedRun, turn: TurnInput): string[]
  /** One stdout line → zero or more common events. Unknown lines yield []. */
  parseEvent(line: string): AgentEvent[]
  sessionState(run: PreparedRun): SessionState
  /** The raw final object of the turn; the orchestrator validates it with turnResultSchema. */
  extractResult(events: readonly AgentEvent[], lastMessage: string | null): unknown
}
