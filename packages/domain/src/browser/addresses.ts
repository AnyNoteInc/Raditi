import { BROWSER_HIDDEN_VALUE } from './observation.ts'
import { browserSessionLimits } from './session.ts'

/**
 * Addresses the agent reads (docs/plan/57-browser-tasks.md, Б20; CLAUDE.md rule 2): the address of
 * the shown page and of each tab, the addresses of the objects `web_verify` found, the links of an
 * observation. A page may carry a secret in its query — the key of a password reset, a nonce, a
 * token of a sign-in — or in its fragment (`#access_token=…`, the route of an admin screen with a
 * visitor's record); the model gets none of it. The path and the harmless parameters stay, so the
 * agent still knows where it is: `post.php?post=12&action=edit&_wpnonce=[hidden]`.
 */

/**
 * Words of a parameter name that say its value is a secret, also inside a longer name
 * (`_wpnonce`, `rp_key`, `access_token`, `PHPSESSID`): `pass` holds `password`, `sig` —
 * `signature`, `sess` — `session`. A harmless name is sometimes hidden too (`country_code`); that
 * costs the agent nothing it acts on.
 */
const SECRET_PARAMETER =
  /key|token|nonce|pass|pwd|secret|code|hash|auth|sig|reset|sess|otp|jwt|ticket|credential/i
/** Names that hold such a word and name nothing secret: an author, a keyword, a preset. */
const HARMLESS_WORDS = /author(?!i[sz])|keywords?|preset/gi

/** Whether a parameter of a query or a fragment carries a secret by its name. */
export const isSecretParameterName = (name: string): boolean =>
  SECRET_PARAMETER.test(decoded(name).replace(HARMLESS_WORDS, ' '))

/** `name=value` after the start or a separator of a query or a fragment. */
const PAIR = /(^|[?&;#])([^=?&;#]*)=([^?&;#]*)/g

/** A part of an address with `+` read as a space and its escapes undone; as written if broken. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replaceAll('+', ' '))
  } catch {
    return text
  }
}

function hasSecretPair(text: string): boolean {
  for (const [, , name, value] of text.matchAll(PAIR))
    if (value !== '' && isSecretParameterName(name ?? '')) return true
  return false
}

/**
 * A value that is itself an address or a query with a secret parameter (`redirect_to`,
 * `_wp_http_referer`), escaped once or more.
 */
function carriesSecret(value: string): boolean {
  let text = value
  for (let round = 0; round < 3; round++) {
    const next = decoded(text)
    if (next === text) return false
    text = next
    if (hasSecretPair(text)) return true
  }
  return false
}

/** A query or a fragment with the value of each secret parameter replaced by `[hidden]`. */
function redactPairs(text: string): string {
  return text.replace(PAIR, (pair: string, separator: string, name: string, value: string) =>
    value !== '' && (isSecretParameterName(name) || carriesSecret(value))
      ? `${separator}${name}=${BROWSER_HIDDEN_VALUE}`
      : pair,
  )
}

/** The path, the query (after `?`, null — none) and the fragment (after `#`, null — none). */
function partsOf(address: string): { path: string; query: string | null; fragment: string | null } {
  const hash = address.indexOf('#')
  const before = hash < 0 ? address : address.slice(0, hash)
  const fragment = hash < 0 ? null : address.slice(hash + 1)
  const mark = before.indexOf('?')
  return mark < 0
    ? { path: before, query: null, fragment }
    : { path: before.slice(0, mark), query: before.slice(mark + 1), fragment }
}

/**
 * The address of a page as the agent reads it: the path as it is, each secret parameter of the
 * query hidden, the fragment hidden whole. Applying it again changes nothing. A marker longer than
 * the value it hides never stretches the address past the bound of a tab's address: the query
 * then goes whole.
 */
export function redactBrowserAddress(address: string): string {
  const { path, query, fragment } = partsOf(address)
  const tail = fragment === null ? '' : fragment === '' ? '#' : `#${BROWSER_HIDDEN_VALUE}`
  const redacted = `${path}${query === null ? '' : `?${redactPairs(query)}`}${tail}`
  const limit = Math.max(address.length, browserSessionLimits.urlChars)
  if (redacted.length <= limit) return redacted
  const whole = `${path}?${BROWSER_HIDDEN_VALUE}${tail}`
  return whole.length <= limit ? whole : path
}

/**
 * A link of a page as the agent reads it: like a page's address, but its fragment keeps its route
 * (an anchor of the text, a screen of an admin page) and loses only the values of its secret
 * parameters. The link of a post's text is content the agent may edit; it is read as written.
 */
export function redactLinkAddress(address: string): string {
  const { path, query, fragment } = partsOf(address)
  return `${path}${query === null ? '' : `?${redactPairs(query)}`}${fragment === null ? '' : `#${redactPairs(fragment)}`}`
}

/** `- /url: …` of Playwright's tree: the target of a link, plain or in double quotes. */
const TREE_LINK = /^( *- \/url: )(.*)$/

/**
 * An observation tree with the secret parameters of its links hidden (`redactLinkAddress`). The
 * quoting of a value stays as Playwright wrote it: the marker adds no character YAML escapes.
 */
export function redactTreeAddresses(tree: string): string {
  return tree
    .split('\n')
    .map((line) => {
      const match = TREE_LINK.exec(line)
      if (!match) return line
      const [, prefix = '', value = ''] = match
      const quoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      const address = quoted ? value.slice(1, -1) : value
      const redacted = redactLinkAddress(address)
      return `${prefix}${quoted ? `"${redacted}"` : redacted}`
    })
    .join('\n')
}

/** Fields of a tool's answer that hold an address. */
const ADDRESS_FIELDS: ReadonlySet<string> = new Set(['url', 'editUrl'])

/**
 * A tool's answer (`BrowserToolResult`) with every address in it redacted before the agent reads
 * it: `url` and `editUrl` at any depth (the page, the tabs, the objects of a check) as a page's
 * address, the links of `tree`. A copy; the answer itself is left as it is.
 */
export function redactResultAddresses<T>(result: T): T {
  const visit = (value: unknown, field: string | null): unknown => {
    if (typeof value === 'string') {
      if (field === 'tree') return redactTreeAddresses(value)
      return field !== null && ADDRESS_FIELDS.has(field) ? redactBrowserAddress(value) : value
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, null))
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, visit(child, key)]),
      )
    return value
  }
  return visit(result, null) as T
}
