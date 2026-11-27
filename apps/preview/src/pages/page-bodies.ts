import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

/**
 * The bodies the page server sends (docs/plan/96-review-fixes.md, P34): compressed here, not at
 * the edge — Traefik's compression weakens the ETag a 304 is compared by —, and kept in memory by
 * the version they are of. A version of a page (`pageId` and its number) and a shared file (its
 * sha256) never change their bytes, so an entry is valid for as long as its tag is the current one.
 */

export type BodyEncoding = 'br' | 'gzip' | 'identity'

/** Below this a body goes as it is: the headers would cost more than the bytes saved. */
export const COMPRESS_MIN_BYTES = 1024

/** What the cache holds in all, the compressed variants counted. */
export const BODY_CACHE_BYTES = 64 * 1024 * 1024

const brotli = promisify(brotliCompress)
const gzipped = promisify(gzip)

/** Text, JSON, SVG, scripts and styles compress; pictures, fonts and PDF are compressed already. */
export function compressible(type: string, size: number): boolean {
  if (size < COMPRESS_MIN_BYTES) return false
  const bare = type.split(';')[0]!.trim().toLowerCase()
  return (
    bare.startsWith('text/') ||
    bare === 'application/json' ||
    bare === 'application/javascript' ||
    bare === 'image/svg+xml'
  )
}

/**
 * The coding the viewer takes, by `Accept-Encoding` and its `q`: brotli before gzip at the same
 * weight, `*` for either that is not named, `q=0` refuses. None — the body as it is.
 */
export function negotiateEncoding(header: string | string[] | undefined): BodyEncoding {
  const weights = new Map<string, number>()
  for (const part of String(header ?? '').split(',')) {
    const [name = '', ...params] = part.split(';').map((piece) => piece.trim())
    if (!name) continue
    const q = params.find((param) => /^q=/i.test(param))
    const weight = q === undefined ? 1 : Number(q.slice(2))
    weights.set(name.toLowerCase(), Number.isFinite(weight) ? weight : 0)
  }
  const any = weights.get('*') ?? 0
  const br = weights.get('br') ?? any
  const gz = weights.get('gzip') ?? weights.get('x-gzip') ?? any
  if (br > 0 && br >= gz) return 'br'
  if (gz > 0) return 'gzip'
  return 'identity'
}

const SUFFIX: Record<BodyEncoding, string> = { br: '.br', gzip: '.gz', identity: '' }

/** The strong ETag of one coding of a representation: each coding is its own bytes. */
export const variantTag = (base: string, encoding: BodyEncoding): string =>
  `"${base}${SUFFIX[encoding]}"`

/** The bases an `If-None-Match` names, whatever coding they were of. */
export function taggedBases(header: string | string[] | undefined): string[] {
  return String(header ?? '')
    .split(',')
    .map((tag) => /^"([^"]*)"$/.exec(tag.trim())?.[1])
    .filter((base): base is string => base !== undefined)
    .map((base) => base.replace(/\.(br|gz)$/, ''))
}

/** Whether `If-None-Match` names this very ETag — strong comparison, a list taken. */
export function noneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  return String(header ?? '')
    .split(',')
    .some((tag) => tag.trim() === etag)
}

export interface BodyEntry {
  readonly key: string
  readonly tag: string
  readonly identity: Buffer
  readonly encoded: Map<'br' | 'gzip', Promise<Buffer>>
  size: number
}

const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function encode(bytes: Buffer, encoding: 'br' | 'gzip'): Promise<Buffer> {
  return encoding === 'br'
    ? brotli(bytes, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: 6,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
        },
      })
    : gzipped(bytes, { level: 6 })
}

/**
 * A least-recently-used cache of bodies under a bound of bytes, one entry per resource (`key`):
 * a new version replaces the former one. A body larger than a quarter of the bound is not kept.
 */
export class PageBodies {
  readonly #entries = new Map<string, BodyEntry>()
  readonly #maxBytes: number
  #bytes = 0

  constructor(maxBytes = BODY_CACHE_BYTES) {
    this.#maxBytes = maxBytes
  }

  /** What the cache holds in all. */
  get bytes(): number {
    return this.#bytes
  }

  /** The tag the cache holds for a resource, without touching it; undefined — none. */
  tagOf(key: string): string | undefined {
    return this.#entries.get(key)?.tag
  }

  /** The entry of a resource at this tag, as the most recently used; undefined — none. */
  get(key: string, tag: string): BodyEntry | undefined {
    const entry = this.#entries.get(key)
    if (entry?.tag !== tag) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry
  }

  /** Keeps the bytes of a resource at a tag, in place of any former tag of it. */
  put(key: string, tag: string, bytes: Uint8Array): BodyEntry {
    const entry: BodyEntry = { key, tag, identity: asBuffer(bytes), encoded: new Map(), size: 0 }
    entry.size = entry.identity.byteLength
    this.#drop(key)
    if (entry.size > this.#maxBytes / 4) return entry
    this.#entries.set(key, entry)
    this.#bytes += entry.size
    this.#evict()
    return entry
  }

  /** The body of an entry in a coding; one compression of each coding, however many ask at once. */
  async body(entry: BodyEntry, encoding: BodyEncoding): Promise<Buffer> {
    if (encoding === 'identity') return entry.identity
    let pending = entry.encoded.get(encoding)
    if (!pending) {
      pending = encode(entry.identity, encoding)
      entry.encoded.set(encoding, pending)
      pending.then(
        (done) => {
          entry.size += done.byteLength
          if (this.#entries.get(entry.key) === entry) {
            this.#bytes += done.byteLength
            this.#evict()
          }
        },
        () => entry.encoded.delete(encoding),
      )
    }
    return pending
  }

  #drop(key: string): void {
    const former = this.#entries.get(key)
    if (!former) return
    this.#entries.delete(key)
    this.#bytes -= former.size
  }

  #evict(): void {
    for (const key of this.#entries.keys()) {
      if (this.#bytes <= this.#maxBytes) return
      this.#drop(key)
    }
  }
}
