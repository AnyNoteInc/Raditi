import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { badRequest, type SnapshotManifest, type SnapshotPartName } from '@repo/domain'

/** Bind every piece of resume metadata, not just the object name, to the authentication tag. */
export function snapshotAad(
  manifest: Omit<SnapshotManifest, 'parts'>,
  part: SnapshotPartName,
): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      manifest.schemaVersion,
      manifest.workspaceId,
      manifest.sessionId,
      manifest.turn,
      manifest.createdAt,
      manifest.image,
      manifest.driver.id,
      manifest.driver.version,
      manifest.driver.nativeSessionId ?? null,
      manifest.git.provider,
      manifest.git.branch,
      manifest.git.baseSha,
      manifest.git.headSha,
      manifest.home.root,
      [...manifest.home.include].sort(),
      [...manifest.home.exclude].sort(),
      part,
    ]),
  )
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function encryptPart(bytes: Uint8Array, key: Uint8Array, aad: Uint8Array) {
  if (key.byteLength !== 32) throw badRequest('Snapshot requires a 256-bit data key')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(bytes), cipher.final()])
  return { body, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') }
}

/** No plaintext is returned until final() has authenticated the entire part. */
export function decryptPart(
  body: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
  iv: string,
  tag: string,
): Uint8Array {
  let plaintext: Buffer | undefined
  try {
    if (key.byteLength !== 32) throw new Error('Invalid key size')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'), {
      authTagLength: 16,
    })
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(tag, 'hex'))
    plaintext = decipher.update(body)
    const final = decipher.final()
    return Buffer.concat([plaintext, final])
  } catch {
    throw badRequest('Snapshot authentication failed')
  } finally {
    plaintext?.fill(0)
  }
}
