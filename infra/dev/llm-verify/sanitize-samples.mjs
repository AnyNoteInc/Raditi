import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// The only way a recorded exchange of the OpenCode and Z.ai probe gets into the repository
// (docs/research/2026-10-opencode-glm; the rule is section 3 of pivot-plan.md there). It works by
// shape and never needs the plan key:
//   - header values survive only for ALLOWED_HEADERS, in an object, a list of pairs or Node's flat
//     `rawHeaders`, under any property whose name ends in `headers`; the names of the others stay
//     as a list, and which credential a request carried stays as a structure without the value;
//   - anything shaped like a key, a bearer value, a JWT, a cookie, an assigned secret or the
//     platform's MCP token of a turn becomes `<removed>`, in bodies, streams and plain text
//     alike; so does the value of an Authorization or Cookie line, of the user part of a URL and
//     of a JSON property named like a secret;
//   - identifiers of the provider and of the CLI (request and log ids, trace ids, `created` of a
//     completion, session, tool call and project ids) become placeholders of the same shape,
//     the same raw value always the same placeholder within one pass, so a tool result still
//     points at its call; property names are cleaned like values;
//   - paths of the machine the probe ran on become `<repo>`, `<scratchpad>`, `/Users/<user>` and
//     `/home/<user>`.
// What it cannot see: a secret of no known shape in a place of no known name, a value cut across
// stream chunks, and anything encoded (base64, hex). The shapes are those of Z.ai's chat
// completions and of the OpenCode CLI; ids of other API forms are not all known to it.
// Commands:
//   node sanitize-samples.mjs copy --from <dir> --to <dir> <entry>...   sanitise entries of <dir>;
//                                               nothing is written unless every output passes `check`
//   node sanitize-samples.mjs check <path>...   fail when a file would still be changed
//   node sanitize-samples.mjs scan <path>...    report what the rules find; exit 1 on a secret
// A finding names the rule and the line. Of a secret it gives the length only, of an identifier
// the first characters too.
// A `.json` file is a recorded exchange unless its entry is given as `text:<path>` (copy, check):
// then it is a script of the probe and only the text rules apply.

export const ALLOWED_HEADERS = Object.freeze(['content-type', 'retry-after'])
const REMOVED = '<removed>'
/** 2026-01-01T00:00:00Z: every `created` of a completion, so that it dates nothing. */
const CREATED = 1767225600

const hex = (number, width) => number.toString(16).padStart(width, '0')

// Values that only stand for a credential: a placeholder, a template, the stand's dummy tokens.
const STANDS_FOR = /^(?:<|\$\{|raditi-glm-dummy-|invalid-key$)/
const tokenLike = (value, long) =>
  !STANDS_FOR.test(value) && (/\d/.test(value) || value.length >= long)

const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|invalid|example|test|localhost)$/i

/** Names that end like the name of a secret: `RADITI_MCP_TOKEN`, `x-api-key`, `signature`. */
const SECRET_NAME = '(?:api[_-]?key|[_-]key|secret|token|password|passwd|signature)'
const SECRET_NAME_END = new RegExp(`${SECRET_NAME}$`, 'i')
const SECRET_VALUE = /^[A-Za-z0-9._~+/=-]{20,}$/

/** The parts of a cookie that say how it is kept, not what it holds. */
const COOKIE_ATTRIBUTES = new Set(['path', 'domain', 'max-age', 'expires', 'samesite', 'priority'])
const COOKIE_PAIR = /([\w!#$%&*+.^`|~-]+)=([^;,\s"'\\]*)/g
/** A cookie header value with every cookie value removed; names and attributes stay. */
const withoutCookieValues = (value) =>
  value.replace(COOKIE_PAIR, (pair, name, held) =>
    COOKIE_ATTRIBUTES.has(name.toLowerCase()) || held.startsWith('<') || !/[A-Za-z0-9]/.test(held)
      ? pair
      : `${name}=${REMOVED}`,
  )

// In this order: a later rule never sees what an earlier one replaced.
const SECRET_RULES = [
  {
    rule: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g,
    replace: (match) => match.replace(/[^\n]+/g, REMOVED),
  },
  // No word boundary in front: a token glued to a letter is a token still.
  { rule: 'jwt', pattern: /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, replace: () => REMOVED },
  // The platform's own MCP token of a turn (`mcp_` and 64 hex digits, apps/orchestrator/src/llm/
  // turn-key.ts): anywhere, glued to a letter, in either case, with whatever hex follows it.
  // Before the rules that need a name or a scheme: the report then says which kind it was.
  { rule: 'mcp-token', pattern: /mcp_[0-9a-f]{64,}/gi, replace: () => REMOVED },
  {
    rule: 'bearer',
    pattern: /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (match, scheme, space, token) =>
      tokenLike(token, 24) ? `${scheme}${space}${REMOVED}` : null,
  },
  {
    rule: 'assigned-secret',
    pattern: new RegExp(
      `\\b([\\w-]*${SECRET_NAME})(\\\\?["']?\\s*[:=]\\s*\\\\?["']?)([A-Za-z0-9._~+/=-]{20,})`,
      'gi',
    ),
    replace: (match, name, between, value) =>
      tokenLike(value, Infinity) ? `${name}${between}${REMOVED}` : null,
  },
  // The key of the plan: 32 hex digits, a dot, a secret. Anywhere, also at the end of a longer
  // run of digits: removing too much costs nothing.
  {
    rule: 'plan-key',
    pattern: /[0-9a-f]{32}\.[A-Za-z0-9_-]{12,}/gi,
    replace: () => REMOVED,
  },
  {
    // An Authorization line of a log or of a form body, whatever the scheme: `token`, `Digest`,
    // none at all, a percent-encoded space after it. Name, separator and value on one line.
    rule: 'authorization',
    pattern:
      /\b((?:proxy-)?authorization)(\\?["']?[ \t]*[:=][ \t]*\\?["']?)((?:[A-Za-z][\w-]*(?:[ \t]+|%20))?)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (match, name, between, scheme, value) =>
      tokenLike(value, 24) ? `${name}${between}${scheme}${REMOVED}` : null,
  },
  { rule: 'sk-key', pattern: /(?<![A-Za-z0-9])sk-[\w-]{20,}/g, replace: () => REMOVED },
  {
    rule: 'cookie',
    pattern: /\b(acw_tc=)([A-Za-z0-9]{8,})/g,
    replace: (match, name) => `${name}${REMOVED}`,
  },
  {
    // A Cookie or Set-Cookie line of a log: any cookie, not only the one Z.ai sets.
    rule: 'cookie-line',
    pattern: /\b((?:set-)?cookie)(\\?["']?[ \t]*[:=][ \t]*\\?["']?)([^"'\\\r\n]+)/gi,
    replace: (match, name, between, value) => {
      const cleaned = withoutCookieValues(value)
      return cleaned === value ? null : `${name}${between}${cleaned}`
    },
  },
  {
    // `http://user:password@host`: the proxy of a stand, a git remote. A template is not one.
    rule: 'url-userinfo',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'<>]*):([^\s/@"'<>]+)@/gi,
    replace: (match, scheme, user, password) =>
      /^[${]/.test(password) ? null : `${scheme}${REMOVED}@`,
  },
  {
    // Not the reserved domains of RFC 2606: they name nobody. A package at a version
    // (`opencode-ai@1.18.34`) has no letters in the last label and does not match.
    rule: 'email',
    pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g,
    replace: (match) =>
      RESERVED_DOMAIN.test(match.slice(match.lastIndexOf('@') + 1)) ? null : REMOVED,
  },
]

// `raw` is the part that names something; `placeholder` gives the same shape from a counter and
// `placed` recognises it, so a second pass changes nothing.
const IDENTIFIER_RULES = [
  {
    // A request or log id of Z.ai: local time to the second and 16 hex digits.
    rule: 'log-id',
    pattern: /(?<![0-9A-Za-z])20\d{12}[0-9a-f]{16}(?![0-9A-Za-z])/g,
    placeholder: (number) => `20260101000000${hex(number, 16)}`,
    placed: /^202601010000000{8}/,
  },
  {
    rule: 'uuid',
    pattern:
      /(?<![0-9A-Za-z-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z-])/gi,
    placeholder: (number) => `00000000-0000-4000-8000-${hex(number, 12)}`,
    placed: /^00000000-0000-4000-8000-/,
  },
  {
    // An id the CLI makes (`ses_`, `msg_`, `prt_`): 12 hex digits of time and 14 random characters.
    rule: 'opencode-id',
    pattern: /\b[a-z]{3,5}_[0-9a-f]{12}[A-Za-z0-9]{14}\b/g,
    placeholder: (number, raw) =>
      `${raw.slice(0, raw.indexOf('_'))}_${'0'.repeat(12)}${String(number).padStart(14, '0')}`,
    placed: /^[a-z]{3,5}_0{12}\d{14}$/,
  },
  {
    // Also behind a prefix (`fc_call_…` of the Responses form): the prefix stays.
    rule: 'tool-call-id',
    pattern: /(?<![0-9A-Za-z])call_[0-9a-f]{24}(?![0-9A-Za-z])/g,
    placeholder: (number) => `call_${hex(number, 24)}`,
    placed: /^call_0{16}/,
  },
  {
    // 40 hex digits on their own: the CLI's project id (the first commit of the work tree) and
    // the names of its lock files. A value introduced by the word `commit` is a reference to a
    // public repository and stays.
    rule: 'project-id',
    pattern: /(?<![0-9A-Za-z])(?<!\bcommit [`'"]?)[0-9a-f]{40}(?![0-9A-Za-z])/g,
    placeholder: (number) => `${'0'.repeat(32)}${hex(number, 8)}`,
    placed: /^0{32}/,
  },
  {
    // 32 hex digits on their own: the provider's trace id.
    rule: 'trace-id',
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z.])/g,
    placeholder: (number) => `${'0'.repeat(24)}${hex(number, 8)}`,
    placed: /^0{24}/,
  },
]
// `"created":1893456000`, also inside an escaped JSON string. Thirteen digits are the CLI's own
// clock in milliseconds and stay.
const CREATED_FIELD = /(\\?"created\\?"\s*:\s*)(\d{10})(?!\d)/g

// The machine of the probe or of a stand. `/Users/name` is an example in the CLI's own prompt
// and stays.
const PATH_RULES = [
  [/\/private\/tmp\/claude-\d+\/[\w.-]+\/[\w-]+\/scratchpad/g, '<scratchpad>'],
  [/\/Users\/(?!name\b)[\w.-]+\/Projects\/raditi(?:-[a-z0-9]+)*(?![\w-])/g, '<repo>'],
  [/\/Users\/(?!name\b)[\w.-]+(?=\/)/g, '/Users/<user>'],
  [/\/home\/(?!name\b)[\w.-]+(?=\/)/g, '/home/<user>'],
]

const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key']
const CREDENTIAL_FIELD =
  /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|access_token|refresh_token|id_token|client_secret|token|secret|password|cookie|set-cookie)$/i
const PLACEHOLDER_VALUE = /^<[^<>]*>$/
const DUMMY_VALUE = /^<dummy (?:llm|mcp) token>$/
/** A property that holds HTTP headers: `headers`, `rawHeaders`, `responseHeaders`. */
const HEADERS_PROPERTY = /headers$/i
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** What a credential-named property may hold and still be nothing: a count, a flag, a placeholder. */
const holdsNoCredential = (item) =>
  item === null ||
  typeof item === 'number' ||
  typeof item === 'boolean' ||
  (typeof item === 'string' && PLACEHOLDER_VALUE.test(item))

// A line break inside a JSON string is the two characters `\n`. Left as they are, the letter
// would stand right before whatever starts the next line and hide it from every rule that
// looks at what precedes a match. For the time the rules run the letter is a mark of the same
// length, so offsets and line numbers do not move.
const ESCAPE_MARKS = { n: '\uE000', r: '\uE001', t: '\uE002' }
const ESCAPE_LETTERS = Object.fromEntries(
  Object.entries(ESCAPE_MARKS).map(([letter, mark]) => [mark, letter]),
)
const hideEscapes = (text) =>
  text.replace(/\\([nrt])/g, (match, letter) => `\\${ESCAPE_MARKS[letter]}`)
const showEscapes = (text) =>
  text.replace(/\\([\uE000-\uE002])/g, (match, mark) => `\\${ESCAPE_LETTERS[mark]}`)

// What a finding shows of what it found. The findings go to the terminal and into the log of a
// failed test in CI, so a secret, or what may be one, shows its length and not one character:
// the first characters of a key are a part of the key. An identifier names no credential and
// keeps its first characters, so that a reader can find it.
const sized = (match) => `${match.length} chars`
const mask = (match) =>
  match.length <= 8 ? `${match.slice(0, 2)}…` : `${match.slice(0, 4)}… (${match.length} chars)`
const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * Runs the secret rules over a text whose escapes are hidden; `seen(rule, match, index, input)`
 * is told of every replacement, with the text the rule ran on.
 */
function withoutSecrets(text, seen) {
  let out = text
  for (const { rule, pattern, replace } of SECRET_RULES) {
    const input = out
    out = input.replace(pattern, (match, ...rest) => {
      const replaced = replace(match, ...rest)
      if (replaced === null) return match
      seen?.(rule, match, rest.at(-2), input)
      return replaced
    })
  }
  return out
}

/**
 * Secrets by shape: `[{ rule, line, excerpt }]`. The excerpt is the length of what was found,
 * never a character of it. Line numbers are those of the text given.
 */
export function findLeaks(text) {
  const found = []
  // Offsets move as earlier rules replace, so each rule reports against its own input: a
  // replacement keeps the line count, and the line is all a reader needs.
  withoutSecrets(hideEscapes(text), (rule, match, index, input) =>
    found.push({ rule, line: lineOf(input, index), excerpt: sized(showEscapes(match)) }),
  )
  return found.sort((a, b) => a.line - b.line)
}

/**
 * Raw identifiers and machine paths by shape: `[{ rule, line, excerpt }]`. The excerpt is the
 * first characters and the length.
 */
export function findIdentifiers(raw) {
  const text = hideEscapes(raw)
  const found = []
  for (const { rule, pattern, placed } of IDENTIFIER_RULES)
    for (const match of text.matchAll(pattern))
      if (!placed.test(match[0]))
        found.push({ rule, line: lineOf(text, match.index), excerpt: mask(match[0]) })
  for (const match of text.matchAll(CREATED_FIELD))
    if (Number(match[2]) !== CREATED)
      found.push({ rule: 'created', line: lineOf(text, match.index), excerpt: 'created' })
  for (const [pattern] of PATH_RULES)
    for (const match of text.matchAll(pattern))
      found.push({ rule: 'local-path', line: lineOf(text, match.index), excerpt: mask(match[0]) })
  const unique = new Map(found.map((item) => [`${item.rule}:${item.line}:${item.excerpt}`, item]))
  return [...unique.values()].sort((a, b) => a.line - b.line)
}

/**
 * The name of a header in lower case, or null for what only stands where a name should: not a
 * token of RFC 9110, too long, or shaped like a secret or an identifier.
 */
function headerNameOf(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.toLowerCase()
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) return null
  if ((name.match(/\d/g) ?? []).length > 3) return null
  return findLeaks(name).length || findIdentifiers(name).length ? null : name
}

/** Header pairs of an object, of a list of pairs or of Node's flat `rawHeaders`; null for another form. */
function headerPairs(value) {
  if (isRecord(value)) return Object.entries(value)
  if (!Array.isArray(value)) return null
  const heldBy = (item) => typeof item === 'string' || Array.isArray(item)
  if (value.every((item) => Array.isArray(item) && item.length === 2 && heldBy(item[1])))
    return value
  if (value.length % 2 === 0 && value.every((item) => typeof item === 'string'))
    return value.flatMap((item, index) => (index % 2 ? [] : [[item, value[index + 1]]]))
  return null
}

const credentialOf = (header, raw) => {
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw)
  const scheme = /^(bearer|basic)\s+/i.exec(text)
  const rest = scheme ? text.slice(scheme[0].length) : text
  return {
    header,
    ...(scheme ? { scheme: scheme[1].toLowerCase() } : {}),
    value: DUMMY_VALUE.test(rest) ? rest : REMOVED,
  }
}

/** An item of a `credentials` summary in the only form the sanitiser writes, or null. */
function credentialItem(item) {
  if (!isRecord(item) || typeof item.header !== 'string') return null
  const header = item.header.toLowerCase()
  if (!CREDENTIAL_HEADERS.includes(header)) return null
  const scheme = typeof item.scheme === 'string' ? item.scheme.toLowerCase() : undefined
  return {
    header,
    ...(scheme === 'bearer' || scheme === 'basic' ? { scheme } : {}),
    value: typeof item.value === 'string' && DUMMY_VALUE.test(item.value) ? item.value : REMOVED,
  }
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * One pass over a set of files: the same raw identifier gets the same placeholder in all of
 * them, numbered in the order met.
 */
export function createSanitizer() {
  const known = new Map(IDENTIFIER_RULES.map(({ rule }) => [rule, new Map()]))
  const counts = {
    headersKept: {},
    headersDropped: {},
    secrets: {},
    identifiers: {},
    credentialFields: 0,
    localPaths: 0,
  }
  const bump = (table, name, by = 1) => {
    table[name] = (table[name] ?? 0) + by
  }

  function text(input) {
    let out = withoutSecrets(hideEscapes(String(input)), (rule) => bump(counts.secrets, rule))
    // Before the identifiers: the scratch path of the probe has a UUID of its own.
    for (const [pattern, replacement] of PATH_RULES)
      out = out.replace(pattern, () => {
        counts.localPaths += 1
        return replacement
      })
    for (const { rule, pattern, placeholder, placed } of IDENTIFIER_RULES)
      out = out.replace(pattern, (raw) => {
        if (placed.test(raw)) return raw
        const map = known.get(rule)
        if (!map.has(raw)) map.set(raw, placeholder(map.size + 1, raw))
        const entry = (counts.identifiers[rule] ??= { distinct: 0, replaced: 0 })
        entry.distinct = map.size
        entry.replaced += 1
        return map.get(raw)
      })
    out = out.replace(CREATED_FIELD, (match, before, value) => {
      if (Number(value) === CREATED) return match
      const entry = (counts.identifiers.created ??= { distinct: 0, replaced: 0 })
      entry.distinct = 1
      entry.replaced += 1
      return `${before}${CREATED}`
    })
    return showEscapes(out)
  }

  /** Header pairs through the allowlist: what is kept, the names of the rest, the credentials. */
  function headers(pairs) {
    const kept = {}
    const dropped = []
    const credentials = []
    for (const [name, item] of pairs) {
      const lower = headerNameOf(name)
      if (lower !== null && ALLOWED_HEADERS.includes(lower)) {
        kept[lower] = Array.isArray(item) ? item.map((part) => text(part)) : text(item)
        bump(counts.headersKept, lower)
        continue
      }
      // What stands where a name should be is neither kept nor listed.
      bump(counts.headersDropped, lower ?? '<not a header name>')
      if (lower === null) continue
      dropped.push(lower)
      if (CREDENTIAL_HEADERS.includes(lower)) credentials.push(credentialOf(lower, item))
    }
    return { kept, dropped, credentials }
  }

  function json(value, key) {
    if (typeof value === 'string') return text(value)
    if (typeof value === 'number')
      return key === 'created' && Number.isInteger(value) && /^\d{10}$/.test(String(value))
        ? Number(text(`"created":${value}`).split(':')[1])
        : value
    if (Array.isArray(value)) return value.map((item) => json(item))
    if (!isRecord(value)) return value

    const names = Object.keys(value)
    const filtered = new Map()
    for (const name of names) {
      if (!HEADERS_PROPERTY.test(name) || value[name] === null || value[name] === undefined)
        continue
      const pairs = headerPairs(value[name])
      // Never the value in the message: it is what could not be read.
      if (!pairs) throw new Error('headers in a form the sanitiser does not know')
      filtered.set(name, headers(pairs))
    }
    // What an earlier pass, or the probe's proxy, already said about the removed headers: taken
    // only in the form this script writes, never as it stands.
    const dropped = new Set()
    for (const item of Array.isArray(value.removedHeaderNames) ? value.removedHeaderNames : []) {
      const name = headerNameOf(item)
      if (name !== null) dropped.add(name)
    }
    const credentials = new Map()
    for (const raw of Array.isArray(value.credentials) ? value.credentials : []) {
      const item = credentialItem(raw)
      if (item) credentials.set(item.header, item)
    }
    if (isRecord(value.clientCredentials))
      for (const [name, raw] of Object.entries(value.clientCredentials))
        credentials.set(name.toLowerCase(), credentialOf(name.toLowerCase(), raw))
    for (const part of filtered.values()) {
      for (const name of part.dropped) dropped.add(name)
      for (const item of part.credentials) credentials.set(item.header, item)
    }
    const summary = () => ({
      ...(dropped.size ? { removedHeaderNames: [...dropped].sort() } : {}),
      ...(credentials.size
        ? {
            credentials: CREDENTIAL_HEADERS.filter((name) => credentials.has(name)).map((name) =>
              credentials.get(name),
            ),
          }
        : {}),
    })

    const out = {}
    let summarised = false
    for (const name of names) {
      if (name === 'removedHeaderNames' || name === 'credentials' || name === 'clientCredentials')
        continue
      if (filtered.has(name)) {
        // The summary stands right after the first header object of the record.
        Object.assign(out, { [text(name)]: filtered.get(name).kept }, summarised ? {} : summary())
        summarised = true
        continue
      }
      const item = value[name]
      if (CREDENTIAL_FIELD.test(name) && !holdsNoCredential(item)) {
        counts.credentialFields += 1
        out[name] = REMOVED
        continue
      }
      // The same rule as `NAME=value` in a text: the name gives the value away.
      if (
        typeof item === 'string' &&
        SECRET_NAME_END.test(name) &&
        SECRET_VALUE.test(item) &&
        tokenLike(item, Infinity)
      ) {
        bump(counts.secrets, 'assigned-secret')
        out[text(name)] = REMOVED
        continue
      }
      // A property name is cleaned like a value: a session id, a key used as a name.
      out[text(name)] = json(item, name)
    }
    return summarised ? out : { ...out, ...summary() }
  }

  return {
    /** A plain text: the same lines, secrets, identifiers and machine paths replaced. */
    text,
    /**
     * A parsed JSON record: a deep copy with headers filtered and every string cleaned. Throws
     * when a property that should hold headers holds them in an unknown form.
     */
    json: (value) => json(value),
    report: () => structuredClone(counts),
  }
}

/**
 * What the sanitiser would still change in a text, `[{ rule, line?, excerpt }]`; empty for a
 * clean one. With `json` the text must be JSON, and its header objects, its summaries of removed
 * headers and its credential fields are checked by name.
 */
export function checkSanitized(text, { json = false } = {}) {
  const problems = []
  if (json) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return [{ rule: 'json', excerpt: 'not JSON' }]
    }
    // A name that is no header name is not quoted at all: it may be a value in the wrong place.
    const named = (header) => (headerNameOf(header) === null ? sized(String(header)) : header)
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit)
      if (!isRecord(value)) return
      for (const [name, item] of Object.entries(value)) {
        if (HEADERS_PROPERTY.test(name) && item !== null) {
          if (!isRecord(item)) problems.push({ rule: 'header', excerpt: 'not an object' })
          else
            for (const header of Object.keys(item))
              if (!ALLOWED_HEADERS.includes(header))
                problems.push({ rule: 'header', excerpt: named(header) })
        } else if (name === 'removedHeaderNames') {
          if (!Array.isArray(item)) problems.push({ rule: 'header', excerpt: 'not a list' })
          else
            for (const header of item)
              if (headerNameOf(header) !== header)
                problems.push({ rule: 'header', excerpt: named(header) })
          continue
        } else if (name === 'credentials') {
          if (!Array.isArray(item) || item.some((entry) => !sameJson(credentialItem(entry), entry)))
            problems.push({ rule: 'credential-field', excerpt: name })
          continue
        } else if (name === 'clientCredentials') {
          problems.push({ rule: 'credential-field', excerpt: name })
        } else if (CREDENTIAL_FIELD.test(name) && !holdsNoCredential(item)) {
          problems.push({ rule: 'credential-field', excerpt: name })
          continue
        }
        visit(item)
      }
    }
    visit(parsed)
  }
  return [...problems, ...findLeaks(text), ...findIdentifiers(text)]
}

// ---- command ------------------------------------------------------------------------------

const listFiles = (path) =>
  statSync(path).isDirectory()
    ? readdirSync(path)
        .sort()
        .flatMap((name) => listFiles(join(path, name)))
    : [path]

/** A UTF-8 text file, or null for a binary one. */
function readText(file) {
  const buffer = readFileSync(file)
  return buffer.includes(0) ? null : buffer.toString('utf8')
}

const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`)
/** The real path of a directory that may not exist yet: symlinks of its existing part resolved. */
function realTarget(path) {
  const missing = []
  let current = resolve(path)
  while (!existsSync(current) && dirname(current) !== current) {
    missing.unshift(current.slice(dirname(current).length + 1))
    current = dirname(current)
  }
  return join(realpathSync(current), ...missing)
}
const describe = ({ rule, line, excerpt }) => `${rule}${line ? ` (line ${line})` : ''}: ${excerpt}`

/**
 * An entry of the command line with its mode. `text:<path>` takes `.json` files as plain text:
 * a config of the probe is a script, and its header templates are not recorded headers.
 */
const entryOf = (argument) =>
  argument.startsWith('text:')
    ? { path: argument.slice(5), asText: true }
    : { path: argument, asText: false }

function check(entries) {
  let failed = false
  for (const { path, asText } of entries)
    for (const file of listFiles(resolve(path))) {
      const text = readText(file)
      const problems =
        text === null
          ? [{ rule: 'binary', excerpt: 'not a text file' }]
          : checkSanitized(text, { json: !asText && file.endsWith('.json') })
      for (const problem of problems) {
        failed = true
        process.stderr.write(`${file}: ${describe(problem)}\n`)
      }
    }
  return failed ? 1 : 0
}

function scan(paths) {
  let secrets = 0
  for (const file of paths.flatMap((path) => listFiles(resolve(path)))) {
    const text = readText(file)
    if (text === null) {
      process.stdout.write(`${file}: binary, skipped\n`)
      continue
    }
    const leaks = findLeaks(text)
    secrets += leaks.length
    for (const leak of leaks) process.stdout.write(`${file}: SECRET ${describe(leak)}\n`)
    const identifiers = {}
    for (const { rule } of findIdentifiers(text)) identifiers[rule] = (identifiers[rule] ?? 0) + 1
    const summary = Object.entries(identifiers).map(([rule, count]) => `${rule} ×${count}`)
    if (summary.length) process.stdout.write(`${file}: identifiers ${summary.join(', ')}\n`)
  }
  process.stdout.write(`secrets found: ${secrets}\n`)
  return secrets ? 1 : 0
}

function copy(args) {
  const options = {}
  const entries = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--from' || args[index] === '--to')
      options[args[index].slice(2)] = args[(index += 1)]
    else entries.push(args[index])
  }
  if (!options.from || !options.to || !entries.length)
    throw new Error('usage: copy --from <dir> --to <dir> <entry>...')
  const from = realpathSync(resolve(options.from))
  const to = realTarget(options.to)
  if (inside(from, to) || inside(to, from))
    throw new Error('the destination and the source must not contain each other')
  const sources = new Map()
  for (const { path: entry, asText } of entries.map(entryOf)) {
    const path = resolve(from, entry)
    if (isAbsolute(entry) || !inside(from, path) || !existsSync(path))
      throw new Error(`${entry} is not an entry of the source directory`)
    for (const file of listFiles(path)) sources.set(file, asText)
  }

  // The whole pass in memory first: nothing is written unless every output is clean.
  const sanitizer = createSanitizer()
  const outputs = []
  let failed = false
  for (const source of [...sources.keys()].sort()) {
    const name = relative(from, source)
    const text = readText(source)
    if (text === null) throw new Error(`${name} is not a text file`)
    const asJson = source.endsWith('.json') && !sources.get(source)
    let out
    if (asJson) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        // Never V8's own message: it quotes the start of the input.
        throw new Error(`${name} is not JSON`)
      }
      try {
        out = `${JSON.stringify(sanitizer.json(parsed), null, 2)}\n`
      } catch (error) {
        throw new Error(`${name}: ${error.message}`)
      }
    } else out = sanitizer.text(text)
    for (const problem of checkSanitized(out, { json: asJson })) {
      failed = true
      process.stderr.write(`${name}: ${describe(problem)}\n`)
    }
    // Of the source's mode only the executable bit: the probe keeps its records 0600.
    outputs.push({ name, out, mode: statSync(source).mode & 0o100 ? 0o755 : 0o644 })
  }
  if (failed) {
    process.stderr.write('sanitize-samples: nothing was written\n')
    return 1
  }
  for (const { name, out, mode } of outputs) {
    const target = join(to, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, out)
    chmodSync(target, mode)
  }
  const files = outputs.map(({ name }) => name)
  process.stdout.write(`${JSON.stringify({ files, ...sanitizer.report() }, null, 2)}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  try {
    if (command === 'copy') process.exitCode = copy(args)
    else if (command === 'check' && args.length) process.exitCode = check(args.map(entryOf))
    else if (command === 'scan' && args.length) process.exitCode = scan(args)
    else throw new Error('usage: sanitize-samples.mjs copy|check|scan ...')
  } catch (error) {
    process.stderr.write(`sanitize-samples: ${error.message}\n`)
    process.exitCode = 2
  }
}
