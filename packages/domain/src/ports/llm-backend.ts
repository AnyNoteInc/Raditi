import { z } from 'zod'

/** Stable provider slugs, shared with llm_providers; provider details belong in adapters. */
export const llmBackendIds = ['openai-chatgpt', 'kimi-code', 'zai-coding'] as const
export const llmBackendIdSchema = z.enum(llmBackendIds)
export type LlmBackendId = z.infer<typeof llmBackendIdSchema>

export interface LlmRoute {
  method: 'POST' | 'GET'
  path: `/${string}`
}

export interface LlmStreamEvent {
  event: string
  data: string
}

export interface LlmStreamFailure {
  kind: 'failure'
  event: LlmStreamEvent
  signal: CallSignal
}

export type LlmStreamInspection =
  | { kind: 'forward'; event: LlmStreamEvent; terminal?: true }
  | LlmStreamFailure
  | { kind: 'skip' }
  | { kind: 'invalid' }

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nullableDate = z.date().nullable()

/**
 * Gateway usage from the provider, not the CLI's informational TokenUsage. Input is the
 * total, including both cache buckets; output already includes reasoning. Inconsistent
 * provider usage must become an estimate, never a negative cost (spec §9 «Учёт»).
 */
export const callUsageSchema = z
  .object({
    input: count,
    cacheRead: count,
    cacheWrite: count,
    output: count,
    reasoning: count,
  })
  .strict()
  .superRefine((usage, ctx) => {
    // Subtract instead of adding the cache buckets: their sum could exceed safe integers.
    if (usage.cacheRead > usage.input || usage.cacheWrite > usage.input - usage.cacheRead)
      ctx.addIssue({
        code: 'custom',
        path: ['input'],
        message: 'input must include cache reads and writes',
      })
    if (usage.reasoning > usage.output)
      ctx.addIssue({
        code: 'custom',
        path: ['reasoning'],
        message: 'reasoning must be included in output',
      })
  })
export type CallUsage = z.infer<typeof callUsageSchema>

export const limitWindowSchema = z
  .object({
    name: z.enum(['5h', 'week', 'month']),
    usedPct: z.number().min(0).max(100),
    resetsAt: nullableDate,
  })
  .strict()
export type LimitWindow = z.infer<typeof limitWindowSchema>

export const limitWindowsSchema = z
  .array(limitWindowSchema)
  .max(3)
  .refine((windows) => new Set(windows.map((window) => window.name)).size === windows.length, {
    message: 'limit window names must be unique',
  })

const hourMs = 3_600_000
/**
 * How far ahead of now a window's reset can lie: its length plus slack. A later reset is a
 * corrupted report (milliseconds read as seconds), never a reason to cool an account for years
 * or to outrank later snapshots. Adapters void such a report; the gateway checks again before
 * it writes a pause.
 */
export const limitResetHorizonMs: Readonly<Record<LimitWindow['name'], number>> = Object.freeze({
  '5h': 6 * hourMs,
  week: 8 * 24 * hourMs,
  month: 32 * 24 * hourMs,
})

/** An exhaustion signal names no window: without one the weekly horizon applies. */
export function limitResetPlausible(
  resetsAt: Date,
  now: Date,
  window: LimitWindow['name'] = 'week',
): boolean {
  return resetsAt.getTime() - now.getTime() <= limitResetHorizonMs[window]
}

/** The adapter maps provider errors to allowlisted codes, never raw response text. */
const signalCode = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)
export const callSignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok') }).strict(),
  z.object({ kind: z.literal('transient'), retryAfterMs: count }).strict(),
  z.object({ kind: z.literal('window_exhausted'), until: nullableDate }).strict(),
  z.object({ kind: z.literal('auth') }).strict(),
  z.object({ kind: z.literal('account_risk'), reason: signalCode }).strict(),
  z.object({ kind: z.literal('region') }).strict(),
  // A block nobody has confirmed: the account is probed. The code is the adapter's own name
  // for what the provider answered, kept for the log of the role.
  z.object({ kind: z.literal('unconfirmed_block'), code: signalCode.optional() }).strict(),
  z.object({ kind: z.literal('policy_flagged'), code: signalCode }).strict(),
  // The plan or the catalogue lacks the model of the turn's profile.
  z.object({ kind: z.literal('profile'), code: signalCode }).strict(),
  // The provider rejected this one request (it does not fit the model's window, a shape it
  // does not accept). Final for the turn; the profile, account, limits and egress are fine.
  z.object({ kind: z.literal('request_rejected'), code: signalCode }).strict(),
])
export type CallSignal = z.infer<typeof callSignalSchema>

// Credits are provider units, not rubles; preserve their decimal precision as a string.
const creditsBalance = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
  .nullable()
export const probeResultSchema = z
  .object({
    status: z.enum(['ok', 'auth', 'region', 'suspended', 'unknown']),
    windows: limitWindowsSchema.nullable(),
    plan: z.string().min(1).nullable(),
    creditsBalance,
  })
  .strict()
export type ProbeResult = z.infer<typeof probeResultSchema>

export const limitWindowSnapshotSchema = z
  .object({
    /** null: the response named no window. Empty: a window report that cannot be read. */
    windows: limitWindowsSchema.nullable(),
    creditsBalance,
  })
  .strict()
export type LimitWindowSnapshot = z.infer<typeof limitWindowSnapshotSchema>

export const meterResultSchema = z
  .object({
    usage: callUsageSchema.nullable(),
    /** incomplete means no complete provider terminal, including a disconnected SSE tail. */
    outcome: z.enum(['completed', 'failed', 'incomplete']),
    signal: callSignalSchema.nullable(),
    usageIssue: z.enum(['no_usage', 'invalid_usage']).nullable(),
    deltaTextBytes: count,
  })
  .strict()
  .superRefine((result, ctx) => {
    if ((result.usage === null) !== (result.usageIssue !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['usageIssue'],
        message: 'missing usage needs a reason',
      })
    if (result.signal !== null && (result.outcome !== 'failed' || result.signal.kind === 'ok'))
      ctx.addIssue({
        code: 'custom',
        path: ['signal'],
        message: 'only failed streams carry a signal',
      })
  })
export type MeterResult = z.infer<typeof meterResultSchema>

export const normalizedBodySchema = z
  .object({ body: z.instanceof(Uint8Array), estInputTokens: count })
  .strict()
export type NormalizedBody = z.infer<typeof normalizedBodySchema>

export const gatewayRefusalSchema = z.enum([
  'transient',
  'budget',
  'subscription_limit',
  'account',
  'provider_off',
  'egress',
  'policy',
  'policy_flagged',
  'profile',
  'request_rejected',
])
export type GatewayRefusal = z.infer<typeof gatewayRefusalSchema>

/**
 * The refusal a provider signal stands for: the one mapping behind the HTTP answer, the event
 * of an already started stream and llm_keys.last_refusal. A new signal kind does not compile
 * until it is given its refusal here.
 */
export function refusalForSignal(signal: CallSignal): GatewayRefusal {
  switch (signal.kind) {
    case 'ok':
    case 'transient':
      return 'transient'
    case 'window_exhausted':
      return 'subscription_limit'
    case 'auth':
    case 'account_risk':
    case 'unconfirmed_block':
      return 'account'
    case 'region':
      return 'egress'
    case 'policy_flagged':
    case 'profile':
    case 'request_rejected':
      return signal.kind
    default: {
      const unknown: never = signal
      void unknown
      throw new Error('Unknown call signal')
    }
  }
}

/**
 * Adapter-owned Vault payload: the common port neither assumes OAuth fields nor knows
 * their meaning. credentialSchema validates the full versioned shape in each adapter.
 * Values exist only in Vault and the llm process's memory, never in plans, logs or DTOs.
 */
export type SubscriptionCredential = Readonly<Record<string, unknown>>

/** Provider-neutral facts for login and refresh scheduling, including a credential restored from Vault. */
export const credentialMetadataSchema = z
  .object({
    externalAccountId: z.string().min(1).nullable(),
    plan: z.string().min(1).nullable(),
    accessExpiresAt: nullableDate,
    accessIssuedAt: nullableDate,
  })
  .strict()
  .refine(
    (value) =>
      value.accessExpiresAt === null ||
      value.accessIssuedAt === null ||
      value.accessExpiresAt.getTime() > value.accessIssuedAt.getTime(),
    { path: ['accessExpiresAt'], message: 'access expiry must be after issuance' },
  )
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>

/** Stable, non-secret account identity. Each adapter validates the subset it needs. */
export const clientIdentitySchema = z
  .object({
    installationId: z.string().min(1).optional(),
    deviceId: z.string().min(1).optional(),
    deviceName: z.string().min(1).optional(),
  })
  .strict()
export type ClientIdentity = z.infer<typeof clientIdentitySchema>

/**
 * One fixed provider origin and every request an adapter sends there: generation, probe, token
 * refresh and revocation, device login. Nothing else leaves: the transport refuses a request
 * outside these lists before any connection, through the egress node and without it alike.
 */
export interface LlmEgressOrigin {
  /** An https origin: scheme, host and optional port only. */
  readonly origin: string
  /** Exact requests under the origin as `METHOD URL`, without query or fragment. */
  readonly requests: readonly string[]
  /** The variable that points the origin at a loopback fake on a stand; refused in production. */
  readonly overrideEnv: string
  /**
   * True: the provider needs no egress node, and a role that has none configured connects to
   * this origin itself. Otherwise the origin is reached through the node's proxy only, and
   * without one not at all. With a proxy configured every origin goes through it.
   */
  readonly direct?: boolean
}

/** Checked by every consumer before use: a declaration must never read wider than written. */
export const llmEgressOriginSchema = z
  .strictObject({
    origin: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/),
    requests: z
      .array(z.string().regex(/^(?:GET|POST) https:\/\/[^\s?#]+$/))
      .min(1)
      .readonly(),
    overrideEnv: z.string().regex(/^LLM_[A-Z0-9_]+$/),
    direct: z.boolean().optional(),
  })
  .refine(
    (entry) =>
      entry.requests.every((request) =>
        ['GET', 'POST'].some((method) => request.startsWith(`${method} ${entry.origin}/`)),
      ),
    { path: ['requests'], message: 'requests must stay under their origin' },
  )

/** An in-memory upstream request; its headers/body may contain subscription secrets. */
export interface EgressRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Headers
  body?: Uint8Array
}

/** Bounded, buffered control response; generation streams use the gateway's streaming path. */
export interface EgressResponse {
  status: number
  headers: Headers
  body: Uint8Array
}

/**
 * Injected transport for probe, refresh, device flow and revoke. Implementations use only
 * the configured egress, reject redirects and bound response size. Every request needs a
 * bounded AbortSignal supplied by the adapter/gateway (refresh: 20 s), including body read.
 * The domain declares the contract and performs no I/O.
 */
export interface EgressHttp {
  request(request: EgressRequest, options: { signal: AbortSignal }): Promise<EgressResponse>
}

export type RefreshOutcome =
  | { kind: 'ok'; credential: SubscriptionCredential }
  | { kind: 'final'; reason: 'auth' | 'region' }
  // A request may have rotated the refresh token. Retrying the old one can revoke the grant.
  | { kind: 'ambiguous' }

/** All device-flow state, including the user code and private state, stays in memory. */
export interface DeviceLoginState {
  verificationUri: string
  userCode: string
  expiresAt: Date
  intervalMs: number
  /** Adapter-owned, may contain device tokens or PKCE verifier; never serialize or log it. */
  privateState: unknown
}

export type DeviceLoginResult =
  | { kind: 'pending'; intervalMs: number }
  | { kind: 'next'; request: EgressRequest; state: DeviceLoginState }
  | {
      kind: 'complete'
      credential: SubscriptionCredential
    }
  | { kind: 'denied' }

/** Pure builders/parsers; the caller owns transport, bounded polling and Vault writes. */
export interface DeviceLogin {
  start(identity: ClientIdentity): EgressRequest
  parseStart(response: EgressResponse, now: Date): DeviceLoginState
  poll(state: DeviceLoginState): EgressRequest
  /** `next` also handles the code exchange; explicit now bounds login and dates the credential. */
  parsePoll(response: EgressResponse, state: DeviceLoginState, now: Date): DeviceLoginResult
}

/** Subscription backend port (spec §9; p3-design §11). No provider branches in the core. */
export interface LlmBackend {
  readonly id: LlmBackendId
  readonly routes: readonly LlmRoute[]
  readonly credentialSchema: z.ZodType<SubscriptionCredential>
  /**
   * Lower-case names of the client headers this adapter reads or forwards. The gateway hands
   * `validateClientHeaders` and `upstream` these and its own neutral ones only, and refuses a
   * request that repeats one of them. The rules for their values stay in the adapter.
   */
  readonly clientHeaders: readonly string[]
  /** Lower-case names of the provider response headers that go back to the CLI. */
  readonly responseHeaders: readonly string[]
  /** Every provider request of this adapter; the egress and its configuration derive from it. */
  readonly egress: readonly LlmEgressOrigin[]
  /** Extract facts without making the caller interpret provider-specific token fields. */
  credentialMetadata(credential: SubscriptionCredential): CredentialMetadata
  /** CLI identity is checked by its adapter before any call is reserved. */
  validateClientHeaders(headers: Headers): void
  /**
   * Per-stream policy: provider failure metadata must never reach the sandbox. `end` is asked
   * once when the provider closes the stream cleanly before an event the inspector took for
   * its end: an adapter whose CLI cannot stop on a silently ended stream answers with the
   * failure to send as the last event; null leaves the ending to the gateway.
   */
  streamInspector(): {
    inspect(event: LlmStreamEvent): LlmStreamInspection
    end?(): LlmStreamFailure | null
  }
  /** Null effort leaves provider defaults; a client cannot select its own effort in that case. */
  normalizeBody(
    route: LlmRoute,
    body: Uint8Array,
    ctx: { model: string; reasoningEffort: string | null; cacheKey: string },
  ): NormalizedBody
  upstream(
    route: LlmRoute,
    body: NormalizedBody,
    clientHeaders: Headers,
    credential: SubscriptionCredential,
    identity: ClientIdentity,
  ): { url: string; method: string; headers: Headers }
  usageMeter(): { push(chunk: Uint8Array): void; end(): MeterResult }
  classify(status: number, headers: Headers, errorJson: unknown | null): CallSignal
  /**
   * The subscription's limits as a response reports them. null: it reported nothing, and the
   * gateway keeps what it knows. `windows: null`: it named no window (a balance only), so the
   * known windows stand. Empty `windows`: a window report it cannot read, so the account's
   * capacity becomes unknown until the next probe — never unlimited.
   */
  windowsFromHeaders(headers: Headers): LimitWindowSnapshot | null
  /** CLI-shaped refusal, assembled locally; provider bodies never go back to the sandbox. */
  refusal(
    kind: GatewayRefusal,
    retryAfterMs?: number,
  ): { status: number; headers: Headers; body: Uint8Array }
  /**
   * A content-free check of the account through the egress. Rejects when there is no answer
   * to judge the account by (transport failure, 5xx, an unknown status): the caller changes
   * nothing. `unknown` is an answer that drops the account's known capacity until a later probe.
   */
  probe(
    credential: SubscriptionCredential,
    identity: ClientIdentity,
    http: EgressHttp,
  ): Promise<ProbeResult>
  refresh?(credential: SubscriptionCredential, http: EgressHttp): Promise<RefreshOutcome>
  login?: DeviceLogin
  /** Import-only secret input; the adapter builds its versioned credential before a probe. */
  importCredential?(secret: string): SubscriptionCredential
  revoke?(credential: SubscriptionCredential, http: EgressHttp): Promise<void>
}
