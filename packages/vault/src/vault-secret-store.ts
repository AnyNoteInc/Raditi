import { notImplemented, type SecretStore, type SecretStoreHealth } from '@repo/domain'
import { z } from 'zod'

import type { VaultConfig } from './config.ts'
import { VaultError } from './errors.ts'
import { createTransitStore } from './transit.ts'

export interface VaultSecretStoreOptions extends VaultConfig {
  fetch?: typeof fetch
  /** Per request; health checks must answer fast. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 3_000

// standbyok/perfstandbyok turn 429/473 into 200 for load balancers; the body still says standby.
const HEALTH_PATH = '/v1/sys/health?standbyok=true&perfstandbyok=true'

/** Status codes of GET /sys/health (Vault and OpenBao). */
const HEALTH_STATUSES = new Set([
  200, // initialized, unsealed, active
  429, // unsealed standby
  472, // disaster recovery secondary
  473, // performance standby
  501, // not initialized
  503, // sealed
])
const STANDBY_STATUSES = new Set([429, 472, 473])

const healthBodySchema = z.object({
  initialized: z.boolean(),
  sealed: z.boolean(),
  standby: z.boolean(),
  performance_standby: z.boolean().optional(),
  version: z.string().default(''),
})

/**
 * SecretStore port over the Vault HTTP API (OpenBao or Deckhouse Stronghold, spec §15).
 * Health and Transit data keys are implemented. KV, SSH CA, deploy tokens and wrapping are P7.
 * The config is kept in this closure and never logged.
 */
export function createVaultSecretStore(options: VaultSecretStoreOptions): SecretStore {
  const addr = options.addr.replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const pending = (method: string) => async (): Promise<never> => {
    throw notImplemented(`${method} (P7)`)
  }

  return {
    async health(): Promise<SecretStoreHealth> {
      let res: Response
      try {
        // Unauthenticated endpoint: no token header on purpose.
        res = await fetchImpl(`${addr}${HEALTH_PATH}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        })
      } catch (err) {
        const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed'
        throw new VaultError(`Vault health request ${reason}`)
      }

      if (!HEALTH_STATUSES.has(res.status)) {
        throw new VaultError(`Unexpected Vault health status ${res.status}`, res.status)
      }

      let json: unknown
      try {
        json = await res.json()
      } catch {
        throw new VaultError('Vault health response is not JSON', res.status)
      }
      const parsed = healthBodySchema.safeParse(json)
      if (!parsed.success) {
        throw new VaultError('Unexpected Vault health response body', res.status)
      }
      const body = parsed.data

      return {
        initialized: res.status !== 501 && body.initialized,
        // A node that is not initialized cannot serve secrets either.
        sealed: res.status === 503 || res.status === 501 || body.sealed,
        standby:
          STANDBY_STATUSES.has(res.status) || body.standby || body.performance_standby === true,
        version: body.version,
      }
    },

    kvRead: pending('kvRead'),
    kvWrite: pending('kvWrite'),
    kvDelete: pending('kvDelete'),
    ...createTransitStore(options),
    sshSign: pending('sshSign'),
    createToken: pending('createToken'),
    wrap: pending('wrap'),
    revokeAccessor: pending('revokeAccessor'),
  }
}
