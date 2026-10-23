import { timingSafeEqual } from 'node:crypto'

import { Prisma } from '@repo/db'
import {
  badRequest,
  conflict,
  DomainError,
  isDomainError,
  snapshotTooLarge,
  terminalTaskStatuses,
  workspaceTransitKey,
  type ObjectStorage,
  type SecretStore,
} from '@repo/domain'
import { z } from 'zod'

import { decryptPart, encryptPart, sha256 } from '@repo/snapshots'
import { CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES, CONTENT_SNAPSHOT_MAX_BYTES } from '@repo/site-content'

import { isOneLine } from '../common/one-line.ts'

/** First content slice: bounded text/object state, not media or database dumps. */
export { CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES, CONTENT_SNAPSHOT_MAX_BYTES }
/** The undo window: «Отменить» works this long after the task has finished. */
export const CONTENT_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60_000
/**
 * SQL: the content of the task is over, so its snapshots and its contact map may go. It was
 * retired, or it reached a final status longer ago than the undo window. `task` is the name
 * the query gives to the tasks table.
 */
export const contentExpiredSql = (task: 't' | 'tasks', ttlMs = CONTENT_SNAPSHOT_TTL_MS) => {
  const t = Prisma.raw(task)
  return Prisma.sql`(${t}.content_retired_at IS NOT NULL OR
    (${t}.status = ANY(${[...terminalTaskStatuses]}::"TaskStatus"[])
      AND ${t}.finished_at <= clock_timestamp() - make_interval(secs => ${ttlMs / 1000}::double precision)))`
}
export const contentObjectRefSchema = z.string().min(1).max(1024).refine(isOneLine)
export const contentSnapshotRefSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  siteId: z.uuid(),
  taskId: z.uuid(),
  objectRef: contentObjectRefSchema,
  expiresAt: z.date(),
})
export const contentSnapshotReceiptSchema = contentSnapshotRefSchema.extend({
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(1).max(CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES),
})
export type ContentSnapshotRef = z.infer<typeof contentSnapshotRefSchema>
export type ContentSnapshotReceipt = z.infer<typeof contentSnapshotReceiptSchema>

const artifactSchema = contentSnapshotRefSchema.omit({ expiresAt: true }).extend({
  version: z.literal(1),
  expiresAt: z.iso.datetime(),
  wrappedKey: z.string().min(1).max(2048),
  iv: z.string().regex(/^[a-f0-9]{24}$/),
  tag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z
    .string()
    .max(44_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})
const invalid = () =>
  new DomainError('CONTENT_SNAPSHOT_INVALID', 'Content snapshot failed verification', 409)
const unavailable = () =>
  new DomainError('CONTENT_SNAPSHOT_UNAVAILABLE', 'Content snapshot storage is unavailable', 502)

export function contentSnapshotKey(ref: Pick<ContentSnapshotRef, 'siteId' | 'id'>): string {
  return `snapshots/${ref.siteId}/${ref.id}.json`
}

function aad(ref: ContentSnapshotRef): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      1,
      ref.id,
      ref.workspaceId,
      ref.siteId,
      ref.taskId,
      ref.objectRef,
      ref.expiresAt.toISOString(),
    ]),
  )
}

/** Host-only encrypted backups. No plaintext, keys or S3 URLs are returned to an agent. */
export class ContentSnapshotStorage {
  constructor(
    private readonly storage: Pick<ObjectStorage, 'putIfAbsent' | 'get'>,
    private readonly secrets: Pick<SecretStore, 'transitDataKey' | 'transitDecryptDataKey'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(input: ContentSnapshotRef, source: Uint8Array): Promise<ContentSnapshotReceipt> {
    const ref = this.#ref(input)
    if (!(source instanceof Uint8Array)) throw badRequest('Invalid content snapshot input')
    if (source.byteLength > CONTENT_SNAPSHOT_MAX_BYTES)
      throw snapshotTooLarge('Content snapshot exceeds 32768 bytes')
    // Capture ownership before the first await: a caller cannot change a pending backup.
    const plaintext = Buffer.from(source)
    let dataKey: Uint8Array | undefined
    try {
      const issued = await this.secrets.transitDataKey(workspaceTransitKey(ref.workspaceId))
      dataKey = issued.plaintext
      const sealed = encryptPart(plaintext, dataKey, aad(ref))
      const artifact = artifactSchema.safeParse({
        ...ref,
        version: 1,
        expiresAt: ref.expiresAt.toISOString(),
        wrappedKey: issued.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
        ciphertext: Buffer.from(sealed.body).toString('base64'),
      })
      if (!artifact.success) throw invalid()
      const body = Buffer.from(JSON.stringify(artifact.data))
      if (body.byteLength > CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES) throw snapshotTooLarge()
      const created = await this.storage.putIfAbsent('artifacts', contentSnapshotKey(ref), body, {
        contentType: 'application/json',
        sizeBytes: body.byteLength,
      })
      if (created) return { ...ref, payloadSha256: sha256(body), sizeBytes: body.byteLength }
      // A lost PUT response may be retried. Reuse only the authenticated original, and never
      // overwrite it with a new capture of a site that could have changed in the meantime.
      const existing = await this.#read(ref)
      const prior = await this.#open(ref, existing.body)
      try {
        if (plaintext.byteLength !== prior.byteLength || !timingSafeEqual(plaintext, prior))
          throw conflict('Content snapshot already contains different state')
      } finally {
        prior.fill(0)
      }
      return existing.receipt
    } catch (error) {
      if (
        isDomainError(error) &&
        [
          'CONFLICT',
          'CONTENT_SNAPSHOT_INVALID',
          'SNAPSHOT_TOO_LARGE',
          'CONTENT_SNAPSHOT_MISSING',
        ].includes(error.code)
      )
        throw error
      throw unavailable()
    } finally {
      plaintext.fill(0)
      dataKey?.fill(0)
    }
  }

  async load(input: ContentSnapshotReceipt): Promise<Uint8Array> {
    const parsed = contentSnapshotReceiptSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid content snapshot reference')
    const { payloadSha256, sizeBytes, ...metadata } = parsed.data
    // The capture expiry bounds only the earliest purge; the journal keeps a snapshot
    // restorable until the undo window after the task has passed.
    const ref = this.#ref(metadata, false)
    try {
      const stored = await this.#read(ref)
      if (stored.receipt.payloadSha256 !== payloadSha256 || stored.receipt.sizeBytes !== sizeBytes)
        throw invalid()
      return await this.#open(ref, stored.body)
    } catch (error) {
      if (
        isDomainError(error) &&
        ['CONTENT_SNAPSHOT_INVALID', 'CONTENT_SNAPSHOT_MISSING'].includes(error.code)
      )
        throw error
      throw unavailable()
    }
  }

  #ref(input: ContentSnapshotRef, capture = true): ContentSnapshotRef {
    const parsed = contentSnapshotRefSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid content snapshot reference')
    if (capture && parsed.data.expiresAt.getTime() <= this.now().getTime())
      throw new DomainError('CONTENT_SNAPSHOT_EXPIRED', 'Content snapshot has expired', 410)
    // Dates are mutable too: keep an owned reference across asynchronous storage calls.
    return { ...parsed.data, expiresAt: new Date(parsed.data.expiresAt) }
  }

  async #read(ref: ContentSnapshotRef) {
    const stream = await this.storage.get('artifacts', contentSnapshotKey(ref))
    if (!stream)
      throw new DomainError('CONTENT_SNAPSHOT_MISSING', 'Content snapshot is missing', 404)
    const chunks: Buffer[] = []
    let sizeBytes = 0
    for await (const chunk of stream) {
      sizeBytes += chunk.byteLength
      if (sizeBytes > CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES) throw invalid()
      chunks.push(Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    return { body, receipt: { ...ref, payloadSha256: sha256(body), sizeBytes } }
  }

  async #open(ref: ContentSnapshotRef, body: Uint8Array): Promise<Uint8Array> {
    let artifact: z.infer<typeof artifactSchema>
    let ciphertext: Buffer
    try {
      artifact = artifactSchema.parse(JSON.parse(Buffer.from(body).toString('utf8')) as unknown)
      const actual = { ...artifact, expiresAt: new Date(artifact.expiresAt) }
      if (!timingSafeEqual(aad(ref), aad(actual))) throw invalid()
      ciphertext = Buffer.from(artifact.ciphertext, 'base64')
      if (
        ciphertext.byteLength > CONTENT_SNAPSHOT_MAX_BYTES ||
        ciphertext.toString('base64') !== artifact.ciphertext
      )
        throw invalid()
    } catch {
      throw invalid()
    }
    let key: Uint8Array | undefined
    try {
      try {
        key = await this.secrets.transitDecryptDataKey(
          workspaceTransitKey(ref.workspaceId),
          artifact.wrappedKey,
        )
      } catch {
        throw unavailable()
      }
      try {
        return decryptPart(ciphertext, key, aad(ref), artifact.iv, artifact.tag)
      } catch {
        throw invalid()
      }
    } finally {
      key?.fill(0)
    }
  }
}
