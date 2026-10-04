import {
  badRequest,
  limitResetPlausible,
  llmGatewayUnavailable,
  type ClientIdentity,
  type EgressHttp,
  type LlmBackend,
  type LimitWindow,
  type ProbeResult,
  type SubscriptionCredential,
} from '@repo/domain'
import { z } from 'zod'
import { controlRequest, decodeControlJson } from '../shared.ts'
import { object } from '../usage.ts'
import { assertKimiRoute, normalizeKimiBody } from './body.ts'
import { classifyKimi, kimiRefusal } from './errors.ts'
import { createKimiUsageMeter } from './usage.ts'
import { createKimiStreamInspector } from './stream.ts'

export const kimiCredentialSchema = z
  .object({
    v: z.literal('1'),
    kind: z.literal('kimi_api_key'),
    apiKey: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict()

function authHeaders(credential: SubscriptionCredential, identity: ClientIdentity): Headers {
  const parsed = kimiCredentialSchema.safeParse(credential)
  if (!parsed.success) throw badRequest('Invalid Kimi credential')
  for (const value of [identity.deviceId, identity.deviceName]) {
    if (value === undefined || !/^[\x21-\x7e][\x20-\x7e]{0,255}$/.test(value))
      throw badRequest('Invalid Kimi device identity')
  }
  return new Headers({
    authorization: `Bearer ${parsed.data.apiKey}`,
    'x-msh-device-id': identity.deviceId!,
    'x-msh-device-name': identity.deviceName!,
    'accept-encoding': 'identity',
  })
}

// The pinned CLI (the sandbox image). The gateway admits its patch releases as the same client.
const cliVersion = '2.1.1'
const cliUserAgent = /^kimi-code-cli\/2\.1\.\d+$/
const cliPlatform = 'kimi_code_cli'
// The client headers of the pinned CLI that reach the provider; the device headers are ours.
const metadataHeaders = ['x-msh-platform', 'x-msh-version']
const forwardedHeaders = ['user-agent', ...metadataHeaders]
// Every URL this adapter sends a request to; `egress` below declares exactly these.
const origin = 'https://api.kimi.ai'
const completionsUrl = `${origin}/coding/v1/chat/completions`
const usagesUrl = `${origin}/coding/v1/usages`

const emptyProbe = (status: ProbeResult['status']): ProbeResult => ({
  status,
  windows: null,
  plan: null,
  creditsBalance: null,
})
const resetTimeSchema = z.iso.datetime({ offset: true })

function parseWindow(raw: unknown, name: LimitWindow['name']): LimitWindow | null {
  const item = object(raw)
  const ratio = item?.used_ratio
  const numeric =
    typeof ratio === 'number'
      ? ratio
      : typeof ratio === 'string' && /^\d+(?:\.\d+)?$/.test(ratio)
        ? Number(ratio)
        : Number.NaN
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const reset = item?.reset_time
  let resetsAt: Date | null = null
  // Like the pinned CLI, an empty reset time is none reported.
  if (reset !== undefined && reset !== null && reset !== '') {
    if (typeof reset !== 'string' || !resetTimeSchema.safeParse(reset).success) return null
    resetsAt = new Date(reset)
    if (!Number.isFinite(resetsAt.getTime())) return null
    // A reset further ahead than the window is long is a broken report, not a pause of years.
    if (!limitResetPlausible(resetsAt, new Date(), name)) return null
  }
  // Use past the limit leaves a ratio above 1; the window itself is exhausted.
  return { name, usedPct: Math.min(numeric, 1) * 100, resetsAt }
}

/** The published CLI exposes quotas, not a verified subscription plan or credit balance. */
function parseQuota(payload: Record<string, unknown> | null): ProbeResult {
  const usages = object(payload?.usages)
  if (usages === undefined) return emptyProbe('unknown')
  const windows: LimitWindow[] = []
  const monthly: LimitWindow[] = []
  for (const [key, name] of [
    ['limit_5h', '5h'],
    ['limit_7d', 'week'],
    ['limit_month_total', 'month'],
    ['limit_month_code', 'month'],
  ] as const) {
    // A plan without this window (new plans have no week) does not report it.
    if (!Object.hasOwn(usages, key) || usages[key] === null) continue
    const window = parseWindow(usages[key], name)
    // A malformed declared window must never disappear as spare capacity.
    if (window === null) return emptyProbe('unknown')
    if (name === 'month') monthly.push(window)
    else windows.push(window)
  }
  if (monthly.length > 0) {
    // Both quotas limit coding, and the port has one month slot: it carries the most used
    // quota and that quota's reset. Once that reset passes, the pool asks for fresh usage
    // instead of keeping an exhausted quota cooled until the other one resets.
    const usedPct = Math.max(...monthly.map((window) => window.usedPct))
    const binding = monthly.filter((window) => window.usedPct === usedPct)
    windows.push({
      name: 'month',
      usedPct,
      resetsAt: binding.some((window) => window.resetsAt === null)
        ? null
        : new Date(Math.max(...binding.map((window) => window.resetsAt!.getTime()))),
    })
  }
  if (windows.length === 0) return emptyProbe('unknown')
  return { status: 'ok', windows, plan: null, creditsBalance: null }
}

/**
 * `unknown` is an answer the pool acts on: it drops the account's known windows. A request
 * that brought no answer about the account (transport failure, timeout, redirect, 5xx,
 * throttling, an unrecognized rejection) is therefore a rejection, which the caller ignores
 * and reports as a failed probe.
 */
async function probe(
  credential: SubscriptionCredential,
  identity: ClientIdentity,
  http: EgressHttp,
): Promise<ProbeResult> {
  const headers = authHeaders(credential, identity)
  // The account's one client is the pinned CLI; the probe never names us or a gateway.
  headers.set('user-agent', `kimi-code-cli/${cliVersion}`)
  headers.set('x-msh-platform', cliPlatform)
  headers.set('x-msh-version', cliVersion)
  headers.set('accept', 'application/json')
  // controlRequest already replaces transport errors, which may quote the key.
  const response = await controlRequest(http, {
    method: 'GET',
    url: usagesUrl,
    headers,
  })
  const body = decodeControlJson(response.body)
  if (response.status === 200) return parseQuota(body)
  const signal = classifyKimi(response.status, response.headers, body)
  // The request carries no content: a 401 other than a plan message is the key itself.
  if (response.status === 401 && signal.kind !== 'profile') return emptyProbe('auth')
  if (signal.kind === 'account_risk') return emptyProbe('suspended')
  // The limit is reached, yet the reply names no window: what the pool knew no longer holds.
  if (signal.kind === 'window_exhausted') return emptyProbe('unknown')
  // A content-free request refused by anything but a provider error object (a WAF page) is
  // the egress (p3-design §2.5). An unrecognized provider error says nothing certain.
  if (response.status === 403 && object(body?.error) === undefined) return emptyProbe('region')
  throw llmGatewayUnavailable()
}

export const kimiCodeBackend: LlmBackend = {
  id: 'kimi-code',
  importCredential(secret) {
    const parsed = kimiCredentialSchema.safeParse({ v: '1', kind: 'kimi_api_key', apiKey: secret })
    if (!parsed.success) throw badRequest('Invalid subscription credential input')
    return parsed.data
  },
  routes: [{ method: 'POST', path: '/kimi/v1/chat/completions' }],
  credentialSchema: kimiCredentialSchema,
  clientHeaders: forwardedHeaders,
  responseHeaders: [],
  egress: [
    {
      origin,
      overrideEnv: 'LLM_BACKEND_URL_KIMI_CODE',
      requests: [`POST ${completionsUrl}`, `GET ${usagesUrl}`],
    },
  ],
  validateClientHeaders(headers) {
    const value = headers.get('user-agent')
    if (value === null || !cliUserAgent.test(value))
      throw badRequest('Invalid Kimi client identity')
    for (const name of metadataHeaders) {
      const header = headers.get(name)
      if (header !== null && header.length > 256) throw badRequest('Invalid Kimi client identity')
    }
  },
  streamInspector: createKimiStreamInspector,
  credentialMetadata(credential) {
    if (!kimiCredentialSchema.safeParse(credential).success)
      throw badRequest('Invalid Kimi credential')
    return { externalAccountId: null, plan: null, accessExpiresAt: null, accessIssuedAt: null }
  },
  normalizeBody: normalizeKimiBody,
  upstream(route, _body, clientHeaders, credential, identity) {
    assertKimiRoute(route)
    const userAgent = clientHeaders.get('user-agent')
    if (userAgent === null || !cliUserAgent.test(userAgent))
      throw badRequest('Invalid Kimi client identity')
    const headers = authHeaders(credential, identity)
    for (const name of forwardedHeaders) {
      const value = clientHeaders.get(name)
      if (value !== null) {
        if (value.length > 256) throw badRequest('Invalid Kimi client identity')
        headers.set(name, value)
      }
    }
    headers.set('content-type', 'application/json')
    headers.set('accept', 'text/event-stream')
    return { url: completionsUrl, method: 'POST', headers }
  },
  usageMeter: createKimiUsageMeter,
  classify: classifyKimi,
  windowsFromHeaders: () => null,
  refusal: kimiRefusal,
  probe,
}
