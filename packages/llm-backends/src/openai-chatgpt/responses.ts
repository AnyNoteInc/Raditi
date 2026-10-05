import {
  limitResetPlausible,
  llmGatewayUnavailable,
  refusalForSignal,
  type CallSignal,
  type GatewayRefusal,
  type LimitWindow,
  type LimitWindowSnapshot,
  type LlmBackend,
  type ProbeResult,
} from '@repo/domain'
import { controlRequest, decodeControlJson, encodeJson } from '../shared.ts'
import { object } from '../usage.ts'
import { codexCredentialSchema, codexPlanPattern } from './credentials.ts'
import { codexUrls } from './egress.ts'

const policyCodes = new Set([
  'cyber_policy',
  'bio_policy',
  'invalid_prompt',
  'misalignment_policy_violation',
])
const riskCodes = new Set(['usage_not_included', 'insufficient_quota'])
const transientCodes = new Set(['rate_limit_exceeded', 'server_is_overloaded', 'slow_down'])
// The request does not fit the model's window. It is final for the turn and, unlike an
// unrecognized failure, says nothing about the account, its limits or the egress.
const contextCode = 'context_length_exceeded'

function timestamp(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? date : null
}

/** A reset further ahead than its window is long is a broken report (p3-design §2.5). */
const implausible = (resetsAt: Date | null, window?: LimitWindow['name']): boolean =>
  resetsAt !== null && !limitResetPlausible(resetsAt, new Date(), window)

/** Shared by HTTP failures and SSE terminals; never inspect messages or echo unknown codes. */
export function codexFailureSignal(error: unknown): CallSignal | null {
  const value = object(error)
  for (const code of [value?.code, value?.type]) {
    if (typeof code !== 'string') continue
    if (policyCodes.has(code)) return { kind: 'policy_flagged', code }
    if (riskCodes.has(code)) return { kind: 'account_risk', reason: code }
    if (transientCodes.has(code)) return { kind: 'transient', retryAfterMs: 30_000 }
    if (code === 'unsupported_country_region_territory') return { kind: 'region' }
    if (code === contextCode) return { kind: 'request_rejected', code }
    if (code === 'usage_limit_reached') {
      const until = timestamp(value?.resets_at)
      return { kind: 'window_exhausted', until: implausible(until) ? null : until }
    }
  }
  return null
}

function retryDelay(headers: Headers): number {
  const value = headers.get('retry-after')
  if (value === null) return 30_000
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.min(30_000, Math.ceil(Number(value) * 1000))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, Math.min(30_000, date - Date.now())) : 30_000
}

export const classifyCodexResponse: LlmBackend['classify'] = (status, headers, errorJson) => {
  if (status >= 200 && status < 300) return { kind: 'ok' }
  if (status === 401) return { kind: 'auth' }
  const signal = codexFailureSignal(object(errorJson)?.error)
  if (signal !== null)
    return signal.kind === 'transient' ? { ...signal, retryAfterMs: retryDelay(headers) } : signal
  if (status === 403) return { kind: 'unconfirmed_block' }
  if (status === 429 || status === 408 || status >= 500 || status < 400)
    return { kind: 'transient', retryAfterMs: retryDelay(headers) }
  // An unrecognized 4xx rejects this one request; the model profile is not at fault.
  return { kind: 'request_rejected', code: 'provider_request_rejected' }
}

/** Past its limit the backend keeps answering on credits; the window itself is exhausted. */
function percentage(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, 100)
    : null
}

function decimal(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ? value : null
}

function headerNumber(headers: Headers, key: string): number | undefined {
  const value = headers.get(key)
  return value !== null && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined
}

const windowSeconds = [
  ['5h', 18_000],
  ['week', 604_800],
] as const

/** The pinned CLI names a window by a declared length within 5% of it; any other is unknown. */
function windowName(seconds: unknown): LimitWindow['name'] | null {
  if (typeof seconds !== 'number') return null
  for (const [name, length] of windowSeconds)
    if (seconds >= length * 0.95 && seconds <= length * 1.05) return name
  return null
}

/**
 * `null` means the response reported nothing, and the previous snapshot stands; so do the known
 * windows when it carries a balance and no window header (`windows: null`). A malformed
 * declared window or balance instead yields an empty window list: the consumer then drops
 * the capacity it knew, so a broken report can never keep serving as spare capacity.
 */
export function codexWindowsFromHeaders(headers: Headers): LimitWindowSnapshot | null {
  const windows: LimitWindow[] = []
  let malformed = false
  let declared = false
  for (const prefix of ['primary', 'secondary']) {
    const base = `x-codex-${prefix}`
    if (![...headers.keys()].some((name) => name.startsWith(`${base}-`))) continue
    declared = true
    const usedPct = percentage(headerNumber(headers, `${base}-used-percent`))
    const minutes = headerNumber(headers, `${base}-window-minutes`)
    const rawReset = headers.get(`${base}-reset-at`)
    // Observed on weekly-only plans: the unused slot is all zero with an empty reset.
    // A real reset (including epoch zero), missing companions, or nonzero usage is not
    // this sentinel and must still pass the ordinary window validation below.
    if (
      usedPct === 0 &&
      minutes === 0 &&
      headerNumber(headers, `${base}-reset-after-seconds`) === 0 &&
      (rawReset === null || rawReset === '')
    )
      continue
    const name = windowName(minutes === undefined ? undefined : minutes * 60)
    const resetsAt = timestamp(headerNumber(headers, `${base}-reset-at`))
    if (
      usedPct === null ||
      name === null ||
      (rawReset !== null && resetsAt === null) ||
      implausible(resetsAt, name) ||
      windows.some((window) => window.name === name)
    )
      malformed = true
    else windows.push({ name, usedPct, resetsAt })
  }
  const rawCredits = headers.get('x-codex-credits-balance')
  const creditsBalance = decimal(rawCredits)
  // Like the CLI, read an empty balance as none reported (seen for other unused fields).
  if (rawCredits !== null && rawCredits !== '' && creditsBalance === null) malformed = true
  if (malformed) return { windows: [], creditsBalance }
  // Declared slots that name no window (all unused) stay an empty, unknown report.
  if (declared) return { windows, creditsBalance }
  return creditsBalance === null ? null : { windows: null, creditsBalance }
}

const refusalMessages: Record<GatewayRefusal, string> = {
  transient: 'Service temporarily unavailable',
  budget: 'Attempt budget reached',
  subscription_limit: 'Subscription capacity unavailable',
  account: 'Subscription account unavailable',
  provider_off: 'Provider unavailable',
  egress: 'Provider connection unavailable',
  policy: 'Request violates gateway policy',
  policy_flagged: 'Request rejected by content policy',
  profile: 'Model profile unavailable',
  request_rejected: 'Request rejected by the provider',
}

const badRequestKinds: readonly GatewayRefusal[] = [
  'policy',
  'policy_flagged',
  'profile',
  'request_rejected',
]

function refusalError(kind: GatewayRefusal, code: string) {
  return {
    type:
      kind === 'transient'
        ? 'server_error'
        : badRequestKinds.includes(kind)
          ? 'invalid_request_error'
          : 'usage_limit_reached',
    code,
    message: refusalMessages[kind],
  }
}

export const codexRefusal: LlmBackend['refusal'] = (kind, retryAfterMs) => {
  const transient = kind === 'transient'
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })
  if (transient) {
    const delay =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : 30_000
    headers.set('retry-after', String(Math.max(0, Math.min(30, Math.ceil(delay / 1000)))))
  }
  return {
    status: transient ? 503 : badRequestKinds.includes(kind) ? 400 : 429,
    headers,
    body: encodeJson({ error: refusalError(kind, `raditi_${kind}`) }),
  }
}

/**
 * After `response.failed` the pinned CLI reads `error.code` alone: on a code it does not
 * know (ours included; `error.type` is ignored) it reconnects `stream_max_retries` times,
 * and every reconnect is another provider request. A final refusal therefore borrows a
 * code the CLI ends the turn on, with our message; a short-lived one keeps ours so the CLI
 * does reconnect. Measured with CLI 0.158.0, kept proven by `pnpm verify:llm-gateway`.
 */
const streamCodes: Record<GatewayRefusal, string> = {
  transient: 'raditi_transient',
  budget: 'insufficient_quota',
  subscription_limit: 'insufficient_quota',
  account: 'insufficient_quota',
  provider_off: 'insufficient_quota',
  egress: 'insufficient_quota',
  policy: 'invalid_prompt',
  policy_flagged: 'invalid_prompt',
  profile: 'invalid_prompt',
  request_rejected: 'invalid_prompt',
}

export function codexStreamError(signal: CallSignal) {
  const kind = refusalForSignal(signal)
  // The CLI's own terminal code for an overflow, so it reports the turn as out of context.
  const overflow = signal.kind === 'request_rejected' && signal.code === contextCode
  return refusalError(kind, overflow ? contextCode : streamCodes[kind])
}

export function codexAccountHeaders(
  credential: Parameters<LlmBackend['probe']>[0],
  identity: Parameters<LlmBackend['probe']>[1],
): Headers {
  const parsed = codexCredentialSchema.safeParse(credential)
  // Zod issues can contain secret property values in future versions; do not propagate them.
  if (!parsed.success) throw new Error('Invalid Codex credential')
  if (
    typeof identity.installationId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(identity.installationId)
  )
    throw new Error('Invalid Codex client identity')
  return new Headers({
    authorization: `Bearer ${parsed.data.accessToken}`,
    'chatgpt-account-id': parsed.data.chatgptAccountId,
    'x-codex-installation-id': identity.installationId,
    'accept-encoding': 'identity',
  })
}

const emptyProbe = (status: ProbeResult['status']): ProbeResult => ({
  status,
  windows: null,
  plan: null,
  creditsBalance: null,
})

/** A provider error object in the shape `classify` reads, as opposed to a WAF page. */
function structuredError(body: Record<string, unknown> | null): boolean {
  const error = object(body?.error)
  return typeof error?.code === 'string' || typeof error?.type === 'string'
}

/**
 * `unknown` is an answer the pool acts on: it drops the account's known windows. A request
 * that brought no answer about the account (transport failure, timeout, 5xx, throttling,
 * an unrecognized rejection) is therefore a rejection, which the caller ignores.
 */
export const probeCodexAccount: LlmBackend['probe'] = async (credential, identity, http) => {
  const headers = codexAccountHeaders(credential, identity)
  headers.set('accept', 'application/json')
  headers.set('originator', 'codex_cli_rs')
  headers.set('user-agent', 'codex_cli_rs/0.158.0')
  // controlRequest already replaces transport errors, which may quote the token.
  const response = await controlRequest(http, {
    url: codexUrls.usage,
    method: 'GET',
    headers,
  })
  const body = decodeControlJson(response.body)
  const signal = classifyCodexResponse(response.status, response.headers, body)
  if (signal.kind === 'auth') return emptyProbe('auth')
  if (signal.kind === 'region') return emptyProbe('region')
  // Only a 403 without a structured error counts as an egress block (p3-design §2.5).
  // A structured refusal of this account's own metadata request concerns the account.
  if (signal.kind === 'unconfirmed_block')
    return emptyProbe(structuredError(body) ? 'suspended' : 'region')
  if (signal.kind === 'account_risk') return emptyProbe('suspended')
  // The limit is reached, yet the reply names no window: what the pool knew no longer holds.
  if (signal.kind === 'window_exhausted') return emptyProbe('unknown')
  if (signal.kind !== 'ok') throw llmGatewayUnavailable()
  // Any well-formed slug passes: the pool compares it with the plan recorded at login, so
  // a plan introduced later is either accepted or reported as changed, never silently unknown.
  if (body === null || typeof body.plan_type !== 'string' || !codexPlanPattern.test(body.plan_type))
    return emptyProbe('unknown')
  const limits = object(body.rate_limit)
  if (body.rate_limit != null && limits === undefined) return emptyProbe('unknown')
  for (const flag of ['allowed', 'limit_reached'])
    if (limits?.[flag] !== undefined && typeof limits[flag] !== 'boolean')
      return emptyProbe('unknown')
  const windows: LimitWindow[] = []
  for (const key of ['primary_window', 'secondary_window']) {
    if (limits?.[key] === undefined || limits[key] === null) continue
    const window = object(limits[key])
    const usedPct = percentage(window?.used_percent)
    const name = windowName(window?.limit_window_seconds)
    const resetsAt = timestamp(window?.reset_at)
    if (
      usedPct === null ||
      name === null ||
      (window?.reset_at != null && resetsAt === null) ||
      implausible(resetsAt, name) ||
      windows.some((existing) => existing.name === name)
    )
      return emptyProbe('unknown')
    windows.push({ name, usedPct, resetsAt })
  }
  if (
    (limits?.allowed === false || limits?.limit_reached === true) &&
    !windows.some((window) => window.usedPct === 100)
  )
    return emptyProbe('unknown')
  const credits = object(body.credits)
  if (body.credits != null && credits === undefined) return emptyProbe('unknown')
  const creditsBalance = decimal(credits?.balance)
  if (credits?.balance != null && creditsBalance === null) return emptyProbe('unknown')
  return {
    status: 'ok',
    windows: windows.length > 0 ? windows : null,
    plan: body.plan_type,
    creditsBalance,
  }
}
