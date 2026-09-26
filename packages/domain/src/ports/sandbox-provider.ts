import { z } from 'zod'
import { badRequest } from '../errors.ts'

/**
 * Sandbox port — spec §8. One task is a logical session; a container lives for one turn.
 * Adapters: Docker via a local socket (PoC, macOS dev) and the `runner` role on sandbox VMs
 * (pilot). The container starts as `tini -- sleep infinity`; everything else is exec.
 * Bytes move only through exec stdin/stdout — never `docker cp` or the archive API.
 * Every SandboxSpec passes sandboxSpecSchema (assertSandboxSpec) before a provider starts it.
 */

export const sandboxRuntimes = ['runsc', 'runc'] as const
export type SandboxRuntime = (typeof sandboxRuntimes)[number]
export const SANDBOX_SECRETS_DIR = '/run/raditi/secrets'

export interface SandboxLabels {
  workspaceId: string
  siteId: string
  taskId: string
  sessionId: string
  turn: number
  /** Site-lease fencing epoch, set by the turn supervisor. */
  leaseEpoch?: number
}

export interface SandboxResources {
  cpu: number
  memoryMiB: number
  pids: number
}

/** No internet and no DNS: the only way out is sandbox-gw with a path allowlist. */
export type NetworkPolicy = { mode: 'none' } | { mode: 'gateway'; routes: Array<'llm' | 'mcp'> }

export interface SandboxSecretFile {
  /** Absolute path on tmpfs inside the sandbox. */
  path: string
  value: string
}

/**
 * What a provider starts. There is no read-only switch: every provider always mounts the
 * rootfs read-only (spec §8 `readOnlyRootfs: true`), with tmpfs only for HOME and secrets.
 */
export interface SandboxSpec {
  /** Image pinned by digest: registry/raditi/sbx-wordpress@sha256:… */
  image: string
  labels: SandboxLabels
  /** From configuration (SANDBOX_RUNTIME), never hard-coded. */
  runtime: SandboxRuntime
  /** At most 2 vCPU, 4096 MiB, 512 processes. */
  resources: SandboxResources
  /** Always uid:gid 10001:10001, never root. */
  user: { uid: number; gid: number }
  /** Container-wide and visible in `docker inspect`: never a secret, see `secrets`. */
  env: Record<string, string>
  /** Per-turn credentials (LLM virtual key, MCP token): tmpfs files, never in a snapshot. */
  secrets: SandboxSecretFile[]
  network: NetworkPolicy
  /** Hard limit for the whole turn, at most 20 minutes. */
  hardTimeoutMs: number
}

export interface ExecSpec {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: AsyncIterable<Uint8Array>
  timeoutMs: number
  signal?: AbortSignal
}

export interface ExecChunk {
  stream: 'stdout' | 'stderr'
  /** Byte offset in the stream, to resume reading after a reconnect. */
  offset: number
  data: Uint8Array
}

/** stdout and stderr have independent byte offsets; neither may be inferred from the other. */
export interface ExecCursor {
  stdout: number
  stderr: number
}

export interface ExecExit {
  code: number | null
  reason: 'exited' | 'timeout' | 'cancelled' | 'oom' | 'lost'
}

export interface ExecHandle {
  readonly id: string
  output(): AsyncIterable<ExecChunk>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
  wait(): Promise<ExecExit>
}

export interface FileEntry {
  path: string
  type: 'file' | 'dir' | 'symlink'
  size: number
}

export interface SandboxFs {
  read(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>
  write(path: string, data: Uint8Array, opts?: { mode?: number }): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>
  list(path: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<FileEntry[]>
}

export type DestroyReason = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'gc'

export interface Sandbox {
  readonly id: string
  readonly labels: SandboxLabels
  exec(spec: ExecSpec): Promise<ExecHandle>
  /** Re-attach to a running exec from a byte offset (after an orchestrator restart). */
  attach(execId: string, cursor?: ExecCursor): Promise<ExecHandle>
  /** Stop managed process groups; fail closed if remaining agent processes cannot be stopped. */
  quiesce(): Promise<void>
  readonly fs: SandboxFs
  destroy(reason: DestroyReason): Promise<void>
}

export interface SandboxInfo {
  id: string
  labels: SandboxLabels
  createdAt: Date
}

export interface SandboxProvider {
  readonly kind: 'docker' | 'runner'
  create(spec: SandboxSpec, signal?: AbortSignal): Promise<Sandbox>
  get(id: string): Promise<Sandbox | null>
  /** For the reconciler: find orphans by labels and age. */
  list(filter?: Partial<SandboxLabels>): Promise<SandboxInfo[]>
}

// --- Sandbox policy: CLAUDE.md rule 5, spec §8 ------------------------------------------------

/** The only user a sandbox runs as. */
export const SANDBOX_UID = 10001
export const SANDBOX_GID = 10001
/** Ceiling for every sandbox: a spec may ask for less, never for more. */
export const MAX_SANDBOX_RESOURCES: Readonly<SandboxResources> = Object.freeze({
  cpu: 2,
  memoryMiB: 4096,
  pids: 512,
})
export const MAX_SANDBOX_TURN_MS = 20 * 60 * 1000

/** `repository@sha256:<64 hex>`, optionally with a registry host and port; no tag. */
const digestPinnedImage =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+(?=\/))?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/

/** Label values end up in container names and docker labels. */
const labelId = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'expected an id of letters, digits, _ and -')

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Env names that suggest a credential; such values go through `secrets` on tmpfs. */
const secretLikeEnvName = /KEY|TOKEN|SECRET|PASS|CREDENTIAL/i

/**
 * Values that look like credentials, whatever the name. A heuristic in the spirit of gitleaks,
 * not an exhaustive list: the rule is still "no secrets in env".
 */
const secretLikeEnvValues: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  // Credentials inside a URL: https://user:password@host, https://token@host.
  /^[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i,
  // OpenAI-style keys, LiteLLM virtual keys included.
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // JWT.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./,
  // Git hosting tokens: GitHub, GitLab.
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,})/,
  // Vault/OpenBao tokens.
  /\bhv[sbr]\.[A-Za-z0-9_-]{20,}/,
  // Yandex Cloud API keys, IAM and OAuth tokens.
  /\b(?:AQVN[A-Za-z0-9_-]{30,}|t1\.[A-Za-z0-9_-]{20,}|y[0-3]_[A-Za-z0-9_-]{20,})/,
]

/** Both the working tree and native agent home may be snapshotted or uploaded. */
const snapshottedRoots = ['/workspace', '/agent-home'] as const

const secretPath = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path.startsWith('/') &&
      !path.includes('\0') &&
      !path.endsWith('/') &&
      path
        .slice(1)
        .split('/')
        .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'expected a normalized absolute file path',
  )
  .refine(
    (path) => !snapshottedRoots.some((root) => path === root || path.startsWith(`${root}/`)),
    'secrets never live under /workspace or /agent-home: they may be snapshotted',
  )
  .refine(
    (path) => path.startsWith(`${SANDBOX_SECRETS_DIR}/`),
    'secret files must live in the dedicated /run/raditi/secrets tmpfs',
  )

const sandboxEnvSchema = z.record(z.string(), z.string().max(4096)).superRefine((env, ctx) => {
  if (Object.keys(env).length > 64)
    ctx.addIssue({ code: 'custom', message: 'at most 64 environment variables are allowed' })
  for (const [name, value] of Object.entries(env)) {
    // Messages name the variable, never its value.
    if (!envName.test(name) || name.length > 128) {
      ctx.addIssue({ code: 'custom', path: [name], message: `invalid env name ${name}` })
    } else if (secretLikeEnvName.test(name)) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `env ${name} looks like a credential: pass it through secrets (tmpfs)`,
      })
    } else if (value.includes('\0') || secretLikeEnvValues.some((re) => re.test(value))) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `the value of env ${name} looks like a credential: pass it through secrets (tmpfs)`,
      })
    }
  }
})

export const execCursorSchema = z.object({
  stdout: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  stderr: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export const execSpecSchema = z.object({
  argv: z.array(z.string().max(128 * 1024).refine((s) => !s.includes('\0'))).min(1).max(256)
    .refine((argv) => argv[0] !== '' && argv.reduce((n, s) => n + s.length, 0) <= 256 * 1024,
      'command must be nonempty and fit the argument budget'),
  cwd: z.string().max(1024).refine((path) => path.startsWith('/') && !path.includes('\0') &&
    (path === '/' || path.slice(1).split('/').every((s) => s !== '' && s !== '.' && s !== '..'))).optional(),
  env: sandboxEnvSchema.optional(),
  stdin: z.custom<AsyncIterable<Uint8Array>>((value) => value !== null &&
    typeof value === 'object' && Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function').optional(),
  timeoutMs: z.number().int().positive().max(MAX_SANDBOX_TURN_MS),
  signal: z.custom<AbortSignal>((value) => value !== null && typeof value === 'object' &&
    'aborted' in value && typeof value.aborted === 'boolean' &&
    'addEventListener' in value && typeof value.addEventListener === 'function').optional(),
}).strict() satisfies z.ZodType<ExecSpec>

export function assertExecSpec(spec: ExecSpec): ExecSpec {
  const parsed = execSpecSchema.safeParse(spec)
  if (!parsed.success) throw badRequest('Invalid sandbox exec specification')
  return parsed.data
}

const networkPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('gateway'),
      routes: z
        .array(z.enum(['llm', 'mcp']))
        .min(1)
        .max(2)
        .refine((routes) => new Set(routes).size === routes.length, 'duplicate route'),
    })
    .strict(),
])

/**
 * The invariants of CLAUDE.md rule 5 as a schema: image pinned by digest, uid/gid 10001,
 * at most 2 vCPU / 4096 MiB / 512 processes / 20 minutes, no network or only sandbox-gw with
 * the llm and mcp routes, no credentials in env, secret files outside /workspace and /agent-home.
 * Read-only rootfs has no switch at all (see SandboxSpec).
 */
export const sandboxSpecSchema = z
  .object({
    image: z
      .string()
      .max(512)
      .regex(digestPinnedImage, 'expected an image pinned by digest: repository@sha256:<64 hex>'),
    labels: z
      .object({
        workspaceId: labelId,
        siteId: labelId,
        taskId: labelId,
        sessionId: labelId,
        turn: z.number().int().positive(),
        leaseEpoch: z.number().int().positive().optional(),
      })
      .strict(),
    runtime: z.enum(sandboxRuntimes),
    resources: z
      .object({
        cpu: z.number().positive().max(MAX_SANDBOX_RESOURCES.cpu),
        memoryMiB: z.number().int().positive().max(MAX_SANDBOX_RESOURCES.memoryMiB),
        pids: z.number().int().positive().max(MAX_SANDBOX_RESOURCES.pids),
      })
      .strict(),
    user: z.object({ uid: z.literal(SANDBOX_UID), gid: z.literal(SANDBOX_GID) }).strict(),
    env: sandboxEnvSchema,
    secrets: z
      .array(z.object({ path: secretPath, value: z.string().min(1).max(65_536) }).strict())
      .max(32)
      .refine(
        (files) => new Set(files.map((f) => f.path)).size === files.length,
        'duplicate secret path',
      ),
    network: networkPolicySchema,
    hardTimeoutMs: z.number().int().positive().max(MAX_SANDBOX_TURN_MS),
  })
  .strict() satisfies z.ZodType<SandboxSpec>

/**
 * Validates a spec against the sandbox policy; providers call it before starting anything.
 * Throws BAD_REQUEST listing each violation by path and message, never echoing a value.
 */
export function assertSandboxSpec(spec: SandboxSpec): SandboxSpec {
  const parsed = sandboxSpecSchema.safeParse(spec)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
  throw badRequest(
    `Sandbox spec violates the sandbox policy (CLAUDE.md rule 5): ${issues
      .map((i) => `${i.path || '(root)'}: ${i.message}`)
      .join('; ')}`,
    issues,
  )
}
