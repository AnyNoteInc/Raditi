import { Buffer } from 'node:buffer'

import type { SecretStore } from '@repo/domain'
import { z } from 'zod'

import { VaultError } from './errors.ts'
import { createVaultSession, type VaultSession, type VaultSessionOptions } from './session.ts'

type TransitStore = Pick<
  SecretStore,
  'transitDataKey' | 'transitDecryptDataKey' | 'transitEnsureKey'
>
const workspaceKey = /^ws-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
// A key is created only for a workspace id as the database writes it (a lowercase UUID): any
// other spelling would make a second key that no snapshot ever names.
const newWorkspaceKey = /^ws-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The one type of a workspace key, and the one parameter `workspace-provisioner` allows. */
const WORKSPACE_KEY_TYPE = 'aes256-gcm96'
const wrappedKeySchema = z
  .string()
  .max(4096)
  .regex(/^vault:v[1-9]\d*:[A-Za-z0-9+/]+={0,2}$/)
const keyResponseSchema = z.object({
  data: z.object({ plaintext: z.string().max(128), ciphertext: wrappedKeySchema }),
})
const decryptResponseSchema = z.object({ data: z.object({ plaintext: z.string().max(128) }) })
// 200 with the key as it stands (OpenBao, Vault); 204 with nothing (older Vault).
const ensureResponseSchema = z.union([
  z.null(),
  z.object({ data: z.object({ type: z.string().max(64) }) }),
])

/** The one Transit mount of the platform (spec §15). */
export const TRANSIT_MOUNT = 'transit'

/**
 * Transit data-key API and AppRole login only. The mount and the policies come from the explicit
 * bootstrap (infra/vault), a workspace key from `transitEnsureKey` under the policy
 * `workspace-provisioner` (web, before a task is created); a data key of a missing workspace key
 * fails rather than provisioning with the privileges of core or mcp.
 * `onUse` is called before every request that passed validation.
 * https://openbao.org/docs/api/secret/transit/#create-key
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
    async transitEnsureKey(key) {
      if (!newWorkspaceKey.test(key)) throw new VaultError('Invalid Vault workspace key name')
      // Transit creates the key, or answers with the one that exists, untouched: a repeat after
      // an ambiguous failure is safe. Only `type` is sent, the one parameter the policy allows.
      const parsed = ensureResponseSchema.safeParse(
        await post(`keys/${keyPath(key)}`, { type: WORKSPACE_KEY_TYPE }),
      )
      if (!parsed.success) throw new VaultError('Unexpected Vault key response')
      // A key of another type under this name keeps it: no snapshot could be written with it.
      if (parsed.data !== null && parsed.data.data.type !== WORKSPACE_KEY_TYPE)
        throw new VaultError('Vault workspace key has an unexpected type')
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
