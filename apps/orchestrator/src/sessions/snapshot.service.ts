import { randomUUID } from 'node:crypto'

import {
  badRequest,
  conflict,
  DomainError,
  isDomainError,
  notFound,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotLimits,
  snapshotManifestSchema,
  snapshotMetadataSchema,
  snapshotPartFiles,
  snapshotPartNames,
  snapshotReferenceSchema,
  turnSnapshotPrefix,
  type ObjectStorage,
  type Sandbox,
  type SecretStore,
  type SnapshotManifest,
  type SnapshotMetadata,
  type SnapshotPart,
  type SnapshotReference,
} from '@repo/domain'

import { decryptPart, encryptPart, sha256, snapshotAad } from './snapshot-crypto.ts'
import { SandboxSnapshotTransport, type SnapshotArchives } from './sandbox-snapshot.ts'
import { validateSnapshotArchives } from './archive-validation.ts'

export interface LoadedSnapshot {
  manifest: SnapshotManifest
  archives: SnapshotArchives
}

/**
 * Host-only snapshot lifecycle. The caller owns the site/turn lease and has stopped the agent.
 * An atomic reservation prevents concurrent or repeated writes to immutable turn keys. A crash
 * may leave an incomplete reservation: P2 reconciliation must inspect it under the site lease,
 * never blindly expire it while its writer could still be alive.
 */
export class SnapshotService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly secrets: SecretStore,
    private readonly transport = new SandboxSnapshotTransport(),
  ) {}

  async capture(sandbox: Sandbox, input: SnapshotMetadata): Promise<SnapshotManifest> {
    const metadata = parseMetadata(input)
    assertSandboxScope(sandbox, metadata)
    if (sandbox.labels.turn !== metadata.turn)
      throw badRequest('Snapshot turn differs from sandbox')
    const parts = await this.transport.capture(sandbox, metadata.home)
    return this.save(metadata, parts)
  }

  async save(input: SnapshotMetadata, inputArchives: SnapshotArchives): Promise<SnapshotManifest> {
    const metadata = parseMetadata(input)
    // Retain the exact checked bytes across asynchronous storage and Vault operations.
    for (const name of snapshotPartNames) {
      const limit = name === 'patch' ? snapshotLimits.patchBytes : snapshotLimits.archiveBytes
      if (!(inputArchives[name] instanceof Uint8Array) || inputArchives[name].byteLength > limit)
        throw badRequest('Invalid or oversized snapshot archive')
    }
    const archives = {
      home: Buffer.from(inputArchives.home),
      untracked: Buffer.from(inputArchives.untracked),
      patch: Buffer.from(inputArchives.patch),
    }
    await validateSnapshotArchives(metadata.home, archives)
    const prefix = turnSnapshotPrefix(metadata.sessionId, metadata.turn)
    const manifestKey = `${prefix}manifest.json`
    const reservationKey = `${prefix}reservation.json`
    let dataKey: Uint8Array | undefined
    try {
      const claimed = await this.storage.putIfAbsent(
        'sessions',
        reservationKey,
        Buffer.from(JSON.stringify({ writer: randomUUID() })),
        { contentType: 'application/json' },
      )
      if (!claimed) throw conflict('Snapshot already exists or is being written')
      if (await this.storage.exists('sessions', manifestKey))
        throw conflict('Snapshot already exists')

      const keyId = `ws-${metadata.workspaceId}`
      const issued = await this.secrets.transitDataKey(keyId)
      dataKey = issued.plaintext
      const base = {
        ...metadata,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION as typeof SNAPSHOT_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      }
      const parts: SnapshotPart[] = []
      for (const name of snapshotPartNames) {
        const sealed = encryptPart(archives[name], dataKey, snapshotAad(base, name))
        const part: SnapshotPart = {
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
        }
        // Only wrapped keys and authenticated ciphertext reach S3.
        parts.push(part)
        await this.storage.put('sessions', part.key, sealed.body, {
          contentType: 'application/octet-stream',
          sizeBytes: part.sizeBytes,
        })
      }
      const manifest = snapshotManifestSchema.parse({ ...base, parts })
      const encoded = Buffer.from(JSON.stringify(manifest))
      if (encoded.byteLength > snapshotLimits.manifestBytes)
        throw badRequest('Snapshot manifest is too large')
      // The sole commit point. Readers never treat a reservation or individual parts as a snapshot.
      await this.storage.put('sessions', manifestKey, encoded, { contentType: 'application/json' })
      return manifest
    } catch (error) {
      // A failed response does not prove the remote PUT stopped. Keep the reservation and
      // partial objects so a late write cannot corrupt another writer using the same keys.
      if (isDomainError(error)) throw error
      throw new DomainError('SNAPSHOT_SAVE_FAILED', 'Could not save the turn snapshot', 502)
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

      const archives = {} as SnapshotArchives
      for (const part of manifest.parts) {
        // Keys are checked by the schema, derived again here to keep the trust boundary explicit.
        const body = await this.read(`${prefix}${snapshotPartFiles[part.name]}`, part.sizeBytes)
        if (body.byteLength !== part.sizeBytes || sha256(body) !== part.sha256) {
          throw badRequest('Snapshot part failed its size or hash check')
        }
        const key = await this.secrets.transitDecryptDataKey(
          `ws-${expected.workspaceId}`,
          part.encryption.wrappedKey,
        )
        try {
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
      }
      await validateSnapshotArchives(expected.home, archives)
      return { manifest, archives }
    } catch (error) {
      if (isDomainError(error)) throw error
      throw new DomainError('SNAPSHOT_LOAD_FAILED', 'Could not load the turn snapshot', 502)
    }
  }

  /** Restore into a fresh, quiescent sandbox whose repo is already at manifest.git.headSha. */
  async restore(
    sandbox: Sandbox,
    expected: SnapshotReference,
  ): Promise<{ manifest: SnapshotManifest; patch: Uint8Array }> {
    assertSandboxScope(sandbox, expected)
    const loaded = await this.load(expected)
    await this.transport.restore(sandbox, loaded.manifest.home, loaded.archives)
    // patch is data for trusted publication/replay, not shell input or an automatically applied diff.
    return { manifest: loaded.manifest, patch: loaded.archives.patch }
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

function assertSandboxScope(
  sandbox: Sandbox,
  expected: Pick<SnapshotReference, 'workspaceId' | 'sessionId'>,
): void {
  if (
    sandbox.labels.workspaceId !== expected.workspaceId ||
    sandbox.labels.sessionId !== expected.sessionId
  ) {
    throw badRequest('Snapshot and sandbox belong to different sessions')
  }
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
