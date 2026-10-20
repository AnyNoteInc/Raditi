import type { Buffer } from 'node:buffer'

import {
  badRequest,
  type SealedTurnPart,
  type SessionState,
  type SnapshotManifest,
  type SnapshotPart,
  type SnapshotPartName,
} from '@repo/domain'

import { validateSnapshotParts, type SnapshotArchives } from './archive-validation.ts'
import { decryptPart, encryptPart, sha256, snapshotAad } from './snapshot-crypto.ts'

/** What every part's AAD binds: the manifest without its parts. */
export type SnapshotSealBase = Omit<SnapshotManifest, 'parts'>

/** One part under the snapshot's data key; the hash and size are those of the ciphertext. */
export function sealSnapshotPart(
  base: SnapshotSealBase,
  name: SnapshotPartName,
  plaintext: Uint8Array,
  key: Uint8Array,
): { body: Buffer; sealed: SealedTurnPart } {
  const { body, iv, tag } = encryptPart(plaintext, key, snapshotAad(base, name))
  return { body, sealed: { sha256: sha256(body), sizeBytes: body.byteLength, iv, tag } }
}

export interface StoredSnapshotPart<N extends SnapshotPartName = SnapshotPartName> {
  part: SnapshotPart & { name: N }
  body: Uint8Array
}

/**
 * Opens parts of one snapshot wherever they were read (core from S3, a sandbox host through
 * presigned GETs): every size and hash is checked before the data key is asked for, all parts
 * are decrypted with that one key, which is zeroed, and the archives are validated. Only the
 * returned copies may be used.
 */
export async function openSnapshotParts<N extends SnapshotPartName>(
  base: SnapshotSealBase,
  stored: ReadonlyArray<StoredSnapshotPart<N>>,
  home: SessionState,
  dataKey: () => Promise<Uint8Array>,
): Promise<Pick<SnapshotArchives, N>> {
  for (const { part, body } of stored)
    if (body.byteLength !== part.sizeBytes || sha256(body) !== part.sha256)
      throw badRequest('Snapshot part failed its size or hash check')
  const key = await dataKey()
  const archives: Partial<SnapshotArchives> = {}
  try {
    for (const { part, body } of stored)
      archives[part.name] = decryptPart(
        body,
        key,
        snapshotAad(base, part.name),
        part.encryption.iv,
        part.encryption.tag,
      )
  } finally {
    key.fill(0)
  }
  return validateSnapshotParts(home, archives as Pick<SnapshotArchives, N>)
}
