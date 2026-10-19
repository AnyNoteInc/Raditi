import { createHash } from 'node:crypto'

import ssh2 from 'ssh2'

import { hostKeySchema } from '@repo/domain'

/**
 * "<key type> SHA256:<base64 of the SHA-256 of the key blob, no padding>", the form `ssh-keygen -l`
 * prints and hostKeySchema accepts; null for a blob ssh2 cannot read or a type the schema refuses.
 * The type is the key's (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`), never a signature
 * algorithm: an RSA host key that signs with rsa-sha2-512 is still `ssh-rsa`.
 */
export function sshKeyFingerprint(blob: Buffer): string | null {
  const parsed: unknown = ssh2.utils.parseKey(blob)
  const key = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed
  if (key instanceof Error || typeof key !== 'object' || key === null) return null
  const { type } = key as { type?: unknown }
  if (typeof type !== 'string') return null
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  const fingerprint = `${type} SHA256:${digest}`
  return hostKeySchema.safeParse(fingerprint).success ? fingerprint : null
}
