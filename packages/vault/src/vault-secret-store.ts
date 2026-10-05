import { notImplemented, type SecretStore, type SecretStoreHealth } from '@repo/domain'
import { z } from 'zod'

import type { VaultConfig } from './config.ts'
import { VaultError } from './errors.ts'
import { createKvStore } from './kv.ts'
import { createVaultSession, vaultBaseAddress } from './session.ts'
import { createTransitStore, TRANSIT_MOUNT } from './transit.ts'

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

/** Paths come from code and stored references; a stray one must not grow this without bound. */
const MAX_TRACKED_MOUNTS = 16

/**
 * SecretStore port over the Vault HTTP API (OpenBao or Deckhouse Stronghold, spec §15).
 * Health, Transit and KV v2 are implemented. SSH CA, deploy tokens and wrapping are P7.
 * The config is kept in this closure and never logged.
 */
export function createVaultSecretStore(options: VaultSecretStoreOptions): SecretStore {
  const addr = vaultBaseAddress(options.addr)
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const session = createVaultSession(options)
  // KV mounts this process has addressed. A read or LIST on a missing mount looks like
  // "no such key", so only health() can show that a mount or its policy is gone.
  const kvMounts = new Set<string>()
  // Transit fails loudly on every call, but only for the caller: once the process has asked
  // for a key, health() shows a missing mount or a lost policy to the operator as well.
  let transitUsed = false

  /** The lookup the KV CLI uses: 200 only when the mount exists and the token can use it. */
  async function requireMount(mount: string, engine: 'KV' | 'Transit'): Promise<void> {
    try {
      await session.request(`/v1/sys/internal/ui/mounts/${mount}`, {
        method: 'GET',
        forbiddenExpected: true,
      })
    } catch (error) {
      const status = error instanceof VaultError ? error.status : undefined
      throw new VaultError(`Vault ${engine} mount ${mount}/ is not available`, status)
    }
  }

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

      const health = {
        initialized: res.status !== 501 && body.initialized,
        // A node that is not initialized cannot serve secrets either.
        sealed: res.status === 503 || res.status === 501 || body.sealed,
        standby:
          STANDBY_STATUSES.has(res.status) || body.standby || body.performance_standby === true,
        version: body.version,
      }
      if (health.initialized && !health.sealed) {
        await Promise.all([
          ...[...kvMounts].map((mount) => requireMount(mount, 'KV')),
          ...(transitUsed ? [requireMount(TRANSIT_MOUNT, 'Transit')] : []),
        ])
      }
      return health
    },

    ...createKvStore(session, (mount) => {
      if (kvMounts.size < MAX_TRACKED_MOUNTS) kvMounts.add(mount)
    }),
    ...createTransitStore(options, session, () => {
      transitUsed = true
    }),
    sshSign: pending('sshSign'),
    createToken: pending('createToken'),
    wrap: pending('wrap'),
    revokeAccessor: pending('revokeAccessor'),
  }
}
