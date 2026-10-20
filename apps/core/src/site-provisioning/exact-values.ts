import { Buffer } from 'node:buffer'

import { siteImportLimits } from '@repo/domain'

import { refuse } from './import-failure.ts'

/**
 * The exact secrets of a site — what the access in Vault holds (`scanValues`) and what its
 * configuration files hold (`SiteAdapter.configSecrets`) — searched for in every downloaded file.
 * A file with one of them is left out of the import as `secret`. A value that turns up in more
 * than `exactValueFiles` files is too common to be a secret one can keep out file by file: the
 * import fails `access_value_common` (a password like `admin` would otherwise empty the site).
 * The values live in this object only; nothing of them is stored, logged or returned.
 */
export class ExactValues {
  readonly #values: Buffer[]
  readonly #files: number[]
  /** Bytes a value may straddle between two chunks. */
  readonly #overlap: number

  constructor(values: Iterable<string>) {
    const unique = new Set<string>()
    for (const value of values) if (typeof value === 'string' && value.length > 0) unique.add(value)
    this.#values = [...unique].map((value) => Buffer.from(value, 'utf8'))
    this.#files = this.#values.map(() => 0)
    this.#overlap = Math.max(0, ...this.#values.map((value) => value.byteLength - 1))
  }

  get size(): number {
    return this.#values.length
  }

  /** A search over one file, fed chunk by chunk as it arrives. */
  file(): ExactValueSearch {
    return new ExactValueSearch(this.#values, this.#overlap)
  }

  /** Counts the values one file held; throws once a value is in too many files. */
  record(found: ReadonlySet<number>): void {
    for (const index of found) {
      const files = (this.#files[index] ?? 0) + 1
      this.#files[index] = files
      if (files > siteImportLimits.exactValueFiles) throw refuse('access_value_common')
    }
  }
}

export class ExactValueSearch {
  readonly #values: readonly Buffer[]
  readonly #overlap: number
  readonly #found = new Set<number>()
  #tail: Buffer = Buffer.alloc(0)

  constructor(values: readonly Buffer[], overlap: number) {
    this.#values = values
    this.#overlap = overlap
  }

  feed(chunk: Uint8Array): void {
    if (this.#values.length === 0 || this.#found.size === this.#values.length) return
    // The tail of the previous chunk in front: a value cut in two by the transfer is found too.
    const window = this.#tail.byteLength
      ? Buffer.concat([this.#tail, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    for (const [index, value] of this.#values.entries())
      if (!this.#found.has(index) && window.includes(value)) this.#found.add(index)
    const keep = Math.min(this.#overlap, window.byteLength)
    this.#tail = Buffer.from(window.subarray(window.byteLength - keep))
  }

  /** Indexes of the values the file held. */
  get found(): ReadonlySet<number> {
    return this.#found
  }
}
