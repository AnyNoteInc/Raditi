import { Buffer } from 'node:buffer'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib'

import {
  badRequest,
  databaseCopyLimits,
  DomainError,
  workspaceTransitKey,
  type DatabaseCopier,
  type DatabaseCopyInput,
  type DatabaseCopySummary,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { z } from 'zod'

// The seed of a preview's database (docs/plan/53-chat-preview-release.md, Р15): the copy of the
// site's database filtered at the source, compressed with zstd and sealed like the parts of a turn
// snapshot — AES-256-GCM under a data key of Transit `ws-<workspaceId>`, the metadata bound into
// the additional data — in `raditi-artifacts`, `previews/<siteId>/<previewId>/seed.sql.zst.enc`.
// The object carries its wrapped key and IV in a header and the tag after the ciphertext; the row
// of the preview keeps its key and SHA-256, which is checked before anything of it is decrypted.
// A seed may be hundreds of MiB: it is sealed and opened in chunks, never held twice.

/** The object as stored: a magic line, the length of its header, the header, the ciphertext, the tag. */
const MAGIC = Buffer.from('RADITI-SEED-2\n')
const TAG_BYTES = 16

export const previewSeedLimits = Object.freeze({
  /** The compressed seed: a copy compresses well below its `seedBytes`. */
  storedBytes: 256 * 1024 * 1024,
  headerBytes: 4096,
  /** The plaintext a loaded seed may expand to: what the copier may write. */
  expandedBytes: databaseCopyLimits.seedBytes,
})

export const previewSeedKey = (siteId: string, previewId: string): string =>
  `previews/${siteId.toLowerCase()}/${previewId.toLowerCase()}/seed.sql.zst.enc`

export interface PreviewSeedRef {
  workspaceId: string
  siteId: string
  previewId: string
  /** `sites.installed_release_id` when the copy was taken; null — the version of the import. */
  releaseId: string | null
}

const headerSchema = z.strictObject({
  v: z.literal(2),
  wrappedKey: z.string().min(1).max(2048),
  iv: z.string().regex(/^[a-f0-9]{24}$/),
})

const aad = (ref: PreviewSeedRef): Uint8Array =>
  Buffer.from(
    JSON.stringify([
      2,
      'preview-seed',
      ref.workspaceId.toLowerCase(),
      ref.siteId.toLowerCase(),
      ref.previewId.toLowerCase(),
      ref.releaseId?.toLowerCase() ?? null,
    ]),
  )

const seedTooLarge = () =>
  new DomainError('PREVIEW_SEED_TOO_LARGE', 'The seed of the preview exceeds its limit', 413)
const seedInvalid = () =>
  new DomainError('PREVIEW_SEED_INVALID', 'The seed of the preview failed verification', 409)

export interface StoredSeed {
  key: string
  sha256: string
  summary: DatabaseCopySummary
}

/**
 * Copies the site's database (`copier`), compresses and seals the copy as it comes and stores it.
 * Nothing of the copy lands on a disk; only its sealed form is held in memory, once.
 */
export async function storePreviewSeed(
  deps: {
    copier: DatabaseCopier
    storage: Pick<ObjectStorage, 'put'>
    secrets: Pick<SecretStore, 'transitDataKey'>
  },
  ref: PreviewSeedRef,
  input: DatabaseCopyInput,
  signal: AbortSignal,
): Promise<StoredSeed> {
  const issued = await deps.secrets.transitDataKey(workspaceTransitKey(ref.workspaceId))
  if (issued.plaintext.byteLength !== 32) {
    issued.plaintext.fill(0)
    throw badRequest('A seed requires a 256-bit data key')
  }
  const iv = randomBytes(12)
  let cipher: CipherGCM
  try {
    cipher = createCipheriv('aes-256-gcm', issued.plaintext, iv, { authTagLength: TAG_BYTES })
  } finally {
    issued.plaintext.fill(0)
  }
  cipher.setAAD(aad(ref))
  const header = Buffer.from(
    JSON.stringify(
      headerSchema.parse({ v: 2, wrappedKey: issued.ciphertext, iv: iv.toString('hex') }),
    ),
  )
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.byteLength)
  const sealed: Buffer[] = [MAGIC, length, header]

  const compressor = createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 6 } })
  let stored = 0
  compressor.on('data', (chunk: Buffer) => {
    stored += chunk.byteLength
    if (stored > previewSeedLimits.storedBytes) compressor.destroy(seedTooLarge())
    else sealed.push(cipher.update(chunk))
  })
  const ended = once(compressor, 'end')
  // A failure of the stream reaches the next write or the end, whichever comes first.
  ended.catch(() => {})
  const summary = await deps.copier.copy(
    input,
    async (chunk) => {
      if (compressor.destroyed) throw compressor.errored ?? seedTooLarge()
      if (!compressor.write(chunk)) await once(compressor, 'drain', { signal })
    },
    signal,
  )
  compressor.end()
  await ended
  sealed.push(cipher.final(), cipher.getAuthTag())

  const hash = createHash('sha256')
  let size = 0
  for (const part of sealed) {
    hash.update(part)
    size += part.byteLength
  }
  const key = previewSeedKey(ref.siteId, ref.previewId)
  await deps.storage.put(
    'artifacts',
    key,
    (async function* () {
      // Each part is let go once it is sent.
      while (sealed.length) yield sealed.shift()!
    })(),
    { contentType: 'application/octet-stream', sizeBytes: size },
  )
  return { key, sha256: hash.digest('hex'), summary }
}

/**
 * The seed as SQL to load: the stored object is read and checked against the SHA-256 the row
 * keeps before its key is unwrapped, and authenticated whole before any plaintext is given out;
 * then it is decrypted and decompressed as it is read.
 */
export async function openPreviewSeed(
  deps: {
    storage: Pick<ObjectStorage, 'get'>
    secrets: Pick<SecretStore, 'transitDecryptDataKey'>
  },
  ref: PreviewSeedRef,
  stored: { key: string; sha256: string },
): Promise<AsyncIterable<Uint8Array>> {
  if (stored.key !== previewSeedKey(ref.siteId, ref.previewId))
    throw badRequest('The seed belongs to another preview')
  const stream = await deps.storage.get('artifacts', stored.key)
  if (!stream)
    throw new DomainError('PREVIEW_SEED_MISSING', 'The seed of the preview is missing', 404)
  const chunks: Buffer[] = []
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > previewSeedLimits.storedBytes + previewSeedLimits.headerBytes + 64)
      throw seedTooLarge()
    const part = Buffer.from(chunk)
    hash.update(part)
    chunks.push(part)
  }
  if (hash.digest('hex') !== stored.sha256) throw seedInvalid()
  const object = new Chunks(chunks, size)
  let header: z.infer<typeof headerSchema>
  let start: number
  try {
    if (!object.read(0, MAGIC.byteLength).equals(MAGIC)) throw seedInvalid()
    const length = object.read(MAGIC.byteLength, 4).readUInt32BE(0)
    if (length > previewSeedLimits.headerBytes) throw seedInvalid()
    start = MAGIC.byteLength + 4 + length
    if (start + TAG_BYTES > size) throw seedInvalid()
    header = headerSchema.parse(
      JSON.parse(object.read(MAGIC.byteLength + 4, length).toString('utf8')) as unknown,
    )
  } catch {
    throw seedInvalid()
  }
  const tag = object.read(size - TAG_BYTES, TAG_BYTES)
  const key = await deps.secrets.transitDecryptDataKey(
    workspaceTransitKey(ref.workspaceId),
    header.wrappedKey,
  )
  const decipher = () => {
    const opened = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'hex'), {
      authTagLength: TAG_BYTES,
    })
    opened.setAAD(aad(ref))
    opened.setAuthTag(tag)
    return opened
  }
  let reader: DecipherGCM
  try {
    if (key.byteLength !== 32) throw seedInvalid()
    // The tag is checked over the whole ciphertext first; what this pass decrypts is wiped.
    const check = decipher()
    for (const part of object.slices(start, size - TAG_BYTES)) check.update(part).fill(0)
    check.final()
    reader = decipher()
  } catch {
    throw seedInvalid()
  } finally {
    // Each decipher holds its own copy of the key.
    key.fill(0)
  }
  return expand(object, start, size - TAG_BYTES, reader)
}

/** The chunks of a stored object read as one, without joining them. */
class Chunks {
  constructor(
    readonly parts: Buffer[],
    readonly size: number,
  ) {}

  /** The bytes from `at`, `length` of them. */
  read(at: number, length: number): Buffer {
    const out: Buffer[] = []
    for (const part of this.slices(at, at + length)) out.push(part)
    return Buffer.concat(out)
  }

  /** Views of the bytes from `from` to `to`, part by part. */
  *slices(from: number, to: number): Iterable<Buffer> {
    let offset = 0
    for (const part of this.parts) {
      const end = offset + part.byteLength
      if (end > from && offset < to)
        yield part.subarray(Math.max(0, from - offset), Math.min(part.byteLength, to - offset))
      offset = end
      if (offset >= to) return
    }
  }
}

async function* expand(
  object: Chunks,
  from: number,
  to: number,
  decipher: DecipherGCM,
): AsyncIterable<Uint8Array> {
  const decompressor = createZstdDecompress({
    params: {
      [constants.ZSTD_d_windowLogMax]: Math.ceil(Math.log2(previewSeedLimits.expandedBytes)),
    },
  })
  async function* plaintext(): AsyncIterable<Buffer> {
    for (const part of object.slices(from, to)) yield decipher.update(part)
    yield decipher.final()
  }
  let expanded = 0
  try {
    for await (const chunk of Readable.from(plaintext()).pipe(decompressor)) {
      expanded += (chunk as Buffer).byteLength
      if (expanded > previewSeedLimits.expandedBytes) throw seedTooLarge()
      yield chunk as Buffer
    }
  } finally {
    decompressor.destroy()
  }
}
