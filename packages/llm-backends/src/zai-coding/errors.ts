import type { CallSignal, GatewayRefusal } from '@repo/domain'

import { encodeJson } from '../shared.ts'
import { object } from '../usage.ts'

const shortPauseMs = 30_000

/**
 * Z.ai names an error by a number: `{"error":{"code":"1211",…}}` on the chat path,
 * `{"code":401,…,"success":false}` with HTTP 200 on the monitor paths. Only that number is
 * read, never the text next to it.
 */
function providerCode(errorJson: unknown): string | null {
  const body = object(errorJson)
  const raw = object(body?.error)?.code ?? body?.code
  if (typeof raw === 'string') return /^\d{1,6}$/.test(raw) ? raw : null
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 999_999
    ? String(raw)
    : null
}

/**
 * Decision 9 of the plan. Measured: 401 (a refused key), 1113, 1210, 1211. The other codes
 * are those of the provider's documentation as read on 05.10.2026; no answer with them has
 * been observed, so the code decides whatever status carries it.
 */
function signalOfCode(code: string, headers: Headers): CallSignal | null {
  switch (code) {
    case '401':
      return { kind: 'auth' }
    case '1302':
    case '1305':
      return { kind: 'transient', retryAfterMs: pauseOf(headers) }
    // The reset is read from the quota by a probe, never parsed out of the text.
    case '1308':
    case '1310':
    case '1316':
    case '1317':
      return { kind: 'window_exhausted', until: null }
    case '1113':
    case '1309':
    case '1313':
      return { kind: 'account_risk', reason: `zai_${code}` }
    case '1211':
    case '1311':
      return { kind: 'profile', code: `zai_${code}` }
    case '1301':
      return { kind: 'policy_flagged', code: `zai_${code}` }
    case '1261':
      return { kind: 'request_rejected', code: `zai_${code}` }
    default:
      return null
  }
}

/** The provider's pause in whole or fractional seconds, never longer than the short one. */
function pauseOf(headers: Headers): number {
  const value = headers.get('retry-after')
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return shortPauseMs
  const pause = Math.ceil(Number(value) * 1000)
  return pause <= shortPauseMs ? pause : shortPauseMs
}

const unconfirmed = (code: string | null): CallSignal =>
  code === null ? { kind: 'unconfirmed_block' } : { kind: 'unconfirmed_block', code: `zai_${code}` }

export function classifyZai(status: number, headers: Headers, errorJson: unknown): CallSignal {
  if (status >= 200 && status < 300) return { kind: 'ok' }
  const code = providerCode(errorJson)
  const known = code === null ? null : signalOfCode(code, headers)
  if (known) return known
  if (status === 401) return { kind: 'auth' }
  if (status === 408 || status === 409 || status >= 500)
    return { kind: 'transient', retryAfterMs: pauseOf(headers) }
  // An unrecognized rejection of this one request: final for the turn, and no evidence about
  // the model profile, the account or the limits.
  if (status === 400)
    return { kind: 'request_rejected', code: code === null ? 'zai_http_400' : `zai_${code}` }
  // Anything else ends the turn and makes the role read the quota.
  return unconfirmed(code)
}

/** An error object of a started stream has no status: the code table, else an unconfirmed block. */
export function classifyZaiStreamError(errorJson: unknown): CallSignal {
  const code = providerCode(errorJson)
  return (code === null ? null : signalOfCode(code, new Headers())) ?? unconfirmed(code)
}

// The pinned CLI repeats a request whose refusal holds a word or a number of its retry list
// and compacts the context on a word of its overflow list; inside a stream «exhausted» and
// «unavailable» are enough (fixtures/opencode-cli.ts). The final texts hold none of them; the
// short-lived one is meant to be repeated. Three of them are the texts the spike measured.
const messages: Record<GatewayRefusal, string> = {
  transient: 'Service temporarily unavailable.',
  budget: 'The budget of this turn is spent.',
  subscription_limit: 'The subscription of this turn has no capacity left.',
  account: 'The account of this turn cannot be used.',
  provider_off: 'The provider of this turn is switched off.',
  egress: 'The provider of this turn cannot be reached.',
  policy: 'The request is not allowed by the policy of this turn.',
  policy_flagged: 'The request was declined by the content policy.',
  profile: 'The request does not fit the model profile of this turn.',
  request_rejected: 'The provider declined this request.',
}
const badRequests = new Set<GatewayRefusal>([
  'policy',
  'policy_flagged',
  'profile',
  'request_rejected',
])

/**
 * Decision 6 of the plan, measured in the spike: 400 and 403 with this body end a turn of the
 * CLI in one request; 503 is repeated five times after `retry-after` each.
 */
export function zaiRefusal(kind: GatewayRefusal, retryAfterMs?: number) {
  const transient = kind === 'transient'
  const headers = new Headers({ 'content-type': 'application/json' })
  if (transient) {
    const delay =
      retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : shortPauseMs
    // Never zero: the CLI would send its five retries at once.
    headers.set('retry-after', String(Math.min(30, Math.max(1, Math.ceil(delay / 1000)))))
  }
  return {
    status: transient ? 503 : badRequests.has(kind) ? 400 : 403,
    headers,
    body: encodeJson({
      error: {
        type: transient ? 'server_error' : 'invalid_request_error',
        code: `raditi_${kind}`,
        message: messages[kind],
      },
    }),
  }
}
