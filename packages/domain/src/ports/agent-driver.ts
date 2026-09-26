import { z } from 'zod'

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
  /** Driver config, AGENTS.md, output schema — written before the turn starts. */
  files: SandboxFile[]
  /**
   * Non-secret variables only: they may end up in SandboxSpec.env, which sandboxSpecSchema
   * checks. The LLM key and the MCP token go through `secrets` or the agent exec's own env.
   */
  env: Record<string, string>
  /** Per-turn secrets: tmpfs only, never part of a snapshot. */
  secrets: SandboxFile[]
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
})
const limits = agentOutputLimits

/** Common events — the only agent vocabulary the orchestrator, chat and billing see (CLAUDE.md, rule 8). */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    nativeSessionId: z.string().max(limits.nativeSessionId).optional(),
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
