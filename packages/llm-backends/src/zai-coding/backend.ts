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
import { classifyZai, zaiRefusal } from './errors.ts'
import { createZaiStreamInspector } from './stream.ts'

/**
 * What differs between the offers of Z.ai that speak the same chat completions protocol: the
 * addresses and the way the account's capacity is read. The adapter below is built from this
 * description alone, so another offer (the pay-per-token API on `/api/paas/v4`, which has no
 * plan windows) is another description and another entry of the registry; the role `llm` reads
 * routes, egress and windows from the port and does not change.
 */
export interface ZaiOffer {
  readonly id: LlmBackendId
  /** The route the CLI calls on the gateway; `sandbox-gw` lists the same path. */
  readonly route: LlmRoute
  readonly origin: `https://${string}`
  /** Chat completions under the origin. */
  readonly chatPath: `/${string}`
  /**
   * The content-free quota request under the origin, and which of its limits is which window
   * of the pool: Z.ai names a period by a unit code and a count of units.
   */
  readonly quota: {
    readonly path: `/${string}`
    readonly windows: readonly {
      readonly unit: number
      readonly number: number
      readonly name: LimitWindow['name']
    }[]
  }
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
  quota: Object.freeze({
    path: '/api/monitor/usage/quota/limit',
    windows: Object.freeze([
      Object.freeze({ unit: 3, number: 5, name: '5h' }),
      Object.freeze({ unit: 6, number: 1, name: 'week' }),
    ]),
  }),
  overrideEnv: 'LLM_BACKEND_URL_ZAI_CODING',
  // The owner's decision of 05.10.2026: Z.ai is reached without the egress node.
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
  creditsBalance: null,
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

function parseQuota(data: unknown, offer: ZaiOffer): ProbeResult {
  const limits = object(data)?.limits
  if (!Array.isArray(limits) || limits.length === 0) return emptyProbe('unknown')
  const now = new Date()
  const windows: LimitWindow[] = []
  for (const raw of limits) {
    const item = object(raw)
    const known =
      item?.type === 'CREDIT_LIMIT'
        ? offer.quota.windows.find(
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
  return { status: 'ok', windows, plan: null, creditsBalance: null }
}

/** Every adapter of a Z.ai offer: the same protocol, the description's addresses and windows. */
export function createZaiBackend(offer: ZaiOffer): LlmBackend {
  const chatUrl = `${offer.origin}${offer.chatPath}`
  const quotaUrl = `${offer.origin}${offer.quota.path}`
  const assertRoute = (route: LlmRoute) => {
    if (route.method !== offer.route.method || route.path !== offer.route.path)
      throw badRequest('Unsupported backend route')
  }

  /**
   * `unknown` is an answer the pool acts on: it drops the account's known windows. A request
   * that brought no answer about the account (transport failure, timeout, redirect, 5xx,
   * throttling, an unrecognized rejection) is therefore a rejection, which the caller ignores
   * and reports as a failed probe.
   */
  async function probe(
    credential: SubscriptionCredential,
    _identity: unknown,
    http: EgressHttp,
  ): Promise<ProbeResult> {
    const headers = new Headers({
      authorization: `Bearer ${keyOf(credential)}`,
      accept: 'application/json',
      'accept-encoding': 'identity',
      // The account's one client is the pinned CLI; the probe never names us or a gateway.
      'user-agent': opencodeUserAgent,
    })
    // controlRequest already replaces transport errors, which may quote the key.
    const response = await controlRequest(http, { method: 'GET', url: quotaUrl, headers })
    const body = decodeControlJson(response.body)
    let status = response.status
    if (status === 200) {
      if (body === null) return emptyProbe('unknown')
      if (body.success === true)
        return body.code === 200 ? parseQuota(body.data, offer) : emptyProbe('unknown')
      // The monitor paths answer an error as HTTP 200 with `{code, msg, success: false}`: it
      // is read like the same code under an error status, and never as a quota.
      if (body.success !== false) return emptyProbe('unknown')
      status = 418
    }
    const signal = classifyZai(status, response.headers, body)
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

  return {
    id: offer.id,
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
        requests: [`POST ${chatUrl}`, `GET ${quotaUrl}`],
        ...(offer.direct ? { direct: true } : {}),
      },
    ],
    validateClientHeaders: assertClient,
    streamInspector: createZaiStreamInspector,
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
    usageMeter: () => createChatCompletionsUsageMeter(createZaiStreamInspector),
    classify: classifyZai,
    // Responses of Z.ai carry no limit: the windows come from the quota request alone.
    windowsFromHeaders: () => null,
    refusal: zaiRefusal,
    probe,
  }
}

export const zaiCodingBackend: LlmBackend = createZaiBackend(zaiCodingPlan)
