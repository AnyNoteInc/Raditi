import { randomUUID } from 'node:crypto'

import {
  badRequest,
  conflict,
  DomainError,
  isDomainError,
  isTooLarge,
  notFound,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotLimits,
  snapshotManifestSchema,
  snapshotMetadataSchema,
  snapshotPartFiles,
  snapshotPartNames,
  snapshotReferenceSchema,
  snapshotTooLarge,
  turnSnapshotPrefix,
  workspaceTransitKey,
  type ObjectStorage,
  type PresignedRequest,
  type SealedTurnPart,
  type SecretStore,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotPart,
  type SnapshotPartName,
  type SnapshotReference,
  type TurnRestoreSource,
  type TurnSealInput,
} from '@repo/domain'

import {
  assertSnapshotPartSize,
  validateSnapshotParts,
  type SnapshotArchives,
} from './archive-validation.ts'
import { openSnapshotParts, sealSnapshotPart, type SnapshotSealBase } from './snapshot-parts.ts'

export interface LoadedSnapshot {
  manifest: SnapshotManifest
  archives: SnapshotArchives
}

/** A part a TurnExecution seals with the snapshot's data key: its size, known before sealing. */
export interface PendingSnapshotPart {
  sizeBytes: number
}

/** The home part sealed where the archive stays: encrypted there, stored by a presigned PUT. */
export interface SealedElsewhere extends PendingSnapshotPart {
  /** Lifetime of the presigned PUT, asked for right before signing it. */
  ttlMs(): number
  seal(input: TurnSealInput): Promise<SealedTurnPart>
}

/** Each part as bytes core seals, or as a part sealed elsewhere with the same data key. */
export type SnapshotParts<P = PendingSnapshotPart> = {
  [N in SnapshotPartName]: Uint8Array | P
}

/** Sealed in memory: nothing is written before reserve(). */
export interface SealedSnapshot {
  readonly base: SnapshotSealBase
  readonly prefix: string
  readonly keyId: string
  /** The one data key of every part, wrapped by Transit. */
  readonly wrappedKey: string
  /** Parts core sealed; commit() stores them. */
  readonly bodies: Readonly<Partial<Record<SnapshotPartName, Uint8Array>>>
  readonly parts: Readonly<Partial<Record<SnapshotPartName, SnapshotPart>>>
  /** Sizes of the parts still sealed elsewhere; acceptSealedPart() admits each one. */
  readonly pending: Readonly<Partial<Record<SnapshotPartName, number>>>
}

const saveFailed = () =>
  new DomainError('SNAPSHOT_SAVE_FAILED', 'Could not save the turn snapshot', 502)
const interrupted = () =>
  new DomainError('SNAPSHOT_SAVE_FAILED', 'Snapshot save was interrupted', 409)
/**
 * From the reservation request on, a failure is ambiguous: a failed response does not prove the
 * remote PUT stopped. Only a conflict keeps its code; nothing else may claim "nothing written".
 */
const ambiguous = (error: unknown): DomainError =>
  isDomainError(error) && (error.code === 'CONFLICT' || error.code === 'SNAPSHOT_SAVE_FAILED')
    ? error
    : saveFailed()

/**
 * Host-only snapshot lifecycle. The caller owns the site/turn lease and has stopped the agent.
 * seal() checks metadata and parts, gets the Vault data key, encrypts and checks the manifest
 * first, writing nothing: its failure is SNAPSHOT_NOT_WRITTEN, or a 413 for a size or count
 * limit (SNAPSHOT_TOO_LARGE, PUBLICATION_TOO_LARGE), and the turn may be retried. Only then
 * reserve() atomically prevents concurrent or repeated writes to immutable turn keys; a part
 * sealed elsewhere is stored through a presigned PUT and verified (acceptSealedPart), and
 * commit() stores core's parts and the manifest last. A crash after the reservation may leave
 * an incomplete one: P2 reconciliation must inspect it under the site lease, never blindly
 * expire it while its writer could still be alive. A caller that stops waiting aborts `signal`:
 * a save still pending on Vault then writes nothing, and one past its reservation stops before
 * the next object and never commits a manifest.
 */
export class SnapshotService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly secrets: SecretStore,
  ) {}

  async save(
    metadata: SnapshotMetadata,
    parts: SnapshotParts<SealedElsewhere>,
    signal?: AbortSignal,
  ): Promise<SnapshotManifest> {
    let sealed = await this.seal(metadata, parts)
    await this.reserve(sealed, signal)
    for (const name of snapshotPartNames) {
      const part = parts[name]
      if (part instanceof Uint8Array) continue
      try {
        if (signal?.aborted) throw interrupted()
        const put = await this.presignPart(sealed, name, part.ttlMs())
        const stored = await part.seal({
          base: sealed.base,
          dataKey: () => this.dataKey(sealed),
          put,
        })
        sealed = await this.acceptSealedPart(sealed, name, stored, signal)
      } catch (error) {
        throw ambiguous(error)
      }
    }
    return this.commit(sealed, signal)
  }

  /**
   * No side effects: one data key per snapshot, zeroed as soon as core's parts are sealed. A
   * part given by size is sealed elsewhere with the same key (dataKey()).
   */
  async seal(input: SnapshotMetadata, parts: SnapshotParts): Promise<SealedSnapshot> {
    let metadata: SnapshotMetadata
    const archives: Partial<SnapshotArchives> = {}
    const pending: Partial<Record<SnapshotPartName, number>> = {}
    try {
      metadata = parseMetadata(input)
      for (const name of snapshotPartNames) {
        const part = parts?.[name]
        if (part instanceof Uint8Array) archives[name] = part
        else if (Number.isSafeInteger(part?.sizeBytes) && part.sizeBytes >= 0) {
          assertSnapshotPartSize(name, part.sizeBytes)
          pending[name] = part.sizeBytes
        } else throw badRequest('Invalid snapshot part')
      }
      // Only the owned, checked copies are encrypted; the caller may still mutate its buffers.
      Object.assign(archives, await validateSnapshotParts(metadata.home, archives))
    } catch (error) {
      // A size or count limit stays a 413 for the client; it writes nothing either.
      if (isTooLarge(error)) throw error
      throw new DomainError(
        'SNAPSHOT_NOT_WRITTEN',
        'Invalid snapshot input; nothing was written',
        400,
      )
    }
    const prefix = turnSnapshotPrefix(metadata.sessionId, metadata.turn)
    let dataKey: Uint8Array | undefined
    try {
      const keyId = workspaceTransitKey(metadata.workspaceId)
      const issued = await this.secrets.transitDataKey(keyId)
      dataKey = issued.plaintext
      const base: SnapshotSealBase = {
        ...metadata,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      }
      const bodies: Partial<Record<SnapshotPartName, Uint8Array>> = {}
      const sealedParts: Partial<Record<SnapshotPartName, SnapshotPart>> = {}
      for (const name of snapshotPartNames) {
        const plaintext = archives[name]
        if (!plaintext) continue
        const { body, sealed } = sealSnapshotPart(base, name, plaintext, dataKey)
        bodies[name] = body
        sealedParts[name] = snapshotPart(prefix, name, keyId, issued.ciphertext, sealed)
      }
      dataKey.fill(0)
      const snapshot: SealedSnapshot = {
        base,
        prefix,
        keyId,
        wrappedKey: issued.ciphertext,
        bodies,
        parts: sealedParts,
        pending,
      }
      // The manifest is written last, but its schema and limit are checked while nothing is.
      encodeManifest(snapshot)
      return snapshot
    } catch (error) {
      // Nothing was sent to storage, so no reservation blocks a retry of this turn.
      if (isTooLarge(error)) throw error
      throw new DomainError('SNAPSHOT_NOT_WRITTEN', 'Could not prepare the turn snapshot', 502)
    } finally {
      dataKey?.fill(0)
    }
  }

  /** The atomic claim of the turn's keys; from its request on every failure is ambiguous. */
  async reserve(sealed: SealedSnapshot, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      throw new DomainError('SNAPSHOT_NOT_WRITTEN', 'Snapshot save was interrupted', 409)
    try {
      const claimed = await this.storage.putIfAbsent(
        'sessions',
        `${sealed.prefix}reservation.json`,
        Buffer.from(JSON.stringify({ writer: randomUUID() })),
        { contentType: 'application/json' },
      )
      if (!claimed) throw conflict('Snapshot already exists or is being written')
      if (await this.storage.exists('sessions', `${sealed.prefix}manifest.json`))
        throw conflict('Snapshot already exists')
    } catch (error) {
      // Keep the reservation and partial objects so a late write cannot corrupt another writer.
      throw ambiguous(error)
    }
  }

  /** A create-only PUT of one pending part: it can store exactly its size, and only once. */
  async presignPart(
    sealed: SealedSnapshot,
    name: SnapshotPartName,
    ttlMs: number,
  ): Promise<PresignedRequest> {
    const sizeBytes = sealed.pending[name]
    if (sizeBytes === undefined) throw conflict('Snapshot part is not sealed elsewhere')
    return this.storage.presign({
      bucket: 'sessions',
      key: `${sealed.prefix}${snapshotPartFiles[name]}`,
      method: 'PUT',
      sizeBytes,
      ttlMs,
    })
  }

  /** The snapshot's data key, unwrapped again for whoever seals a pending part; zero it. */
  dataKey(sealed: SealedSnapshot): Promise<Uint8Array> {
    return this.secrets.transitDecryptDataKey(sealed.keyId, sealed.wrappedKey)
  }

  /**
   * Admits a part sealed elsewhere only after reading it back: its size and hash, then GCM with
   * the snapshot's AAD, then the archive itself. Past the reservation, so every failure is
   * ambiguous.
   */
  async acceptSealedPart(
    sealed: SealedSnapshot,
    name: SnapshotPartName,
    stored: SealedTurnPart,
    signal?: AbortSignal,
  ): Promise<SealedSnapshot> {
    try {
      if (signal?.aborted) throw interrupted()
      const { [name]: sizeBytes, ...pending } = sealed.pending
      if (sizeBytes === undefined || stored.sizeBytes !== sizeBytes)
        throw badRequest('Sealed part differs from its reservation')
      const part = snapshotPart(sealed.prefix, name, sealed.keyId, sealed.wrappedKey, stored)
      const body = await this.read(part.key, sizeBytes)
      await openSnapshotParts(sealed.base, [{ part, body }], sealed.base.home, () =>
        this.dataKey(sealed),
      )
      return { ...sealed, parts: { ...sealed.parts, [name]: part }, pending }
    } catch (error) {
      throw ambiguous(error)
    }
  }

  /** Stores core's parts, then the manifest: the sole commit point. */
  async commit(sealed: SealedSnapshot, signal?: AbortSignal): Promise<SnapshotManifest> {
    // Past the reservation an interruption is ambiguous: the reservation and parts stay.
    const assertActive = () => {
      if (signal?.aborted) throw interrupted()
    }
    try {
      const { manifest, encoded } = encodeManifest(sealed)
      // Only wrapped keys and authenticated ciphertext reach S3.
      for (const part of manifest.parts) {
        const body = sealed.bodies[part.name]
        if (!body) continue
        assertActive()
        await this.storage.put('sessions', part.key, body, {
          contentType: 'application/octet-stream',
          sizeBytes: part.sizeBytes,
        })
      }
      assertActive()
      // Readers never treat a reservation or individual parts as a snapshot.
      await this.storage.put('sessions', `${sealed.prefix}manifest.json`, encoded, {
        contentType: 'application/json',
      })
      return manifest
    } catch (error) {
      throw ambiguous(error)
    }
  }

  async load(input: SnapshotReference): Promise<LoadedSnapshot> {
    const expected = parseReference(input)
    const prefix = turnSnapshotPrefix(expected.sessionId, expected.turn)
    try {
      const manifest = await this.readManifest(expected)
      // Every part is read and hash-checked before the single data key is unwrapped.
      const stored = []
      for (const part of manifest.parts) {
        // Keys are checked by the schema, derived again here to keep the trust boundary explicit.
        const body = await this.read(`${prefix}${snapshotPartFiles[part.name]}`, part.sizeBytes)
        stored.push({ part, body })
      }
      const archives = await openSnapshotParts(manifest, stored, expected.home, () =>
        this.unwrap(manifest),
      )
      return { manifest, archives }
    } catch (error) {
      throw loadFailed(error)
    }
  }

  /**
   * Turn n−1 for a TurnExecution: the checked manifest, presigned GETs of its three parts and
   * its data key on demand. No part is read here; the executor checks each before any write.
   */
  async restoreSource(input: SnapshotReference, ttlMs: number): Promise<TurnRestoreSource> {
    const expected = parseReference(input)
    const prefix = turnSnapshotPrefix(expected.sessionId, expected.turn)
    try {
      const manifest = await this.readManifest(expected)
      const parts = {} as Record<SnapshotPartName, PresignedRequest>
      for (const name of snapshotPartNames)
        parts[name] = await this.storage.presign({
          bucket: 'sessions',
          key: `${prefix}${snapshotPartFiles[name]}`,
          method: 'GET',
          ttlMs,
        })
      return { manifest, parts, dataKey: () => this.unwrap(manifest) }
    } catch (error) {
      throw loadFailed(error)
    }
  }

  private async readManifest(expected: SnapshotReference): Promise<SnapshotManifest> {
    const prefix = turnSnapshotPrefix(expected.sessionId, expected.turn)
    const bytes = await this.read(`${prefix}manifest.json`, snapshotLimits.manifestBytes)
    let json: unknown
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw badRequest('Invalid snapshot manifest')
    }
    const parsed = snapshotManifestSchema.safeParse(json)
    if (!parsed.success) throw badRequest('Invalid snapshot manifest')
    assertCompatible(parsed.data, expected)
    return parsed.data
  }

  /** The schema requires one wrapped key shared by all parts. */
  private unwrap(manifest: SnapshotManifest): Promise<Uint8Array> {
    return this.secrets.transitDecryptDataKey(
      workspaceTransitKey(manifest.workspaceId),
      manifest.parts[0]!.encryption.wrappedKey,
    )
  }

  private async read(key: string, maxBytes: number): Promise<Uint8Array> {
    const source = await this.storage.get('sessions', key)
    if (source === null) throw notFound('Snapshot or snapshot part is missing')
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of source) {
      total += chunk.byteLength
      if (total > maxBytes) throw badRequest('Snapshot object exceeds its size limit')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
  }
}

function snapshotPart(
  prefix: string,
  name: SnapshotPartName,
  keyId: string,
  wrappedKey: string,
  sealed: SealedTurnPart,
): SnapshotPart {
  return {
    name,
    key: `${prefix}${snapshotPartFiles[name]}`,
    sha256: sealed.sha256,
    sizeBytes: sealed.sizeBytes,
    encryption: { algorithm: 'aes-256-gcm', keyId, wrappedKey, iv: sealed.iv, tag: sealed.tag },
  }
}

/**
 * The manifest with its parts in their fixed order. A pending part counts with its reserved
 * size and the longest hash, IV and tag, so seal() checks the final schema and size limit.
 */
function encodeManifest(sealed: SealedSnapshot): { manifest: SnapshotManifest; encoded: Buffer } {
  const parts = snapshotPartNames.map((name) => {
    const part = sealed.parts[name]
    if (part) return part
    const sizeBytes = sealed.pending[name]
    if (sizeBytes === undefined) throw badRequest('Snapshot part is missing')
    return snapshotPart(sealed.prefix, name, sealed.keyId, sealed.wrappedKey, {
      sha256: '0'.repeat(64),
      sizeBytes,
      iv: '0'.repeat(24),
      tag: '0'.repeat(32),
    })
  })
  const manifest = snapshotManifestSchema.parse({ ...sealed.base, parts })
  const encoded = Buffer.from(JSON.stringify(manifest))
  if (encoded.byteLength > snapshotLimits.manifestBytes)
    throw snapshotTooLarge('Snapshot manifest is too large')
  return { manifest, encoded }
}

/** A stored part over today's limits is an unusable snapshot, not the client's input. */
function loadFailed(error: unknown): DomainError {
  if (isDomainError(error) && !isTooLarge(error)) return error
  return new DomainError('SNAPSHOT_LOAD_FAILED', 'Could not load the turn snapshot', 502)
}

function parseReference(input: SnapshotReference): SnapshotReference {
  const result = snapshotReferenceSchema.safeParse(input)
  if (!result.success) throw badRequest('Invalid snapshot reference')
  return result.data
}

function parseMetadata(input: SnapshotMetadata): SnapshotMetadata {
  const parsed = snapshotMetadataSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid snapshot metadata')
  return parsed.data
}

function assertCompatible(manifest: SnapshotManifest, expected: SnapshotReference): void {
  const home = (value: SnapshotReference['home']) =>
    JSON.stringify([value.root, [...value.include].sort(), [...value.exclude].sort()])
  if (
    manifest.workspaceId !== expected.workspaceId ||
    manifest.sessionId !== expected.sessionId ||
    manifest.turn !== expected.turn ||
    manifest.image !== expected.image ||
    manifest.driver.id !== expected.driver.id ||
    manifest.driver.version !== expected.driver.version ||
    home(manifest.home) !== home(expected.home)
  ) {
    throw conflict('Snapshot is incompatible with the requested session, image or driver')
  }
}
