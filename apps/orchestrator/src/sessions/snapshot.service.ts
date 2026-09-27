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
  type ObjectStorage,
  type SecretStore,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotPart,
  type SnapshotReference,
} from '@repo/domain'

import { decryptPart, encryptPart, sha256, snapshotAad } from './snapshot-crypto.ts'
import type { SnapshotArchives } from './sandbox-snapshot.ts'
import { validateSnapshotArchives } from './archive-validation.ts'

export interface LoadedSnapshot {
  manifest: SnapshotManifest
  archives: SnapshotArchives
}

/**
 * Host-only snapshot lifecycle. The caller owns the site/turn lease and has stopped the agent.
 * Checks, the Vault data key, encryption and the manifest come first and write nothing: their
 * failure is SNAPSHOT_NOT_WRITTEN, or a 413 for a size or count limit (SNAPSHOT_TOO_LARGE,
 * PUBLICATION_TOO_LARGE), and the turn may be retried. Only then an atomic reservation
 * prevents concurrent or repeated writes to immutable turn keys. A crash after it may leave an
 * incomplete reservation: P2 reconciliation must inspect it under the site lease, never blindly
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
    input: SnapshotMetadata,
    inputArchives: SnapshotArchives,
    signal?: AbortSignal,
  ): Promise<SnapshotManifest> {
    let metadata: SnapshotMetadata
    let archives: SnapshotArchives
    try {
      metadata = parseMetadata(input)
      // Only the owned, checked copies are encrypted; the caller may still mutate its buffers.
      archives = await validateSnapshotArchives(metadata.home, inputArchives)
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
    const manifestKey = `${prefix}manifest.json`
    const { manifest, encoded, bodies } = await this.seal(metadata, archives)
    if (signal?.aborted)
      throw new DomainError('SNAPSHOT_NOT_WRITTEN', 'Snapshot save was interrupted', 409)
    // Past the reservation an interruption is ambiguous: the reservation and parts stay.
    const assertActive = () => {
      if (signal?.aborted)
        throw new DomainError('SNAPSHOT_SAVE_FAILED', 'Snapshot save was interrupted', 409)
    }
    try {
      const claimed = await this.storage.putIfAbsent(
        'sessions',
        `${prefix}reservation.json`,
        Buffer.from(JSON.stringify({ writer: randomUUID() })),
        { contentType: 'application/json' },
      )
      if (!claimed) throw conflict('Snapshot already exists or is being written')
      if (await this.storage.exists('sessions', manifestKey))
        throw conflict('Snapshot already exists')
      // Only wrapped keys and authenticated ciphertext reach S3.
      for (const part of manifest.parts) {
        assertActive()
        await this.storage.put('sessions', part.key, bodies[part.name], {
          contentType: 'application/octet-stream',
          sizeBytes: part.sizeBytes,
        })
      }
      assertActive()
      // The sole commit point. Readers never treat a reservation or individual parts as a snapshot.
      await this.storage.put('sessions', manifestKey, encoded, { contentType: 'application/json' })
      return manifest
    } catch (error) {
      // A failed response does not prove the remote PUT stopped. Keep the reservation and
      // partial objects so a late write cannot corrupt another writer using the same keys.
      if (isDomainError(error)) throw error
      throw new DomainError('SNAPSHOT_SAVE_FAILED', 'Could not save the turn snapshot', 502)
    }
  }

  /** No side effects: one data key per snapshot, zeroed as soon as all parts are sealed. */
  private async seal(
    metadata: SnapshotMetadata,
    archives: SnapshotArchives,
  ): Promise<{ manifest: SnapshotManifest; encoded: Buffer; bodies: SnapshotArchives }> {
    const prefix = turnSnapshotPrefix(metadata.sessionId, metadata.turn)
    let dataKey: Uint8Array | undefined
    try {
      const keyId = `ws-${metadata.workspaceId}`
      const issued = await this.secrets.transitDataKey(keyId)
      dataKey = issued.plaintext
      const base = {
        ...metadata,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION as typeof SNAPSHOT_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      }
      const bodies = {} as SnapshotArchives
      const parts: SnapshotPart[] = []
      for (const name of snapshotPartNames) {
        const sealed = encryptPart(archives[name], dataKey, snapshotAad(base, name))
        bodies[name] = sealed.body
        parts.push({
          name,
          key: `${prefix}${snapshotPartFiles[name]}`,
          sha256: sha256(sealed.body),
          sizeBytes: sealed.body.byteLength,
          encryption: {
            algorithm: 'aes-256-gcm',
            keyId,
            wrappedKey: issued.ciphertext,
            iv: sealed.iv,
            tag: sealed.tag,
          },
        })
      }
      dataKey.fill(0)
      const manifest = snapshotManifestSchema.parse({ ...base, parts })
      const encoded = Buffer.from(JSON.stringify(manifest))
      if (encoded.byteLength > snapshotLimits.manifestBytes)
        throw snapshotTooLarge('Snapshot manifest is too large')
      return { manifest, encoded, bodies }
    } catch (error) {
      // Nothing was sent to storage, so no reservation blocks a retry of this turn.
      if (isTooLarge(error)) throw error
      throw new DomainError('SNAPSHOT_NOT_WRITTEN', 'Could not prepare the turn snapshot', 502)
    } finally {
      dataKey?.fill(0)
    }
  }

  async load(input: SnapshotReference): Promise<LoadedSnapshot> {
    const result = snapshotReferenceSchema.safeParse(input)
    if (!result.success) throw badRequest('Invalid snapshot reference')
    const expected = result.data
    const prefix = turnSnapshotPrefix(expected.sessionId, expected.turn)
    try {
      const bytes = await this.read(`${prefix}manifest.json`, snapshotLimits.manifestBytes)
      let json: unknown
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch {
        throw badRequest('Invalid snapshot manifest')
      }
      const parsed = snapshotManifestSchema.safeParse(json)
      if (!parsed.success) throw badRequest('Invalid snapshot manifest')
      const manifest = parsed.data
      assertCompatible(manifest, expected)

      // Every part is read and hash-checked before the single data key is unwrapped.
      const bodies: Array<{ part: SnapshotPart; body: Uint8Array }> = []
      for (const part of manifest.parts) {
        // Keys are checked by the schema, derived again here to keep the trust boundary explicit.
        const body = await this.read(`${prefix}${snapshotPartFiles[part.name]}`, part.sizeBytes)
        if (body.byteLength !== part.sizeBytes || sha256(body) !== part.sha256) {
          throw badRequest('Snapshot part failed its size or hash check')
        }
        bodies.push({ part, body })
      }
      // The schema requires one wrapped key shared by all parts.
      const key = await this.secrets.transitDecryptDataKey(
        `ws-${expected.workspaceId}`,
        manifest.parts[0]!.encryption.wrappedKey,
      )
      const archives = {} as SnapshotArchives
      try {
        for (const { part, body } of bodies)
          archives[part.name] = decryptPart(
            body,
            key,
            snapshotAad(manifest, part.name),
            part.encryption.iv,
            part.encryption.tag,
          )
      } finally {
        key.fill(0)
      }
      return { manifest, archives: await validateSnapshotArchives(expected.home, archives) }
    } catch (error) {
      // A stored part over today's limits is an unusable snapshot, not the client's input.
      if (isDomainError(error) && !isTooLarge(error)) throw error
      throw new DomainError('SNAPSHOT_LOAD_FAILED', 'Could not load the turn snapshot', 502)
    }
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
