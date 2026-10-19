import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { badRequest, DEPLOY_ENVELOPE_MAGIC } from '@repo/domain'

// The envelope of what a release seals with the data key of its wrapping (deploy-manifest.ts of
// @repo/domain, `DEPLOY_ENVELOPE_MAGIC`): the backup the job uploads (`deployBackupAad`) and the
// values of the database operations core puts into the manifest (`deployValueAad`; core seals
// them with this same function, R8b). AES-256-GCM:
//
//   offset 0   4 bytes   "RDE1"
//   offset 4   12 bytes  IV (random per envelope)
//   offset 16  16 bytes  GCM tag
//   offset 32  …         ciphertext
//
// The associated data is never stored: each side names it from what it already holds.

const MAGIC = Buffer.from(DEPLOY_ENVELOPE_MAGIC, 'latin1')
const IV_BYTES = 12
const TAG_BYTES = 16

/** The 32-byte key of a wrapping (`deployWrapDataSchema.backupKey`, base64). */
export function deployKeyOf(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64')
  if (key.byteLength !== 32 || key.toString('base64') !== base64)
    throw badRequest('A deploy data key is 32 bytes of base64')
  return key
}

/** IV ‖ tag ‖ ciphertext under a fresh IV. */
function seal(plaintext: Uint8Array, key: Uint8Array, aad: string): Buffer {
  if (key.byteLength !== 32) throw badRequest('A deploy envelope needs a 256-bit key')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/**
 * IV ‖ tag ‖ ciphertext. No plaintext leaves until the tag authenticated all of it: another key,
 * other associated data or a changed byte fail alike, with fixed text.
 */
function open(bytes: Buffer, key: Uint8Array, aad: string): Buffer {
  let plaintext: Buffer | undefined
  try {
    if (key.byteLength !== 32 || bytes.byteLength < IV_BYTES + TAG_BYTES) throw new Error('size')
    const iv = bytes.subarray(0, IV_BYTES)
    const tag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    plaintext = decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES))
    return Buffer.concat([plaintext, decipher.final()])
  } catch {
    throw badRequest('Deploy envelope authentication failed')
  } finally {
    plaintext?.fill(0)
  }
}

const view = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** The envelope of a backup: `RDE1` ‖ IV ‖ tag ‖ ciphertext. */
export function sealDeployEnvelope(plaintext: Uint8Array, key: Uint8Array, aad: string): Buffer {
  return Buffer.concat([MAGIC, seal(plaintext, key, aad)])
}

export function openDeployEnvelope(sealed: Uint8Array, key: Uint8Array, aad: string): Buffer {
  const bytes = view(sealed)
  if (bytes.byteLength < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
    throw badRequest('Deploy envelope authentication failed')
  return open(bytes.subarray(MAGIC.length), key, aad)
}
