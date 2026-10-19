import { candidatePatchKey, publicationLimits, type ObjectStorage } from '@repo/domain'

// The diff of a candidate as the panel «Файлы» shows it, one file at a time (Р20;
// docs/plan/53-chat-preview-release.md, «Имена»). core writes the patch of every candidate
// revision to `raditi-artifacts` under `candidatePatchKey` of @repo/domain: the patch the
// publication already makes — `git diff --binary --full-index --no-renames` of the base of the
// candidate against its head — without encryption, because web has no Transit (the client's
// code stays in Russia, and publication has refused secrets in it). web finds the part of one
// file by its exact `diff --git` line and never shows more than 256 KiB of it.

/** The most of one file's diff a screen gets. */
export const FILE_DIFF_LIMIT_BYTES = 256 * 1024

export type FileDiffState =
  /** `diff` holds the unified diff of the file. */
  | 'ready'
  /** A binary file: the panel names it and its type, no diff. */
  | 'binary'
  /** Longer than 256 KiB: the panel says so instead of showing it. */
  | 'too_large'
  /** The patch is not written yet, or holds no part of this file. */
  | 'missing'

export interface FileDiff {
  path: string
  state: FileDiffState
  diff: string | null
}

const HEADER = Buffer.from('diff --git ')
const NEWLINE = 0x0a
const QUOTE = 0x22
const BACKSLASH = 0x5c
const controlEscapes: Readonly<Record<number, string>> = {
  0x07: 'a',
  0x08: 'b',
  0x09: 't',
  0x0a: 'n',
  0x0b: 'v',
  0x0c: 'f',
  0x0d: 'r',
}

/**
 * A path as git writes it in a header, quoted the C way (quote.c): a quote, a backslash or a
 * control character — and, with `core.quotePath` on (the default), any byte above 0x7f — makes
 * git put the name in quotes, with escapes. null — the path is written as it is.
 */
function cQuoted(path: Buffer, quoteBytes: boolean): Buffer | null {
  const needs = (byte: number) =>
    byte < 0x20 ||
    byte === 0x7f ||
    byte === QUOTE ||
    byte === BACKSLASH ||
    (quoteBytes && byte > 0x7f)
  if (!path.some(needs)) return null
  const parts: Buffer[] = []
  for (const byte of path) {
    if (!needs(byte)) parts.push(Buffer.of(byte))
    else if (byte === QUOTE || byte === BACKSLASH) parts.push(Buffer.of(BACKSLASH, byte))
    else if (controlEscapes[byte] !== undefined)
      parts.push(Buffer.from(`\\${controlEscapes[byte]}`, 'latin1'))
    else parts.push(Buffer.from(`\\${byte.toString(8).padStart(3, '0')}`, 'latin1'))
  }
  return Buffer.concat(parts)
}

/** Every way git may have written the header of `path`: plain, or quoted with or without octal. */
function headersOf(path: string): Buffer[] {
  const bytes = Buffer.from(path, 'utf8')
  const headers = [Buffer.concat([HEADER, Buffer.from(`a/${path} b/${path}`, 'utf8')])]
  for (const quoteBytes of [true, false]) {
    const quoted = cQuoted(bytes, quoteBytes)
    if (quoted === null) continue
    headers.push(
      Buffer.concat([
        HEADER,
        Buffer.from('"a/'),
        quoted,
        Buffer.from('" "b/'),
        quoted,
        Buffer.from('"'),
      ]),
    )
  }
  return headers
}

/** Where the next `diff --git ` line starts at or after `from`; the length of the patch if none. */
function nextHeader(patch: Buffer, from: number): number {
  let at = patch.indexOf(HEADER, from)
  while (at !== -1) {
    if (at === 0 || patch[at - 1] === NEWLINE) return at
    at = patch.indexOf(HEADER, at + 1)
  }
  return patch.length
}

/**
 * The part of a patch that belongs to `path`: from its `diff --git` line to the next one. Lines
 * of a hunk start with a space, `+`, `-` or `\`, and a base85 line of a binary patch has no
 * space, so a header is told by its line alone.
 */
export function fileDiffOf(patch: Buffer, path: string): FileDiff {
  const headers = headersOf(path)
  let at = nextHeader(patch, 0)
  while (at < patch.length) {
    const lineEnd = patch.indexOf(NEWLINE, at)
    const end = lineEnd === -1 ? patch.length : lineEnd
    const line = patch.subarray(at, end)
    const next = nextHeader(patch, end)
    if (headers.some((header) => header.equals(line))) {
      const part = patch.subarray(at, next)
      if (part.includes('\nGIT binary patch\n') || part.includes('\nBinary files '))
        return { path, state: 'binary', diff: null }
      if (part.byteLength > FILE_DIFF_LIMIT_BYTES) return { path, state: 'too_large', diff: null }
      return { path, state: 'ready', diff: new TextDecoder().decode(part) }
    }
    at = next
  }
  return { path, state: 'missing', diff: null }
}

/**
 * Reads the patch of a candidate revision and returns the part of one file. The object is read
 * whole, up to the limit of a candidate patch (8 MiB); anything longer is not a patch of the
 * platform and is not shown.
 */
export async function readFileDiff(
  storage: ObjectStorage,
  input: { taskId: string; revision: number; path: string },
): Promise<FileDiff> {
  const body = await storage.get('artifacts', candidatePatchKey(input.taskId, input.revision))
  if (body === null) return { path: input.path, state: 'missing', diff: null }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.byteLength
    if (size > publicationLimits.patchBytes)
      return { path: input.path, state: 'missing', diff: null }
    chunks.push(Buffer.from(chunk))
  }
  return fileDiffOf(Buffer.concat(chunks), input.path)
}
