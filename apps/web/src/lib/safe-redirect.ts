/** Where to go after sign-in when `next` is missing or unsafe. */
export const DEFAULT_AFTER_SIGN_IN = '/projects'

const PLACEHOLDER_ORIGIN = 'http://raditi.invalid'
const MAX_LENGTH = 2048

/** Auth pages that send a signed-in user away: as a target they would bounce or loop. */
const SIGNED_OUT_ONLY_PATHS = new Set(['/sign-in', '/sign-up', '/reset-password', '/verify-email'])

function hasControlOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    // URL parsers drop tabs and newlines and read "\" as "/": "/\tevil.com" becomes "//evil.com".
    if (code < 0x20 || code === 0x7f || value[i] === '\\') return true
  }
  return false
}

/** A path on this origin: not `//host`, `/\host`, or anything a parser could turn into one. */
function isLocalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !hasControlOrBackslash(value)
}

/**
 * A same-origin relative path to redirect to after sign-in, or the fallback. Rejects absolute
 * and protocol-relative URLs (`https://…`, `//evil.com`, `/\evil.com`), control characters,
 * API routes and the signed-out-only auth pages, so `?next=` cannot become an open redirect.
 */
export function safeRedirectTarget(
  raw: string | null | undefined,
  fallback: string = DEFAULT_AFTER_SIGN_IN,
): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return fallback
  if (!isLocalPath(raw)) return fallback

  let url: URL
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN)
  } catch {
    return fallback
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback
  const target = `${url.pathname}${url.search}${url.hash}`
  // Dot segments collapse while parsing: "/.//evil.com" and "/%2e//evil.com" become "//evil.com".
  if (!isLocalPath(target)) return fallback
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return fallback
  if (SIGNED_OUT_ONLY_PATHS.has(url.pathname.replace(/\/+$/, ''))) return fallback
  return target
}
