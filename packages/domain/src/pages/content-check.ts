import { pageLimits } from './limits.ts'

/**
 * The checks of what goes public (docs/plan/69-pages.md, Ст8, Ст19), by trusted code: the bytes
 * of a page, or the Markdown of a section of a document. What core alone can do — the values of
 * the client's variables, scanned by the outbox's scanner — is not here: this module sees no
 * secret. Nothing found is ever written to a log; only the reason is.
 */
export const pageRefusalReasons = [
  'not_utf8',
  'too_large',
  'password_form',
  'embedded_token',
  'turn_key',
  'client_value',
] as const
export type PageRefusalReason = (typeof pageRefusalReasons)[number]

export type PageContentVerdict = { ok: true } | { ok: false; reason: PageRefusalReason }

/** The forms of the platform's own keys of a turn (`@repo/turn-keys`): never on a page. */
export const TURN_KEY_PATTERNS: readonly RegExp[] = [
  /sk-rdt-[A-Za-z0-9_-]{20,}/,
  /mcp_[0-9a-f]{32,}/,
]

/**
 * Tokens and keys a page has no business carrying. Not a complete list — a second line beside
 * the instructions of the turn: common forms only, each long enough not to catch prose.
 */
export const EMBEDDED_TOKEN_PATTERNS: readonly RegExp[] = [
  // A JWT: two base64url JSON objects and a signature.
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{24,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\by0_[A-Za-z0-9_-]{40,}/,
  /\bAQVN[A-Za-z0-9_-]{30,}/,
]

const decoder = new TextDecoder('utf-8', { fatal: true })

/** The text of a page or a section, or null when it is not UTF-8. */
export function pageTextOf(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/** Tokens of a turn and of other services; the order says what is told: a turn key first. */
export function tokenReasonOf(text: string): 'turn_key' | 'embedded_token' | null {
  if (TURN_KEY_PATTERNS.some((pattern) => pattern.test(text))) return 'turn_key'
  if (EMBEDDED_TOKEN_PATTERNS.some((pattern) => pattern.test(text))) return 'embedded_token'
  return null
}

const PASSWORD_INPUT = /<input\b[^>]*?(?:^|[\s"'/])type\s*=\s*["']?password\b/i
/** Opening tags of a form and of the controls that may send one somewhere else. */
const SENDING_TAG = /<(form|button|input)\b([^>]*)>/gi
/** One attribute by its whole name: `data-action=` is not `action=`. */
const attributeOf = (attributes: string, name: string): string | null => {
  const match = new RegExp(
    `(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(attributes)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

/** Where a form sends what is typed in it is not the page itself. */
function leavesPage(target: string | null): boolean {
  if (target === null) return false
  const value = target.trim().toLowerCase()
  if (value === '' || value.startsWith('#')) return false
  return /^[a-z][a-z0-9+.-]*:/.test(value) || value.startsWith('//') || value.startsWith('\\')
}

/**
 * A page with a password field and a form that sends elsewhere — its `action`, or `formaction`
 * of a button or an input: a page that asks a visitor for a password for someone else is the
 * platform's phishing, whatever the CSP stops (Ст8). The page as a whole is judged, not one form:
 * a field joins any form by `form="id"`, so a password field and an outward form anywhere refuse
 * the page.
 */
export function hasOutwardPasswordForm(html: string): boolean {
  if (!PASSWORD_INPUT.test(html)) return false
  for (const [, tag = '', attributes = ''] of html.matchAll(SENDING_TAG)) {
    const name = tag.toLowerCase() === 'form' ? 'action' : 'formaction'
    if (leavesPage(attributeOf(attributes, name))) return true
  }
  return false
}

/** The checks of the bytes of a page as served (`html` — the agent's; `reading` — drawn by the platform). */
export function checkPageContent(
  bytes: Uint8Array,
  options: { maxBytes?: number } = {},
): PageContentVerdict {
  if (bytes.byteLength > (options.maxBytes ?? pageLimits.contentBytes))
    return { ok: false, reason: 'too_large' }
  const text = pageTextOf(bytes)
  if (text === null) return { ok: false, reason: 'not_utf8' }
  const token = tokenReasonOf(text)
  if (token) return { ok: false, reason: token }
  if (hasOutwardPasswordForm(text)) return { ok: false, reason: 'password_form' }
  return { ok: true }
}

/**
 * The checks the mcp role makes of a section while the turn goes (Ст19): the same, without the
 * values of the client's variables — core scans for those at the end of the turn.
 */
export function checkSectionText(markdown: string): PageContentVerdict {
  const bytes = new TextEncoder().encode(markdown)
  if (bytes.byteLength > pageLimits.sectionBytes) return { ok: false, reason: 'too_large' }
  const token = tokenReasonOf(markdown)
  if (token) return { ok: false, reason: token }
  if (hasOutwardPasswordForm(markdown)) return { ok: false, reason: 'password_form' }
  return { ok: true }
}
