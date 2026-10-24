import {
  browserVerificationLimits,
  browserVerifiedObjectSchema,
  isBrowserVerificationPlan,
  type BrowserVerificationPlan,
  type BrowserVerificationReading,
  type BrowserVerificationReply,
} from '@repo/domain'

/**
 * A trusted read of the site through the session's own sign-in (docs/plan/57-browser-tasks.md,
 * Б22): the stack's plan of GET requests, sent by the context's request API with the cookies of
 * the pages and no script of theirs, then the stack's pure reading of the answers. Only what the
 * reading found leaves — never a body. A redirect is followed between the site's own origins only
 * (its address and its `www.` twin, where the site may send its admin); any step that fails makes
 * the whole read `unreadable`, never a guess.
 */

/** One GET as the request API answered it; `bytes` null — larger than a reply may be. */
export interface VerificationResponse {
  status: number
  location: string | null
  bytes: Uint8Array | null
}

/** Sends one GET with these headers and the session's cookies, no redirect followed. */
export type VerificationFetch = (
  url: string,
  headers: Record<string, string>,
) => Promise<VerificationResponse>

const REDIRECTS = new Set([301, 302, 303, 307, 308])
/** Same-origin redirects one step follows (`/wp-json` → `/wp-json/`). */
const MAX_HOPS = 3
/** A value an earlier step gives a header: a nonce, one printable token. */
const HEADER_VALUE = /^[\x21-\x7e]{1,512}$/
const UNREADABLE: BrowserVerificationReading = Object.freeze({ state: 'unreadable' })

class Unreadable extends Error {}

function body(bytes: Uint8Array | null, readAs: 'text' | 'json'): unknown {
  if (bytes === null) return null
  const text = new TextDecoder().decode(bytes)
  if (readAs === 'text') return text
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function headersOf(
  step: BrowserVerificationPlan['steps'][number],
  replies: readonly BrowserVerificationReply[],
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(step.headers ?? {})) {
    if (typeof value === 'string') {
      headers[name] = value
      continue
    }
    const earlier = replies.find((reply) => reply.id === value.fromStep)?.body
    const token = typeof earlier === 'string' ? earlier.trim() : ''
    if (!HEADER_VALUE.test(token)) throw new Unreadable()
    headers[name] = token
  }
  return headers
}

/** Where a read goes: the site's origin it starts on, and the site's origins it may be sent to. */
export interface VerificationSite {
  origin: string
  origins: ReadonlySet<string>
}

async function fetchStep(
  fetch: VerificationFetch,
  site: VerificationSite,
  path: string,
  headers: Record<string, string>,
): Promise<VerificationResponse> {
  let url = new URL(path, site.origin)
  for (let hop = 0; ; hop++) {
    const response = await fetch(url.href, headers)
    const next =
      REDIRECTS.has(response.status) && response.location !== null
        ? URL.parse(response.location, url)
        : null
    // A redirect off the site is answered as it is: the reading sees no body, nothing follows.
    if (next === null || !site.origins.has(next.origin)) return response
    if (hop >= MAX_HOPS) throw new Unreadable()
    url = next
  }
}

/** Runs a plan within `browserVerificationLimits`; what is outside them is not run at all. */
export async function runVerification(
  plan: BrowserVerificationPlan,
  site: VerificationSite,
  fetch: VerificationFetch,
): Promise<BrowserVerificationReading> {
  if (!isBrowserVerificationPlan(plan)) return UNREADABLE
  const replies: BrowserVerificationReply[] = []
  try {
    for (const step of plan.steps) {
      const response = await fetchStep(fetch, site, step.path, headersOf(step, replies))
      replies.push({
        id: step.id,
        status: response.status,
        body: body(response.bytes, step.readAs),
      })
    }
    const reading = plan.read(replies)
    if (reading.state !== 'verified')
      return reading.state === 'missing' ? { state: 'missing' } : UNREADABLE
    // What a reading claims goes on only in the shape the session and the feed accept.
    const object = browserVerifiedObjectSchema.safeParse(reading.object)
    return object.success ? { state: 'verified', object: object.data } : UNREADABLE
  } catch {
    return UNREADABLE
  }
}

/** The bound of one reply's body, for the request API's caller. */
export const VERIFICATION_REPLY_BYTES = browserVerificationLimits.replyBytes
