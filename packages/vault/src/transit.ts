import { Buffer } from 'node:buffer'

import type { SecretStore } from '@repo/domain'
import { z } from 'zod'

import { VaultError } from './errors.ts'
import { createVaultSession, type VaultSession, type VaultSessionOptions } from './session.ts'

type TransitStore = Pick<SecretStore, 'transitDataKey' | 'transitDecryptDataKey'>
const workspaceKey = /^ws-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const wrappedKeySchema = z
  .string()
  .max(4096)
  .regex(/^vault:v[1-9]\d*:[A-Za-z0-9+/]+={0,2}$/)
const keyResponseSchema = z.object({
  data: z.object({ plaintext: z.string().max(128), ciphertext: wrappedKeySchema }),
})
const decryptResponseSchema = z.object({ data: z.object({ plaintext: z.string().max(128) }) })

/** The one Transit mount of the platform (spec §15). */
export const TRANSIT_MOUNT = 'transit'

/**
 * Transit data-key API and AppRole login only. The mount and the policies come from the explicit
 * bootstrap (infra/vault), a workspace key from a trusted provisioning step; a missing key fails
 * rather than provisioning with runtime privileges.
 * `onUse` is called before every request that passed validation.
 * https://openbao.org/docs/api/secret/transit/#generate-data-key
 * https://openbao.org/docs/auth/approle/#via-the-api
 */
export function createTransitStore(
  options: VaultSessionOptions,
  session: VaultSession = createVaultSession(options),
  onUse?: () => void,
): TransitStore {
  async function post(path: string, body: object): Promise<unknown> {
    onUse?.()
    return (await session.request(`/v1/${TRANSIT_MOUNT}/${path}`, { method: 'POST', body })).json
  }

  return {
    async transitDataKey(key) {
      const name = keyPath(key)
      const parsed = keyResponseSchema.safeParse(
        await post(`datakey/plaintext/${name}`, { bits: 256 }),
      )
      if (!parsed.success) throw new VaultError('Unexpected Vault data-key response')
      return {
        plaintext: decodeDataKey(parsed.data.data.plaintext),
        ciphertext: parsed.data.data.ciphertext,
      }
    },
    async transitDecryptDataKey(key, ciphertext) {
      const name = keyPath(key)
      if (!wrappedKeySchema.safeParse(ciphertext).success) {
        throw new VaultError('Invalid wrapped Vault data key')
      }
      const parsed = decryptResponseSchema.safeParse(await post(`decrypt/${name}`, { ciphertext }))
      if (!parsed.success) throw new VaultError('Unexpected Vault decrypt response')
      return decodeDataKey(parsed.data.data.plaintext)
    },
  }
}

function keyPath(key: string): string {
  if (!workspaceKey.test(key)) throw new VaultError('Invalid Vault workspace key name')
  return encodeURIComponent(key)
}

/** Buffer's base64 decoder is permissive; require canonical base64 and exactly AES-256 bytes. */
function decodeDataKey(encoded: string): Uint8Array {
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 32 || bytes.toString('base64') !== encoded) {
    bytes.fill(0)
    throw new VaultError('Vault data key must contain exactly 32 bytes in canonical base64')
  }
  return bytes
}
