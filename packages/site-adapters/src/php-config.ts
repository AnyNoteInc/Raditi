import { siteImportLimits } from '@repo/domain'

// Constant string literals of PHP configuration files (wp-config.php, dbconn.php, .settings.php),
// read without running or tokenizing the file: a pattern finds the place of a value, the literal
// behind it is read by the rules of PHP. Whatever is not one constant literal — a function call,
// a concatenation, a variable inside double quotes, a heredoc — gives no value: a guessed secret
// would only make the import scan search for the wrong text. Nor does a literal that the patterns
// do not lead up to: nothing here skips a comment or a parenthesis next to it.

/** What `SiteAdapter.configSecrets` is given: a file of the site root, or null. */
export type ConfigFileReader = (path: string) => Promise<Uint8Array | null>

/** Shorter than this is no secret worth an exact search: it would be found in half the code. */
const MIN_SECRET_CHARS = 4
/**
 * A literal that does not close within this many bytes is no password (the wizard itself takes
 * 1024 characters) but a quote left open in a broken file: what stands behind it is not a value
 * to search every imported file for.
 */
const MAX_LITERAL_BYTES = 4096

// ignoreBOM keeps a byte order mark at the start of a value: to PHP it is three bytes of the value.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** One character per byte, so that an escape like `\xD0` stays the byte PHP would write. */
function toByteString(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return text
}

/** null for bytes that are not UTF-8: such a value cannot be searched for as text. */
function fromByteString(text: string): string | null {
  try {
    return utf8.decode(Uint8Array.from(text, (char) => char.charCodeAt(0)))
  } catch {
    return null
  }
}

const doubleQuotedEscapes = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', String.fromCharCode(11)],
  ['e', String.fromCharCode(27)],
  ['f', String.fromCharCode(12)],
  ['\\', '\\'],
  ['$', '$'],
  ['"', '"'],
])
const octalEscape = /[0-7]{1,3}/y
const hexEscape = /[xX]([0-9A-Fa-f]{1,2})/y
const unicodeEscape = /u\{([0-9A-Fa-f]+)\}/y

/** `$` in double quotes starts a variable before a name (any byte above ASCII counts) or `{`. */
const startsVariable = (next: string) => /^[A-Za-z_{]/.test(next) || next.charCodeAt(0) >= 0x80

function matchAt(pattern: RegExp, source: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(source)
}

/**
 * The backslash at `index` of a double-quoted literal with what it takes along: the bytes they
 * stand for and their length in the source. null where PHP refuses the file.
 */
function readEscape(source: string, index: number): { bytes: string; length: number } | null {
  const next = source[index + 1] ?? ''
  const simple = doubleQuotedEscapes.get(next)
  if (simple !== undefined) return { bytes: simple, length: 2 }
  const octal = matchAt(octalEscape, source, index + 1)
  // PHP keeps the low byte: "\400" is "\000".
  if (octal)
    return {
      bytes: String.fromCharCode(Number.parseInt(octal[0], 8) & 0xff),
      length: 1 + octal[0].length,
    }
  const hex = matchAt(hexEscape, source, index + 1)
  if (hex)
    return { bytes: String.fromCharCode(Number.parseInt(hex[1]!, 16)), length: 1 + hex[0].length }
  if (next === 'u' && source[index + 2] === '{') {
    // `\u{` wants a code point of Unicode behind it, or PHP refuses the file; a lone surrogate
    // is no text. (`\u` without the brace is no escape: the JSON form stays as it is written.)
    const unicode = matchAt(unicodeEscape, source, index + 1)
    if (!unicode) return null
    const codePoint = Number.parseInt(unicode[1]!, 16)
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null
    return {
      bytes: toByteString(encoder.encode(String.fromCodePoint(codePoint))),
      length: 1 + unicode[0].length,
    }
  }
  // No escape: PHP keeps the backslash and the character behind it, which starts nothing then —
  // "\{$" is those three characters.
  return { bytes: `\\${next}`, length: 1 + next.length }
}

/**
 * The PHP string literal that starts at `start` of a byte string: its bytes and the index behind
 * its closing quote. null when there is no quote at `start`, the literal does not end within
 * `MAX_LITERAL_BYTES`, or — in double quotes — it holds a variable, so its value is not in the file.
 */
function readLiteral(source: string, start: number): { bytes: string; end: number } | null {
  const quote = source[start]
  if (quote !== "'" && quote !== '"') return null
  let bytes = ''
  let index = start + 1
  const limit = Math.min(source.length, index + MAX_LITERAL_BYTES + 1)
  while (index < limit) {
    const char = source[index]!
    const next = source[index + 1] ?? ''
    if (char === quote) return { bytes, end: index + 1 }
    if (quote === "'") {
      // Single quotes know two escapes only: `\\` and `\'`.
      const escaped = char === '\\' && (next === '\\' || next === "'")
      bytes += escaped ? next : char
      index += escaped ? 2 : 1
    } else if (char === '\\') {
      const escape = readEscape(source, index)
      if (!escape) return null
      bytes += escape.bytes
      index += escape.length
    } else {
      // `$name`, `${…}` and `{$…}` are replaced when PHP runs.
      if ((char === '$' && startsVariable(next)) || (char === '{' && next === '$')) return null
      bytes += char
      index += 1
    }
  }
  return null
}

/**
 * Every constant string literal of `file` that stands right behind a match of `before` and right
 * in front of a match of `after`, in the order of the file. Both patterns see one character per
 * byte and must be ASCII; only the letter-case flag of `before` is kept.
 */
export function phpStringsAfter(file: Uint8Array, before: RegExp, after: RegExp): string[] {
  const source = toByteString(file)
  const head = new RegExp(before.source, before.ignoreCase ? 'gi' : 'g')
  const tail = new RegExp(after.source, 'y')
  const values: string[] = []
  for (const match of source.matchAll(head)) {
    const literal = readLiteral(source, match.index + match[0].length)
    if (!literal || !matchAt(tail, source, literal.end)) continue
    const value = fromByteString(literal.bytes)
    if (value !== null) values.push(value)
  }
  return values
}

/** `phpStringsAfter` over one file of the site root; nothing when the reader has no such file. */
export async function phpConfigStrings(
  read: ConfigFileReader,
  path: string,
  before: RegExp,
  after: RegExp,
): Promise<string[]> {
  const file = await read(path)
  // The reader refuses a larger file itself; the patterns here never run over more than the limit.
  if (!file || file.byteLength > siteImportLimits.configFileBytes) return []
  return phpStringsAfter(file, before, after)
}

/** What is worth an exact search: each value once, none shorter than four characters. */
export function secretValues(values: readonly string[]): string[] {
  return [...new Set(values)].filter((value) => Array.from(value).length >= MIN_SECRET_CHARS)
}
