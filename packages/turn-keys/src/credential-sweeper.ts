import type { Prisma, PrismaClient } from '@repo/db'
import {
  withTimeout,
  type SecretStore,
  type TurnCredentialRef,
  type TurnCredentialSource,
} from '@repo/domain'

import { PostgresGatewayStore } from './gateway-store.ts'
import { lockSubscriptionPool, parseTurnCredentialPath } from './turn-key.ts'

type Database = Pick<PrismaClient, '$transaction' | '$queryRaw'>
type Transaction = Prisma.TransactionClient
type SweepKey = {
  id: string
  taskId: string
  sessionId: string
  turnNo: number
  firstEpoch: number
  revokeRequestedAt?: Date | null
  expired?: boolean
}

export type CredentialSweepKind =
  'requested' | 'expired' | 'finished' | 'vault' | 'usage_closed' | 'retirement' | 'lost'

export interface CredentialSweeperOptions {
  prisma: Database
  secrets: SecretStore
  credentials: Pick<TurnCredentialSource, 'revoke'>
  logger?: { warn(message: string): void }
  /** The real implementation reuses gateway accounting, with core's longer crash allowance. */
  backup?: { collectLost(): Promise<number> }
  onSwept?: (kind: CredentialSweepKind) => void
}

const refFromKey = (key: SweepKey): TurnCredentialRef => ({
  taskId: key.taskId,
  sessionId: key.sessionId,
  turn: key.turnNo,
  epoch: key.firstEpoch,
})

/** Core owns turn-key cleanup and disabling drained accounts; it never reads subs/ secrets. */
export class CredentialSweeper {
  readonly #options: CredentialSweeperOptions
  readonly #backup: { collectLost(): Promise<number> }
  readonly #shutdown = new AbortController()
  #pending: Promise<void> | null = null
  #runs = 0
  #cursor: string | undefined

  constructor(options: CredentialSweeperOptions) {
    this.#options = options
    this.#backup =
      options.backup ??
      new PostgresGatewayStore(options.prisma, {
        lostAfterMs: 30 * 60_000,
        ...(options.logger ? { logger: options.logger } : {}),
      })
  }

  tick(): Promise<void> {
    if (this.#shutdown.signal.aborted) return Promise.resolve()
    if (this.#pending) return this.#pending
    const pending = this.#sweep().finally(() => {
      if (this.#pending === pending) this.#pending = null
    })
    this.#pending = pending
    return pending
  }

  async close(): Promise<void> {
    this.#shutdown.abort(new Error('Turn credential cleanup stopped'))
    if (this.#pending) {
      try {
        await withTimeout(this.#pending, 1_000, 'Turn credential cleanup stop timeout')
      } catch {
        /* SQL and Vault remain bounded independently; unfinished cleanup retries after restart. */
      }
    }
  }

  async #sweep(): Promise<void> {
    this.#runs += 1
    await this.#stage('backup', async () => {
      const closed = await this.#backup.collectLost()
      for (let index = 0; index < closed; index += 1) this.#options.onSwept?.('lost')
    })
    await this.#stage('keys', () => this.#revokeKeys())
    await this.#stage('accounting', () => this.#closeAccounting())
    if (this.#runs % 5 === 0) await this.#stage('vault', () => this.#scanVault())
    await this.#stage('retirement', () => this.#retireDrained())
  }

  async #stage(kind: string, operation: () => Promise<unknown>): Promise<void> {
    if (this.#shutdown.signal.aborted) return
    try {
      await operation()
    } catch {
      if (!this.#shutdown.signal.aborted)
        this.#options.logger?.warn(`llm_credentials_sweep_failed kind=${kind}`)
    }
  }

  async #wait<T>(operation: Promise<T>): Promise<T> {
    const signal = this.#shutdown.signal
    signal.throwIfAborted()
    let onAbort: (() => void) | undefined
    try {
      return await withTimeout(
        Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason)
            signal.addEventListener('abort', onAbort, { once: true })
          }),
        ]),
        10_000,
        'Turn credential cleanup operation timeout',
      )
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  #transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#options.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '1000ms', true),
        set_config('statement_timeout', '5000ms', true)`
        return operation(tx)
      },
      { maxWait: 1_000, timeout: 8_000 },
    )
  }

  async #revokeKeys(): Promise<void> {
    const keys = await this.#wait(
      this.#transaction(
        (tx) => tx.$queryRaw<SweepKey[]>`
      SELECT k.id, k.task_id AS "taskId", k.session_id AS "sessionId", k.turn_no AS "turnNo",
        k.first_epoch AS "firstEpoch", k.revoke_requested_at AS "revokeRequestedAt",
        k.valid_until <= clock_timestamp() AS "expired"
      FROM llm_keys k WHERE k.revoked_at IS NULL
        AND (k.revoke_requested_at IS NOT NULL OR k.valid_until <= clock_timestamp()
          -- The owner's revoke may have failed before its durable marker: a finished turn
          -- leaves nobody else to close the key before valid_until.
          OR EXISTS (SELECT 1 FROM turn_assignments a WHERE a.task_id = k.task_id
            AND a.turn_no = k.turn_no AND a.first_epoch = k.first_epoch
            AND a.session_id = k.session_id AND a.finished_at IS NOT NULL))
      ORDER BY k.valid_until, k.id LIMIT 1000`,
      ),
    )
    for (const key of keys) {
      if (this.#shutdown.signal.aborted) return
      try {
        await this.#wait(this.#options.credentials.revoke(refFromKey(key)))
        this.#options.onSwept?.(
          key.revokeRequestedAt ? 'requested' : key.expired ? 'expired' : 'finished',
        )
      } catch {
        if (!this.#shutdown.signal.aborted)
          this.#options.logger?.warn('llm_credentials_sweep_failed kind=revoke')
      }
    }
  }

  async #closeAccounting(): Promise<void> {
    const keys = await this.#wait(
      this.#transaction(
        (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM llm_keys WHERE revoked_at IS NOT NULL AND usage_closed_at IS NULL
      ORDER BY revoked_at, id LIMIT 1000`,
      ),
    )
    for (const key of keys) {
      if (this.#shutdown.signal.aborted) return
      const closed = await this.#wait(
        this.#transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${key.id}::uuid FOR UPDATE`
          // An admission begun before revocation may have committed while this row was locked.
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`UPDATE llm_keys k SET usage_closed_at = clock_timestamp()
          WHERE k.id = ${key.id}::uuid AND k.revoked_at IS NOT NULL AND k.usage_closed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open') RETURNING k.id`
          return rows.length > 0
        }),
      )
      if (closed) this.#options.onSwept?.('usage_closed')
    }
  }

  async #scanVault(): Promise<void> {
    const page = await this.#wait(
      this.#options.secrets.kvList('turns/', {
        ...(this.#cursor === undefined ? {} : { after: this.#cursor }),
        limit: 100,
      }),
    )
    let failed = false
    for (const name of page) {
      if (this.#shutdown.signal.aborted) return
      const identity = name.includes('/') ? null : parseTurnCredentialPath(name)
      if (!identity) continue
      try {
        const path = `turns/${name}`
        const metadata = await this.#wait(this.#options.secrets.kvMetadata(path))
        if (!metadata) continue
        const [clock] = await this.#wait(
          this.#transaction(
            (tx) => tx.$queryRaw<{ now: Date }[]>`
          SELECT clock_timestamp() AS now`,
          ),
        )
        const customUntil = Date.parse(metadata.custom.validUntil ?? '')
        const until = Number.isFinite(customUntil)
          ? customUntil
          : metadata.createdTime.getTime() + 25 * 60_000
        if (!Number.isFinite(until) || until > clock!.now.getTime()) continue
        const key = await this.#wait(
          this.#transaction((tx) =>
            tx.llmKey.findUnique({
              where: {
                taskId_turnNo_firstEpoch: {
                  taskId: identity.taskId,
                  turnNo: identity.turn,
                  firstEpoch: identity.epoch,
                },
              },
              select: {
                id: true,
                taskId: true,
                sessionId: true,
                turnNo: true,
                firstEpoch: true,
                revokedAt: true,
              },
            }),
          ),
        )
        if (key && key.revokedAt === null)
          await this.#wait(this.#options.credentials.revoke(refFromKey(key)))
        else await this.#wait(this.#options.secrets.kvDestroyAll(path))
        this.#options.onSwept?.('vault')
      } catch {
        failed = true
        if (!this.#shutdown.signal.aborted)
          this.#options.logger?.warn('llm_credentials_sweep_failed kind=vault_key')
      }
    }
    // Retry a failed page instead of dropping a cleanup between LIST and metadata/destroy.
    if (!failed) this.#cursor = page.length < 100 ? undefined : page.at(-1)
  }

  async #retireDrained(): Promise<void> {
    const accounts = await this.#wait(
      this.#transaction(
        (tx) => tx.$queryRaw<{ id: string; backend: string }[]>`
      SELECT a.id, p.slug AS backend FROM subscription_accounts a
      JOIN llm_providers p ON p.id = a.provider_id
      WHERE a.retire_requested_at IS NOT NULL AND a.enabled
      ORDER BY a.retire_requested_at, a.id LIMIT 1000`,
      ),
    )
    for (const account of accounts) {
      if (this.#shutdown.signal.aborted) return
      const retired = await this.#wait(
        this.#transaction(async (tx) => {
          // Same pool lock as issue: no new key can race the final disable after a restart.
          await lockSubscriptionPool(tx, account.backend)
          await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${account.id}::uuid FOR UPDATE`
          const rows = await tx.$queryRaw<
            { id: string }[]
          >`UPDATE subscription_accounts a SET enabled = false, updated_at = clock_timestamp()
          WHERE a.id = ${account.id}::uuid AND a.retire_requested_at IS NOT NULL AND a.enabled
          AND NOT EXISTS (SELECT 1 FROM llm_keys k WHERE k.subscription_account_id = a.id
            AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL AND k.expires_at > clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM llm_calls c WHERE c.subscription_account_id = a.id AND c.state = 'open') RETURNING a.id`
          return rows.length > 0
        }),
      )
      if (retired) this.#options.onSwept?.('retirement')
    }
  }
}
