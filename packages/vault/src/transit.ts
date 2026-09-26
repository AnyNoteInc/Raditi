import { Buffer } from 'node:buffer'

import type { SecretStore } from '@repo/domain'
import { z } from 'zod'

import type { VaultConfig } from './config.ts'
import { VaultError } from './errors.ts'

type TransitOptions = VaultConfig & { fetch?: typeof fetch; timeoutMs?: number }
type TransitStore = Pick<SecretStore, 'transitDataKey' | 'transitDecryptDataKey'>
const MAX_RESPONSE_BYTES = 64 * 1024
const workspaceKey = /^ws-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const wrappedKeySchema = z
  .string()
  .max(4096)
  .regex(/^vault:v[1-9]\d*:[A-Za-z0-9+/]+={0,2}$/)
const keyResponseSchema = z.object({
  data: z.object({ plaintext: z.string().max(128), ciphertext: wrappedKeySchema }),
})
const decryptResponseSchema = z.object({ data: z.object({ plaintext: z.string().max(128) }) })
const loginResponseSchema = z.object({
  auth: z.object({
    client_token: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/),
    lease_duration: z.number().int().nonnegative().max(2_147_483_647),
  }),
})

/**
 * Transit data-key API and AppRole login only. Mounts, workspace keys, policies and role
 * provisioning remain P7; a missing key fails rather than provisioning with runtime privileges.
 * https://openbao.org/docs/api/secret/transit/#generate-data-key
 * https://openbao.org/docs/auth/approle/#via-the-api
 */
export function createTransitStore(options: TransitOptions): TransitStore {
  const addr = baseAddress(options.addr)
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  let cached: { token: string; expiresAt: number } | undefined
  let login: Promise<string> | undefined

  async function post(path: string, body: object, token?: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetchImpl(`${addr}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(token ? { 'x-vault-token': token } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        // A redirect must never forward the AppRole secret or token to a different endpoint.
        redirect: 'error',
      })
    } catch (error) {
      // Even Error.cause can contain a request URL, headers or response with secret values.
      const reason =
        error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed'
      throw new VaultError(`Vault request ${reason}`)
    }
    if (!response.ok) {
      if (response.status === 403 && cached?.token === token) cached = undefined
      await response.body?.cancel().catch(() => undefined)
      throw new VaultError(`Vault request returned HTTP ${response.status}`, response.status)
    }
    return readJson(response)
  }

  async function authenticate(): Promise<string> {
    // Prefer a configured service role over the local-development root token.
    if (!options.appRole) {
      if (!options.token) throw new VaultError('Vault authentication is not configured')
      return options.token
    }
    if (cached && Date.now() < cached.expiresAt) return cached.token
    if (!login) {
      login = (async () => {
        const startedAt = Date.now()
        const data = await post('/v1/auth/approle/login', {
          role_id: options.appRole!.roleId,
          secret_id: options.appRole!.secretId,
        })
        const parsed = loginResponseSchema.safeParse(data)
        if (!parsed.success) throw new VaultError('Unexpected Vault AppRole response')
        const { client_token: token, lease_duration: lease } = parsed.data.auth
        const ttlMs = lease * 1000
        // Begin the lease before the HTTP call and refresh a little early. A zero TTL is not
        // assumed to mean an everlasting token: use it for this call, without caching it.
        const expiresAt = startedAt + ttlMs - Math.min(5000, ttlMs / 10)
        if (ttlMs > 0 && expiresAt <= Date.now()) {
          throw new VaultError('Vault AppRole token expired during login')
        }
        cached = ttlMs > 0 ? { token, expiresAt } : undefined
        return token
      })().finally(() => {
        login = undefined
      })
    }
    return login
  }

  return {
    async transitDataKey(key) {
      const name = keyPath(key)
      const parsed = keyResponseSchema.safeParse(
        await post(`/v1/transit/datakey/plaintext/${name}`, { bits: 256 }, await authenticate()),
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
      const parsed = decryptResponseSchema.safeParse(
        await post(`/v1/transit/decrypt/${name}`, { ciphertext }, await authenticate()),
      )
      if (!parsed.success) throw new VaultError('Unexpected Vault decrypt response')
      return decodeDataKey(parsed.data.data.plaintext)
    },
  }
}

function baseAddress(value: string): string {
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('invalid')
    return url.href.replace(/\/+$/, '')
  } catch {
    throw new VaultError('Invalid Vault address')
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

/** Bound even a successful response, and never expose its JSON or parsing error as a cause. */
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new VaultError('Unexpected empty Vault response', response.status)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new VaultError('Vault response exceeds the size limit')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof VaultError) throw error
    throw new VaultError('Unexpected Vault response body', response.status)
  } finally {
    reader.releaseLock()
  }
}
