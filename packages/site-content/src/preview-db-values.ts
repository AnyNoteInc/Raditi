import { timingSafeEqual } from 'node:crypto'

import {
  badRequest,
  conflict,
  dbObjectRefSchema,
  dbObjectStateSchema,
  DomainError,
  isDomainError,
  isRecordState,
  workspaceTransitKey,
  type DbObjectState,
  type DbValueRef,
  type ObjectStorage,
  type PublishedContentState,
  type SecretStore,
} from '@repo/domain'
import { z } from 'zod'

import { decryptPart, encryptPart, sha256 } from '@repo/snapshots'
import {
  CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES,
  CONTENT_SNAPSHOT_MAX_BYTES,
} from './content-limits.ts'

/**
 * The values of one operation of a candidate's database plan (docs/plan/53-chat-preview-release.
 * md, Р3, Р24, Р30, «Операции БД и миграции»): the whole state of the object before and after
 * an agent's write into the preview — a record, its absence, a setting, a table of the platform —
 * each an object of `raditi-artifacts` sealed with the data key of the workspace
 * (Transit `ws-<wsId>`). A release replays `after` on production byte for byte and puts `before`
 * back when it rolls back; a plan keeps only their references (`dbValueRefSchema`).
 */

export const previewDbValueSides = ['before', 'after'] as const
export type PreviewDbValueSide = (typeof previewDbValueSides)[number]

/** Whose value it is: the journal row of the write it belongs to. */
export const previewDbValueRefSchema = z.strictObject({
  workspaceId: z.uuid(),
  taskId: z.uuid(),
  previewId: z.uuid(),
  /** `mcp_calls.id` of the write. */
  callId: z.uuid(),
  side: z.enum(previewDbValueSides),
  objectRef: dbObjectRefSchema,
})
export type PreviewDbValueRef = z.infer<typeof previewDbValueRefSchema>

/** `tasks/<taskId>/db/<callId>/<side>.json`: the values outlive the preview, not the task. */
export function previewDbValueKey(ref: Pick<PreviewDbValueRef, 'taskId' | 'callId' | 'side'>) {
  return `tasks/${ref.taskId.toLowerCase()}/db/${ref.callId.toLowerCase()}/${ref.side}.json`
}

const artifactSchema = previewDbValueRefSchema.extend({
  version: z.literal(1),
  wrappedKey: z.string().min(1).max(2048),
  iv: z.string().regex(/^[a-f0-9]{24}$/),
  tag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z
    .string()
    .max(44_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})

const invalid = () =>
  new DomainError('PREVIEW_DB_VALUE_INVALID', 'Database plan value failed verification', 409)
const unavailable = () =>
  new DomainError('PREVIEW_DB_VALUE_UNAVAILABLE', 'Database plan value storage is unavailable', 502)

function aad(ref: PreviewDbValueRef): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      1,
      'preview-db-value',
      ref.workspaceId,
      ref.taskId,
      ref.previewId,
      ref.callId,
      ref.side,
      ref.objectRef,
    ]),
  )
}

/** Host-only, create-only, sealed: nothing of a value or its key reaches an agent. */
export class PreviewDbValueStorage {
  private readonly storage: Pick<ObjectStorage, 'putIfAbsent' | 'get'>
  private readonly secrets: Pick<SecretStore, 'transitDataKey' | 'transitDecryptDataKey'>

  constructor(
    storage: Pick<ObjectStorage, 'putIfAbsent' | 'get'>,
    secrets: Pick<SecretStore, 'transitDataKey' | 'transitDecryptDataKey'>,
  ) {
    this.storage = storage
    this.secrets = secrets
  }

  /**
   * Seals and stores one side of a write; a repeat with the same state answers the stored object,
   * another state for the same key is a conflict.
   */
  async save(input: PreviewDbValueRef, state: DbObjectState): Promise<DbValueRef> {
    const ref = this.#ref(input)
    const parsed = dbObjectStateSchema.safeParse(state)
    if (!parsed.success || parsed.data.objectRef !== ref.objectRef)
      throw badRequest('Invalid database plan value')
    const plaintext = Buffer.from(JSON.stringify(parsed.data))
    let dataKey: Uint8Array | undefined
    try {
      if (plaintext.byteLength > CONTENT_SNAPSHOT_MAX_BYTES)
        throw new DomainError('CONTENT_TOO_LARGE', 'Published content exceeds its limit', 413)
      const issued = await this.secrets.transitDataKey(workspaceTransitKey(ref.workspaceId))
      dataKey = issued.plaintext
      const sealed = encryptPart(plaintext, dataKey, aad(ref))
      const artifact = artifactSchema.safeParse({
        ...ref,
        version: 1,
        wrappedKey: issued.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
        ciphertext: Buffer.from(sealed.body).toString('base64'),
      })
      if (!artifact.success) throw invalid()
      const body = Buffer.from(JSON.stringify(artifact.data))
      if (body.byteLength > CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES) throw invalid()
      const key = previewDbValueKey(ref)
      if (
        await this.storage.putIfAbsent('artifacts', key, body, {
          contentType: 'application/json',
          sizeBytes: body.byteLength,
        })
      )
        return { key, sha256: sha256(body), sizeBytes: body.byteLength }
      // A lost PUT response may be retried: the stored value must be the same state.
      const stored = await this.#read(key)
      const prior = await this.#open(ref, stored)
      try {
        if (prior.byteLength !== plaintext.byteLength || !timingSafeEqual(prior, plaintext))
          throw conflict('Database plan value already holds another state')
      } finally {
        prior.fill(0)
      }
      return { key, sha256: sha256(stored), sizeBytes: stored.byteLength }
    } catch (error) {
      if (
        isDomainError(error) &&
        ['CONFLICT', 'CONTENT_TOO_LARGE', 'PREVIEW_DB_VALUE_INVALID'].includes(error.code)
      )
        throw error
      throw unavailable()
    } finally {
      plaintext.fill(0)
      dataKey?.fill(0)
    }
  }

  /** The state of a record one side holds; any other state is not the value asked for. */
  async load(input: PreviewDbValueRef, value: DbValueRef): Promise<PublishedContentState> {
    const state = await this.loadState(input, value)
    if (!isRecordState(state)) throw invalid()
    return state
  }

  /** The state one side holds, checked against its reference. */
  async loadState(input: PreviewDbValueRef, value: DbValueRef): Promise<DbObjectState> {
    const ref = this.#ref(input)
    if (value.key !== previewDbValueKey(ref)) throw invalid()
    try {
      const stored = await this.#read(value.key)
      if (sha256(stored) !== value.sha256 || stored.byteLength !== value.sizeBytes) throw invalid()
      const plaintext = await this.#open(ref, stored)
      try {
        const state = dbObjectStateSchema.safeParse(
          JSON.parse(Buffer.from(plaintext).toString('utf8')) as unknown,
        )
        if (!state.success || state.data.objectRef !== ref.objectRef) throw invalid()
        return state.data
      } finally {
        plaintext.fill(0)
      }
    } catch (error) {
      if (isDomainError(error) && error.code === 'PREVIEW_DB_VALUE_INVALID') throw error
      throw unavailable()
    }
  }

  #ref(input: PreviewDbValueRef): PreviewDbValueRef {
    const parsed = previewDbValueRefSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid database plan value reference')
    return parsed.data
  }

  async #read(key: string): Promise<Buffer> {
    const stream = await this.storage.get('artifacts', key)
    if (!stream) throw invalid()
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
      size += chunk.byteLength
      if (size > CONTENT_SNAPSHOT_ARTIFACT_MAX_BYTES) throw invalid()
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async #open(ref: PreviewDbValueRef, body: Uint8Array): Promise<Uint8Array> {
    let artifact: z.infer<typeof artifactSchema>
    let ciphertext: Buffer
    try {
      artifact = artifactSchema.parse(JSON.parse(Buffer.from(body).toString('utf8')) as unknown)
      if (!timingSafeEqual(aad(ref), aad(artifact))) throw invalid()
      ciphertext = Buffer.from(artifact.ciphertext, 'base64')
      if (ciphertext.toString('base64') !== artifact.ciphertext) throw invalid()
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
