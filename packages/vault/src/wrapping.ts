import type { SecretStore, WrappingInfo } from '@repo/domain'
import { z } from 'zod'

import { VaultError } from './errors.ts'
import { stringsSchema } from './kv.ts'
import type { VaultSession } from './session.ts'

type WrappingStore = Pick<SecretStore, 'wrap' | 'unwrap' | 'lookupWrapping' | 'revokeAccessor'>

/**
 * Vault takes any lifetime for a wrapping (OpenBao 2.7.0 answered a wrap of 999 999 999 s);
 * the release flow asks for 30 minutes (plan 53, Р29), and an hour is the most this adapter
 * allows.
 */
export const wrappingLimits = Object.freeze({ minTtlSeconds: 1, maxTtlSeconds: 3600 })
/** OpenBao answers `s.<24>`, Vault `hvs.<…>`; the same alphabet as DeployWrap.wrapToken. */
const wrappingToken = z.string().regex(/^[A-Za-z0-9._-]{8,512}$/)
const accessorSchema = z.string().regex(/^[A-Za-z0-9._-]{8,256}$/)
const isoDate = z.iso.datetime({ offset: true }).refine((date) => Number.isFinite(Date.parse(date)))
const WRAP_PATH = 'sys/wrapping/wrap'
const wrapResponseSchema = z.object({
  wrap_info: z.object({
    token: wrappingToken,
    accessor: accessorSchema,
    ttl: z.number().int().positive(),
    creation_path: z.literal(WRAP_PATH),
  }),
})
const unwrapResponseSchema = z.object({ data: stringsSchema })
const lookupResponseSchema = z.object({
  data: z.object({
    creation_path: z.string().min(1).max(512),
    creation_time: isoDate,
    creation_ttl: z.number().int().nonnegative(),
  }),
})

/** Vault's answer to a token that is spent, revoked, expired or never was one. */
const isInvalidWrapping = (error: unknown) => error instanceof VaultError && error.status === 400

/**
 * Response wrapping over the shared session (spec §15; plan 53, Р29): `core` wraps the
 * credentials of one release attempt, the deploy job unwraps them once, and `core` sees whether
 * that happened (lookup) or ends it early (revocation by accessor). Policy `core-release` grants
 * `sys/wrapping/wrap`, `sys/wrapping/lookup` and `auth/token/revoke-accessor`; an unwrap needs no
 * policy, the wrapping token is its own credential.
 * https://openbao.org/api-docs/system/wrapping-wrap/
 * https://openbao.org/api-docs/auth/token/#revoke-a-token-accessor
 */
export function createWrappingStore(session: VaultSession): WrappingStore {
  function token(value: string): string {
    if (!wrappingToken.safeParse(value).success)
      throw new VaultError('Invalid Vault wrapping token')
    return value
  }

  return {
    async wrap(data, ttlSeconds) {
      if (
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < wrappingLimits.minTtlSeconds ||
        ttlSeconds > wrappingLimits.maxTtlSeconds
      )
        throw new VaultError('Invalid Vault wrapping lifetime')
      const parsed = stringsSchema.safeParse(data)
      // An empty wrapping unwraps to nothing: no caller means to hand that out.
      if (!parsed.success || Object.keys(parsed.data).length === 0)
        throw new VaultError('Invalid Vault wrapping data')
      const startedAt = Date.now()
      const { json } = await session.request(`/v1/${WRAP_PATH}`, {
        method: 'POST',
        body: { ...parsed.data },
        wrapTtlSeconds: ttlSeconds,
      })
      const reply = wrapResponseSchema.safeParse(json)
      if (!reply.success || reply.data.wrap_info.ttl !== ttlSeconds)
        throw new VaultError('Unexpected Vault wrapping response')
      const { token: wrapped, accessor } = reply.data.wrap_info
      return { token: wrapped, accessor, expiresAt: new Date(startedAt + ttlSeconds * 1000) }
    },

    async unwrap(value) {
      let json: unknown
      try {
        ;({ json } = await session.request('/v1/sys/wrapping/unwrap', {
          method: 'POST',
          token: token(value),
          responseLimit: 'kv',
        }))
      } catch (error) {
        if (isInvalidWrapping(error)) return null
        throw error
      }
      const reply = unwrapResponseSchema.safeParse(json)
      if (!reply.success) throw new VaultError('Unexpected Vault unwrap response')
      return { ...reply.data.data }
    },

    async lookupWrapping(value): Promise<WrappingInfo | null> {
      let json: unknown
      try {
        ;({ json } = await session.request('/v1/sys/wrapping/lookup', {
          method: 'POST',
          body: { token: token(value) },
        }))
      } catch (error) {
        if (isInvalidWrapping(error)) return null
        throw error
      }
      const reply = lookupResponseSchema.safeParse(json)
      if (!reply.success) throw new VaultError('Unexpected Vault wrapping lookup response')
      const { creation_path: creationPath, creation_time, creation_ttl } = reply.data.data
      const createdAt = Date.parse(creation_time)
      return {
        creationPath,
        createdAt: new Date(createdAt),
        expiresAt: new Date(createdAt + creation_ttl * 1000),
      }
    },

    async revokeAccessor(accessor) {
      if (!accessorSchema.safeParse(accessor).success)
        throw new VaultError('Invalid Vault token accessor')
      // A token already gone (unwrapped, expired, revoked) is answered 200 with the warning
      // "No token found with this accessor": the same end state as a revocation (204).
      await session.request('/v1/auth/token/revoke-accessor', {
        method: 'POST',
        body: { accessor },
      })
    },
  }
}
