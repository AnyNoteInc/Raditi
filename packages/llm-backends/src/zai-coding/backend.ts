import {
  badRequest,
  limitResetHorizonMs,
  limitResetPlausible,
  llmGatewayUnavailable,
  type EgressHttp,
  type LimitWindow,
  type LlmBackend,
  type LlmBackendId,
  type LlmRoute,
  type ProbeResult,
  type SubscriptionCredential,
} from '@repo/domain'
import { z } from 'zod'

import { createChatCompletionsUsageMeter } from '../chat-completions-usage.ts'
import { controlRequest, decodeControlJson } from '../shared.ts'
import { object } from '../usage.ts'
import { createZaiBodyPolicy } from './body.ts'
import { zaiClassifier, zaiProviderCode, zaiRefusal, type ZaiAnswers } from './errors.ts'
import { createZaiStreamInspector } from './stream.ts'

/**
 * What differs between the offers of Z.ai that speak the same chat completions protocol: the
 * addresses, the way the account's capacity is read and the codes one offer reads otherwise.
 * The adapter below is built from this description alone: each offer is a description and an
 * entry of the registry, and the role `llm` reads routes, egress and capacity from the port.
 */
export interface ZaiOffer {
  readonly id: LlmBackendId
  /** The route the CLI calls on the gateway; `sandbox-gw` lists the same path. */
  readonly route: LlmRoute
  readonly origin: `https://${string}`
  /** Chat completions under the origin. */
  readonly chatPath: `/${string}`
  /**
   * `windows`: the content-free quota request under the origin, and which of its limits is
   * which window of the pool (Z.ai names a period by a unit code and a count of units).
   * `none`: the offer has no windows; the content-free request under `authPath` only shows
   * whether the provider accepts the key, never what it may still spend.
   */
  readonly capacity:
    | {
        readonly kind: 'windows'
        readonly path: `/${string}`
        readonly windows: readonly {
          readonly unit: number
          readonly number: number
          readonly name: LimitWindow['name']
        }[]
      }
    | { readonly kind: 'none'; readonly authPath: `/${string}` }
  readonly answers: ZaiAnswers
  /** The variable that points the origin at a loopback fake on a stand. */
  readonly overrideEnv: string
  /** Whether a role with no egress node may connect to the origin itself. */
  readonly direct: boolean
}

/**
 * GLM Coding Plan: a subscription with credit windows. The unit codes are read off the reset
 * times of the recorded answers: 3 × 5 is five hours, 6 × 1 is one week.
 */
export const zaiCodingPlan: ZaiOffer = Object.freeze({
  id: 'zai-coding',
  route: Object.freeze({ method: 'POST', path: '/zai/v4/chat/completions' }),
  origin: 'https://api.z.ai',
  chatPath: '/api/coding/paas/v4/chat/completions',
  capacity: Object.freeze({
    kind: 'windows',
    path: '/api/monitor/usage/quota/limit',
    windows: Object.freeze([
      Object.freeze({ unit: 3, number: 5, name: '5h' }),
      Object.freeze({ unit: 6, number: 1, name: 'week' }),
    ]),
  }),
  // The shared table as it is: 1113 to a plan key is a plan it lacks.
  answers: Object.freeze({ codes: Object.freeze({}), codeless429: 'unconfirmed_block' }),
  overrideEnv: 'LLM_BACKEND_URL_ZAI_CODING',
  // The owner's decision of 05.10.2026: Z.ai is reached without the egress node.
  direct: true,
} as const)

/**
 * The pay-per-token API (owner's decision of 16.10.2026, П15): the same protocol and models
 * on `/api/paas/v4`, billed per token against the balance of the Z.ai account. It has no
 * windows; 1113 is its empty balance (sample 21: HTTP 429), and a 429 without a code is the
 * provider's own throttle. The probe asks the monitor path of the same origin, which answers a
 * refused key with its auth envelope (samples 10, 10d) and an accepted one with any other
 * envelope; it spends nothing and carries no content. One origin, so one stand variable.
 */
export const zaiApiOffer: ZaiOffer = Object.freeze({
  id: 'zai-api',
  route: Object.freeze({ method: 'POST', path: '/zai/paas/v4/chat/completions' }),
  origin: 'https://api.z.ai',
  chatPath: '/api/paas/v4/chat/completions',
  capacity: Object.freeze({ kind: 'none', authPath: '/api/monitor/usage/quota/limit' }),
  answers: Object.freeze({
    codes: Object.freeze({ '1113': 'balance_exhausted' }),
    codeless429: 'transient',
  }),
  overrideEnv: 'LLM_BACKEND_URL_ZAI_CODING',
  direct: true,
} as const)

export const zaiCredentialSchema = z
  .object({
    v: z.literal('1'),
    kind: z.literal('zai_api_key'),
    apiKey: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict()

/**
 * The one client of an account is the pinned CLI of the sandbox image (OpenCode 1.18.34): the
 * gateway admits its exact user agent and sends the same constant on, so nothing a client
 * wrote reaches the provider's headers. A new CLI version changes this line with the image.
 */
export const opencodeUserAgent = 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

function keyOf(credential: SubscriptionCredential): string {
  const parsed = zaiCredentialSchema.safeParse(credential)
  if (!parsed.success) throw badRequest('Invalid Z.ai credential')
  return parsed.data.apiKey
}

function assertClient(headers: Headers): void {
  if (headers.get('user-agent') !== opencodeUserAgent)
    throw badRequest('Invalid OpenCode client identity')
}

const emptyProbe = (status: ProbeResult['status']): ProbeResult => ({
  status,
  windows: null,
  plan: null,
})
const amount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** One limit of the quota answer as a window of the pool; null when it cannot be read. */
function parseLimit(raw: unknown, name: LimitWindow['name'], now: Date): LimitWindow | null {
  const item = object(raw)
  const size = amount(item?.usage)
  const spent = amount(item?.currentValue)
  const remaining = amount(item?.remaining)
  if (size === null || size <= 0 || spent === null || spent < 0 || remaining === null) return null
  const reset = item?.nextResetTime
  if (reset === undefined || reset === null) {
    // A window nobody has started has no reset time, and only a request can start it: it is
    // known and free, or the pool would wait for it for good. With anything spent it is a
    // report that cannot be read.
    return spent === 0 && remaining === size ? { name, usedPct: 0, resetsAt: null } : null
  }
  if (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset <= 0) return null
  const resetsAt = new Date(reset)
  const ahead = reset - now.getTime()
  if (ahead <= 0) {
    // The window has ended and the next request starts a new one. Not observed: the provider
    // stops naming the reset of an ended window. A reset further back than a window is long
    // is a broken report (seconds read as milliseconds), not a free window.
    return -ahead <= limitResetHorizonMs[name] ? { name, usedPct: 0, resetsAt: null } : null
  }
  if (!limitResetPlausible(resetsAt, now, name)) return null
  // A started window shows one credit less in `remaining` than `currentValue` accounts for,
  // from its first request on; the larger count is taken. The provider's own `percentage` is
  // rounded up to a whole percent and is not read.
  const used = Math.max(spent, size - remaining)
  if (remaining <= 0 || used >= size) return { name, usedPct: 100, resetsAt }
  return { name, usedPct: (used * 100) / size, resetsAt }
}

type WindowsCapacity = Extract<ZaiOffer['capacity'], { kind: 'windows' }>

function parseQuota(data: unknown, capacity: WindowsCapacity): ProbeResult {
  const limits = object(data)?.limits
  if (!Array.isArray(limits) || limits.length === 0) return emptyProbe('unknown')
  const now = new Date()
  const windows: LimitWindow[] = []
  for (const raw of limits) {
    const item = object(raw)
    const known =
      item?.type === 'CREDIT_LIMIT'
        ? capacity.windows.find(
            (window) => window.unit === item.unit && window.number === item.number,
          )
        : undefined
    // A limit of a kind or a period nobody has seen may bind the account as well: a malformed
    // or unknown declared limit must never disappear as spare capacity.
    if (!known || windows.some((window) => window.name === known.name)) return emptyProbe('unknown')
    const window = parseLimit(raw, known.name, now)
    if (window === null) return emptyProbe('unknown')
    windows.push(window)
  }
  // The level of the plan (`data.level`) is not the plan of the account's row: an operator
  // names that at import, and a probe that named another one would suspend the account.
  return { status: 'ok', windows, plan: null }
}

/**
 * The codes of a refused key on a request that carries one: the provider's own 401, and its
 * authentication codes 1000 (failed), 1001 (no key received) and 1003 (expired).
 */
const refusedKeyCodes = new Set(['401', '1000', '1001', '1003'])

/** Every adapter of a Z.ai offer: the same protocol, the description's addresses and capacity. */
export function createZaiBackend(offer: ZaiOffer): LlmBackend {
  const chatUrl = `${offer.origin}${offer.chatPath}`
  const capacity = offer.capacity
  const probeUrl = `${offer.origin}${capacity.kind === 'windows' ? capacity.path : capacity.authPath}`
  const classifier = zaiClassifier(offer.answers)
  const inspector = () => createZaiStreamInspector(offer.answers)
  const assertRoute = (route: LlmRoute) => {
    if (route.method !== offer.route.method || route.path !== offer.route.path)
      throw badRequest('Unsupported backend route')
  }

  /** The one content-free request of a probe; controlRequest replaces errors that may quote the key. */
  function ask(credential: SubscriptionCredential, http: EgressHttp) {
    const headers = new Headers({
      authorization: `Bearer ${keyOf(credential)}`,
      accept: 'application/json',
      'accept-encoding': 'identity',
      // The account's one client is the pinned CLI; the probe never names us or a gateway.
      'user-agent': opencodeUserAgent,
    })
    return controlRequest(http, { method: 'GET', url: probeUrl, headers })
  }

  /**
   * `unknown` is an answer the pool acts on: it drops the account's known windows. A request
   * that brought no answer about the account (transport failure, timeout, redirect, 5xx,
   * throttling, an unrecognized rejection) is therefore a rejection, which the caller ignores
   * and reports as a failed probe.
   */
  async function probeWindows(
    windows: WindowsCapacity,
    credential: SubscriptionCredential,
    http: EgressHttp,
  ): Promise<ProbeResult> {
    const response = await ask(credential, http)
    const body = decodeControlJson(response.body)
    let status = response.status
    if (status === 200) {
      if (body === null) return emptyProbe('unknown')
      if (body.success === true)
        return body.code === 200 ? parseQuota(body.data, windows) : emptyProbe('unknown')
      // The monitor paths answer an error as HTTP 200 with `{code, msg, success: false}`: it
      // is read like the same code under an error status, and never as a quota.
      if (body.success !== false) return emptyProbe('unknown')
      status = 418
    }
    const signal = classifier.classify(status, response.headers, body)
    // The request carries no content: a refused key is the key itself.
    if (signal.kind === 'auth') return emptyProbe('auth')
    if (signal.kind === 'account_risk') return emptyProbe('suspended')
    // The limit is reached, yet the reply names no window: what the pool knew no longer holds.
    if (signal.kind === 'window_exhausted') return emptyProbe('unknown')
    // A content-free request refused by anything but a provider error object (a filter page)
    // is the channel. An unrecognized provider error says nothing certain.
    if (response.status === 403 && object(body?.error) === undefined) return emptyProbe('region')
    throw llmGatewayUnavailable()
  }

  /**
   * An offer without windows asks one thing: does the provider take the key. A refused key
   * answers with its code; any other envelope of the monitor path (a quota, an error of the
   * path itself) was given to an accepted key, and says nothing of the balance — an empty one
   * shows only on a call, as its own signal. Anything else is no answer.
   */
  async function probeKey(
    credential: SubscriptionCredential,
    http: EgressHttp,
  ): Promise<ProbeResult> {
    const response = await ask(credential, http)
    const body = decodeControlJson(response.body)
    const code = zaiProviderCode(body)
    if (response.status === 401 || (code !== null && refusedKeyCodes.has(code)))
      return emptyProbe('auth')
    if (response.status === 200 && typeof body?.success === 'boolean')
      return { status: 'ok', windows: null, plan: null }
    // A provider envelope with a code is no filter page, whatever its status.
    if (response.status === 403 && code === null && object(body?.error) === undefined)
      return emptyProbe('region')
    throw llmGatewayUnavailable()
  }

  return {
    id: offer.id,
    capacity: capacity.kind,
    importCredential(secret) {
      const parsed = zaiCredentialSchema.safeParse({ v: '1', kind: 'zai_api_key', apiKey: secret })
      if (!parsed.success) throw badRequest('Invalid subscription credential input')
      return parsed.data
    },
    routes: [offer.route],
    credentialSchema: zaiCredentialSchema,
    clientHeaders: ['user-agent'],
    responseHeaders: [],
    egress: [
      {
        origin: offer.origin,
        overrideEnv: offer.overrideEnv,
        requests: [`POST ${chatUrl}`, `GET ${probeUrl}`],
        ...(offer.direct ? { direct: true } : {}),
      },
    ],
    validateClientHeaders: assertClient,
    streamInspector: inspector,
    credentialMetadata(credential) {
      keyOf(credential)
      return { externalAccountId: null, plan: null, accessExpiresAt: null, accessIssuedAt: null }
    },
    normalizeBody: createZaiBodyPolicy(offer.route),
    upstream(route, _body, clientHeaders, credential) {
      assertRoute(route)
      assertClient(clientHeaders)
      // The plan key instead of the turn key, the CLI's own identity, an uncompressed stream:
      // the egress passes bytes on without decoding them. No session header, no cookie.
      const headers = new Headers({
        authorization: `Bearer ${keyOf(credential)}`,
        'user-agent': opencodeUserAgent,
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
        'content-type': 'application/json',
      })
      return { url: chatUrl, method: 'POST', headers }
    },
    usageMeter: () => createChatCompletionsUsageMeter(inspector),
    classify: classifier.classify,
    refusal: zaiRefusal,
    probe: (credential, http) =>
      capacity.kind === 'windows'
        ? probeWindows(capacity, credential, http)
        : probeKey(credential, http),
  }
}

export const zaiCodingBackend: LlmBackend = createZaiBackend(zaiCodingPlan)
export const zaiApiBackend: LlmBackend = createZaiBackend(zaiApiOffer)
