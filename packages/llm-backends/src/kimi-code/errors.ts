import type { CallSignal, GatewayRefusal } from '@repo/domain'
import { encodeJson } from '../shared.ts'
import { object } from '../usage.ts'

// Exact wire messages from the Kimi error reference, captured with CLI f67e639.
// A message that merely contains these words must never affect an account's health.
const authMessages = new Set([
  'The API Key appears to be invalid or may have expired. Please verify your credentials and try again.',
  'Invalid Authentication',
])
const profileMessages = new Set([
  'Your current subscription does not have access to k3.  Upgrade to higher-tier Kimi Code plans. Upgrade: Upgrade: https://www.kimi.com/code?from=server_highspeed_error#pricing',
  'Your current plan supports only k3 up to 256K context. 1M context is available on higher-tier Kimi Code plans. Upgrade: https://www.kimi.com/code?from=server_k3_error#pricing',
  'Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans. Upgrade: Upgrade: https://www.kimi.com/code?from=server_highspeed_error#pricing',
])
const quotaMessages = new Set([
  "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
  "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
  "You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
])
const unknownModel =
  /^Your model id does not exist, recognized as other:[A-Za-z0-9._-]{1,128}\. Please set model id as `[A-Za-z0-9._-]{1,128}`\.$/

/** An SSE failure has no HTTP error status; recognize only the same exact reference messages. */
export function classifyKimiStreamFailure(errorJson: unknown): CallSignal {
  const error = object(object(errorJson)?.error)
  const message = typeof error?.message === 'string' ? error.message : ''
  if (authMessages.has(message)) return { kind: 'auth' }
  if (profileMessages.has(message) || unknownModel.test(message))
    return { kind: 'profile', code: 'model_access' }
  if (quotaMessages.has(message)) return { kind: 'window_exhausted', until: null }
  if (message === 'The request was rejected because it was considered high risk')
    return { kind: 'policy_flagged', code: 'high_risk' }
  if (
    message ===
    "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again."
  )
    return { kind: 'account_risk', reason: 'concurrent_request_limit' }
  return { kind: 'transient', retryAfterMs: 30_000 }
}

export function classifyKimi(status: number, headers: Headers, errorJson: unknown): CallSignal {
  if (status >= 200 && status < 300) return { kind: 'ok' }
  const error = object(object(errorJson)?.error)
  const message = typeof error?.message === 'string' ? error.message : ''
  if (status === 401) {
    if (profileMessages.has(message) || unknownModel.test(message))
      return { kind: 'profile', code: 'model_access' }
    if (authMessages.has(message)) return { kind: 'auth' }
    return { kind: 'unconfirmed_block' }
  }
  if (status === 403) {
    if (quotaMessages.has(message)) return { kind: 'window_exhausted', until: null }
    if (
      message ===
      "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again."
    )
      return { kind: 'account_risk', reason: 'concurrent_request_limit' }
    return { kind: 'unconfirmed_block' }
  }
  if (status === 400 && message === 'The request was rejected because it was considered high risk')
    return { kind: 'policy_flagged', code: 'high_risk' }
  // Repeated membership failures are counted by the gateway using the original HTTP status.
  if (status === 402) return { kind: 'transient', retryAfterMs: 300_000 }
  // The provider's fixed error type, never request text: the pinned CLI ends the turn on it
  // as exhausted quota (balance), unlike the overload and rate-limit types of a 429.
  if (
    status === 429 &&
    (error?.type === 'exceeded_current_quota_error' ||
      error?.code === 'exceeded_current_quota_error')
  )
    return { kind: 'window_exhausted', until: null }
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    const retry = headers.get('retry-after')
    const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : 30
    return { kind: 'transient', retryAfterMs: Math.min(30_000, Math.ceil(seconds * 1000)) }
  }
  // An unrecognized rejection of this one request: final for the turn, and no evidence about
  // the model profile, the account or the egress.
  return { kind: 'request_rejected', code: 'upstream_request' }
}

const messages: Record<GatewayRefusal, string> = {
  transient: 'Service temporarily unavailable.',
  budget: 'Turn budget exhausted.',
  subscription_limit: 'Subscription capacity exhausted.',
  account: 'Subscription account unavailable.',
  provider_off: 'Provider unavailable.',
  egress: 'Provider connection unavailable.',
  policy: 'Request violates gateway policy.',
  policy_flagged: 'Request rejected by content policy.',
  profile: 'Request does not match model profile.',
  request_rejected: 'Request rejected by the provider.',
}

export function kimiRefusal(kind: GatewayRefusal, retryAfterMs?: number) {
  const transient = kind === 'transient'
  const badRequest =
    kind === 'policy' ||
    kind === 'policy_flagged' ||
    kind === 'profile' ||
    kind === 'request_rejected'
  const headers = new Headers({ 'content-type': 'application/json' })
  if (transient) {
    const delay =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
        ? Math.max(0, retryAfterMs)
        : 30_000
    headers.set('retry-after', String(Math.min(30, Math.ceil(delay / 1000))))
  }
  return {
    status: transient ? 503 : badRequest ? 400 : 429,
    headers,
    body: encodeJson({
      error: {
        type: transient
          ? 'server_error'
          : badRequest
            ? 'invalid_request_error'
            : 'exceeded_current_quota_error',
        code: `raditi_${kind}`,
        message: messages[kind],
      },
    }),
  }
}
