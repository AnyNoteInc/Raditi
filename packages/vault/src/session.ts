import { Buffer } from 'node:buffer'

import { z } from 'zod'

import type { VaultConfig } from './config.ts'
import { VaultError } from './errors.ts'
import { vaultHttpLimits } from './limits.ts'

export type VaultSessionOptions = VaultConfig & { fetch?: typeof fetch; timeoutMs?: number }
export interface VaultRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'LIST'
  body?: object
  authenticated?: boolean
  /** Only an explicitly expected missing resource may bypass HTTP error handling. */
  allowMissing?: boolean
  /** Trusted adapter-selected budget; login and ordinary responses keep the small default. */
  responseLimit?: 'kv' | 'list'
  /**
   * HTTP 403 is an answer the caller expects from the policy or the mount, not a sign of a
   * dead token: the cached AppRole lease stays. The caller's next ordinary request still
   * drops a token that was really revoked.
   */
  forbiddenExpected?: boolean
  /**
   * Sent with this token instead of the session's own, without a login: the wrapping token of
   * an unwrap, which is its own credential. A refusal of it never drops the session's token.
   */
  token?: string
  /** Asks Vault to wrap the response for this long (X-Vault-Wrap-TTL); sys/wrapping/wrap needs it. */
  wrapTtlSeconds?: number
}
export interface VaultReply {
  status: number
  json: unknown
}
export interface VaultSession {
  request(path: string, request: VaultRequest): Promise<VaultReply>
}

const tokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/)
const loginResponseSchema = z.object({
  auth: z.object({
    client_token: tokenSchema,
    lease_duration: z.number().int().nonnegative().max(2_147_483_647),
  }),
})

/** Shared by KV and Transit. No write is replayed after an ambiguous network failure. */
export function createVaultSession(options: VaultSessionOptions): VaultSession {
  const addr = vaultBaseAddress(options.addr)
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
    throw new VaultError('Invalid Vault request timeout')
  let cached: { token: string; expiresAt: number } | undefined
  let login: Promise<string> | undefined

  async function send(
    path: string,
    request: VaultRequest,
    token?: string,
    maxResponseBytes = vaultHttpLimits.responseBytes,
  ): Promise<VaultReply> {
    let body: string | undefined
    if (request.body !== undefined) {
      try {
        body = JSON.stringify(request.body)
      } catch {
        throw new VaultError('Invalid Vault request body')
      }
      if (Buffer.byteLength(body, 'utf8') > vaultHttpLimits.requestBytes)
        throw new VaultError('Vault request exceeds the size limit')
    }
    let response: Response
    try {
      response = await fetchImpl(`${addr}${path}`, {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { 'x-vault-token': token } : {}),
          ...(request.wrapTtlSeconds !== undefined
            ? { 'x-vault-wrap-ttl': String(request.wrapTtlSeconds) }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch (error) {
      // Network/parser errors can contain request headers, secret values or an unsafe URL.
      const reason =
        error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed'
      throw new VaultError(`Vault request ${reason}`)
    }
    if (!response.ok) {
      if (response.status === 403 && cached?.token === token && !request.forbiddenExpected)
        cached = undefined
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 404 && request.allowMissing)
        return { status: response.status, json: null }
      throw new VaultError(`Vault request returned HTTP ${response.status}`, response.status)
    }
    return {
      status: response.status,
      json: response.status === 204 ? null : await readJson(response, maxResponseBytes),
    }
  }

  async function authenticate(): Promise<string> {
    if (!options.appRole) {
      if (!tokenSchema.safeParse(options.token).success)
        throw new VaultError('Vault authentication is not configured')
      return options.token!
    }
    if (cached && Date.now() < cached.expiresAt) return cached.token
    if (!login) {
      login = (async () => {
        const startedAt = Date.now()
        const { json } = await send('/v1/auth/approle/login', {
          method: 'POST',
          body: { role_id: options.appRole!.roleId, secret_id: options.appRole!.secretId },
        })
        const parsed = loginResponseSchema.safeParse(json)
        if (!parsed.success) throw new VaultError('Unexpected Vault AppRole response')
        const { client_token: token, lease_duration: lease } = parsed.data.auth
        const ttlMs = lease * 1000
        const expiresAt = startedAt + ttlMs - Math.min(5000, ttlMs / 10)
        if (ttlMs > 0 && expiresAt <= Date.now())
          throw new VaultError('Vault AppRole token expired during login')
        cached = ttlMs > 0 ? { token, expiresAt } : undefined
        return token
      })().finally(() => {
        login = undefined
      })
    }
    return login
  }

  return {
    async request(path, request) {
      const maxResponseBytes = responseLimitBytes(request.responseLimit)
      if (request.token !== undefined && !tokenSchema.safeParse(request.token).success)
        throw new VaultError('Invalid Vault request token')
      if (
        request.wrapTtlSeconds !== undefined &&
        (!Number.isSafeInteger(request.wrapTtlSeconds) || request.wrapTtlSeconds <= 0)
      )
        throw new VaultError('Invalid Vault wrapping lifetime')
      return send(
        path,
        request,
        request.token ?? (request.authenticated === false ? undefined : await authenticate()),
        maxResponseBytes,
      )
    },
  }
}

export function vaultBaseAddress(value: string): string {
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

function responseLimitBytes(limit: VaultRequest['responseLimit']): number {
  switch (limit) {
    case undefined:
      return vaultHttpLimits.responseBytes
    case 'kv':
      return vaultHttpLimits.kvResponseBytes
    case 'list':
      return vaultHttpLimits.listResponseBytes
    default:
      throw new VaultError('Invalid Vault response limit')
  }
}

/** Bound even a successful response. Decode UTF-8 strictly and never preserve parser causes. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new VaultError('Unexpected empty Vault response', response.status)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new VaultError('Vault response exceeds the size limit')
      chunks.push(value)
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    )
    return JSON.parse(text) as unknown
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof VaultError) throw error
    throw new VaultError('Unexpected Vault response body', response.status)
  } finally {
    reader.releaseLock()
  }
}
