import { DatabaseCopyError } from '@repo/domain'

// The text of a seed (docs/plan/53-chat-preview-release.md, Р15): what a copy writes, as bytes.
// Values read from the source stay the bytes the server sent in the connection's encoding,
// escaped the way mysqldump does it; the encodings below keep every byte under 0x80 a character
// of ASCII, so escaping byte by byte is exact. Values made here are UTF-8 with an introducer, so
// the server converts them into any encoding of the column.

/**
 * Character sets a seed can be written in, with the name mysql2 knows each by. Multibyte sets
 * whose trailing bytes may look like a quote or a backslash (sjis, gbk, big5) are not here.
 */
export const seedCharsets: Readonly<Record<string, string>> = Object.freeze({
  utf8mb4: 'UTF8MB4',
  utf8mb3: 'UTF8',
  utf8: 'UTF8',
  latin1: 'LATIN1',
  cp1251: 'CP1251',
  koi8r: 'KOI8R',
  ascii: 'ASCII',
})

const ASCII = new TextEncoder()
const bytes = (text: string) => Buffer.from(ASCII.encode(text))

/** `name` of a table or a column, in backticks. */
export function quoteIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

/** What `mysql_real_escape_string` escapes, and the letter it writes after the backslash. */
const escapes = new Map<number, number>([
  [0x00, 0x30],
  [0x0a, 0x6e],
  [0x0d, 0x72],
  [0x1a, 0x5a],
  [0x22, 0x22],
  [0x27, 0x27],
  [0x5c, 0x5c],
])

/** A quoted string literal of the bytes as they are: `'…'`, special bytes escaped. */
export function stringLiteral(value: Uint8Array): Buffer {
  let extra = 0
  for (const byte of value) if (escapes.has(byte)) extra += 1
  const out = Buffer.allocUnsafe(value.length + extra + 2)
  let at = 0
  out[at++] = 0x27
  for (const byte of value) {
    const escaped = escapes.get(byte)
    if (escaped === undefined) out[at++] = byte
    else {
      out[at++] = 0x5c
      out[at++] = escaped
    }
  }
  out[at] = 0x27
  return out
}

/** A binary string, a bit value, a geometry: `X'…'`, never through an encoding. */
export function hexLiteral(value: Uint8Array): Buffer {
  return bytes(`X'${Buffer.from(value).toString('hex')}'`)
}

/** A value the platform makes (a synthetic name, an override): UTF-8 with its introducer. */
export function utf8Literal(text: string): Buffer {
  const hex = Buffer.from(text, 'utf8').toString('hex')
  return bytes(hex === '' ? `_utf8mb4''` : `_utf8mb4 X'${hex}'`)
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** A number as the server wrote it, unquoted so that nothing is rounded; else null. */
export function numberLiteral(value: Uint8Array): Buffer | null {
  return value.length <= 128 && NUMBER.test(Buffer.from(value).toString('latin1'))
    ? Buffer.from(value)
    : null
}

/** Engines a seed creates tables of: rows stored by the preview's own server, nowhere else. */
const seedEngines = new Set(['innodb', 'myisam', 'aria', 'memory'])

/** Options of a table that describe its rows; a seed keeps them as they are. */
const keptTableOptions = new Set([
  'ENGINE',
  'DEFAULT CHARSET',
  'CHARSET',
  'DEFAULT COLLATE',
  'COLLATE',
  'ROW_FORMAT',
  'COMMENT',
  'PAGE_CHECKSUM',
  'TRANSACTIONAL',
  'KEY_BLOCK_SIZE',
  'STATS_PERSISTENT',
  'STATS_AUTO_RECALC',
  'STATS_SAMPLE_PAGES',
  'PACK_KEYS',
  'CHECKSUM',
  'DELAY_KEY_WRITE',
  'AVG_ROW_LENGTH',
  'MAX_ROWS',
  'MIN_ROWS',
  'PAGE_COMPRESSED',
  'PAGE_COMPRESSION_LEVEL',
])

/**
 * Options of the source's own storage, dropped: the counter tells how many orders or entries
 * there were, the folders are paths of the source server, its keys of encryption at rest are not
 * the preview's.
 */
const droppedTableOptions = new Set([
  'AUTO_INCREMENT',
  'DATA DIRECTORY',
  'INDEX DIRECTORY',
  'ENCRYPTED',
  'ENCRYPTION_KEY_ID',
  'ENCRYPTION',
])

const TABLE_OPTION =
  / ((?:DEFAULT |DATA |INDEX )?[A-Z_]+)=('(?:[^'\\]|\\[\s\S]|'')*'|[A-Za-z0-9_]+)/y

const unsupported = () => new DatabaseCopyError('structure_unsupported')

/**
 * Where the list of columns and keys that starts at `from` closes. Quoted strings and names are
 * skipped whole; a `;` or a comment outside them is refused — a second statement or an
 * executable comment of a hostile server never reaches the loader of a preview.
 */
function columnListEnd(text: string, from: number): number {
  let depth = 1
  for (let at = from; at < text.length; at += 1) {
    const char = text[at]!
    if (char === "'" || char === '"' || char === '`') {
      at = quotedEnd(text, at)
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return at
    } else if (
      char === ';' ||
      char === '#' ||
      (char === '/' && text[at + 1] === '*') ||
      (char === '-' && text[at + 1] === '-' && /\s/.test(text[at + 2] ?? ' '))
    )
      throw unsupported()
  }
  throw unsupported()
}

/** The index of the quote that closes the one at `start`: doubled quotes and `\` escapes inside. */
function quotedEnd(text: string, start: number): number {
  const quote = text[start]
  for (let at = start + 1; at < text.length; at += 1) {
    const char = text[at]
    if (char === '\\' && quote !== '`') at += 1
    else if (char === quote) {
      if (text[at + 1] !== quote) return at
      at += 1
    }
  }
  throw unsupported()
}

/**
 * `SHOW CREATE TABLE` of `table` for a seed: exactly one CREATE TABLE of that name, of an engine
 * that keeps its rows itself (never FEDERATED, CONNECT or another that reaches a server or a
 * file with a password in its options), with the options of its rows and nothing of the source
 * server — no counter, folder or key. Any other statement is `structure_unsupported`.
 */
export function createTableForSeed(table: string, statement: Uint8Array): Buffer {
  const text = Buffer.from(statement).toString('latin1')
  const head = `CREATE TABLE ${quoteIdentifier(table)} (`
  if (!text.startsWith(head)) throw unsupported()
  const end = columnListEnd(text, head.length)
  const tail = text.slice(end + 1)
  let options = ''
  for (let at = 0; at < tail.length;) {
    TABLE_OPTION.lastIndex = at
    const match = TABLE_OPTION.exec(tail)
    if (!match) throw unsupported()
    at = TABLE_OPTION.lastIndex
    const [option, name = '', value = ''] = match
    if (droppedTableOptions.has(name)) continue
    if (!keptTableOptions.has(name)) throw unsupported()
    if (name === 'ENGINE' && !seedEngines.has(value.toLowerCase())) throw unsupported()
    options += option
  }
  return Buffer.from(text.slice(0, end + 1) + options, 'latin1')
}

/** The start of a seed: the encoding of every literal after it, and a loader that takes it all. */
export function seedHeader(charset: string, collation: string | null): Buffer {
  return bytes(
    [
      '-- Raditi preview seed (docs/plan/53-chat-preview-release.md, Р15): rows chosen at the source.',
      `SET NAMES ${charset}${collation ? ` COLLATE ${collation}` : ''};`,
      'SET FOREIGN_KEY_CHECKS = 0;',
      'SET UNIQUE_CHECKS = 0;',
      // Ids of 0 stay 0, zero dates load (WordPress keeps them in posts).
      `SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';`,
      `SET TIME_ZONE = '+00:00';`,
      '',
    ].join('\n'),
  )
}

export function seedFooter(): Buffer {
  return bytes('SET UNIQUE_CHECKS = 1;\nSET FOREIGN_KEY_CHECKS = 1;\n')
}

/** `DROP TABLE IF EXISTS` and the statement of the table. */
export function tableStatement(table: string, createTable: Uint8Array): Buffer {
  return Buffer.concat([
    bytes(`\nDROP TABLE IF EXISTS ${quoteIdentifier(table)};\n`),
    createTableForSeed(table, createTable),
    bytes(';\n'),
  ])
}

/** `INSERT INTO t (a, b) VALUES` and the tuples, one statement. */
export function insertStatement(
  table: string,
  columns: readonly string[],
  tuples: readonly Buffer[],
): Buffer {
  const head = bytes(
    `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES\n`,
  )
  const parts: Buffer[] = [head]
  tuples.forEach((tuple, index) => {
    if (index > 0) parts.push(bytes(',\n'))
    parts.push(tuple)
  })
  parts.push(bytes(';\n'))
  return Buffer.concat(parts)
}

/** `(v1,v2,…)` of literals already written. */
export function tuple(values: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [bytes('(')]
  values.forEach((value, index) => {
    if (index > 0) parts.push(bytes(','))
    parts.push(value)
  })
  parts.push(bytes(')'))
  return Buffer.concat(parts)
}

export const NULL_LITERAL = bytes('NULL')
export const EMPTY_LITERAL = bytes(`''`)
