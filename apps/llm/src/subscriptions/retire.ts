import type { Prisma, PrismaClient } from '@repo/db'
import {
  badRequest,
  conflict,
  isDomainError,
  llmGatewayUnavailable,
  notFound,
  withTimeout,
  type LlmBackend,
  type SecretStore,
  type TurnCredentialRef,
  type TurnCredentialSource,
} from '@repo/domain'
import { z } from 'zod'
import { lockSubscriptionPool, subscriptionCredentialPath } from '@repo/turn-keys'

import type { SubscriptionLocks } from '../gateway/session-lock.ts'

type Transaction = Prisma.TransactionClient
type Account = Prisma.SubscriptionAccountGetPayload<{
  include: { provider: true; credentialRef: true }
}>
type Backend = Pick<LlmBackend, 'id'>
type PendingKey = Pick<
  Prisma.LlmKeyGetPayload<Record<string, never>>,
  'taskId' | 'sessionId' | 'turnNo' | 'firstEpoch'
>
type AdmissionState = { pending: boolean; active: boolean; open: boolean }
type FinalizationPreparation = { result: SubscriptionRetirementResult } | { path: string }

export type SubscriptionRetirementStage =
  | 'draining'
  | 'turn_revocation_pending'
  | 'console_revocation_required'
  | 'ready_for_finalization'
  | 'retired'
  | 'cancelled'

export interface SubscriptionRetirementResult {
  accountId: string
  backend: string
  stage: SubscriptionRetirementStage
}

export interface SubscriptionRetirementOptions {
  prisma: Pick<PrismaClient, '$transaction'>
  /** The admin capability destroys versions; it has no reason to read subscription values. */
  secrets: Pick<SecretStore, 'kvDestroyAll'>
  credentials: Pick<TurnCredentialSource, 'revoke'>
  locks: SubscriptionLocks
  backends: readonly Backend[]
}

/**
 * The operator confirms the account by its label as stored; the command requires it, services
 * may omit it. The value is only compared, never stored or printed, so it is not held to the
 * rule of new labels (`subscriptionLabelSchema`): an account labelled before that rule, or by
 * hand, must still be nameable, or an emergency retirement could not reach it.
 */
export const retirementLabelSchema = z.string().min(1).max(255)
const label = retirementLabelSchema.optional()
const requestSchema = z.strictObject({
  accountId: z.uuid().transform((id) => id.toLowerCase()),
  compromised: z.boolean().optional(),
  label,
})
const finalizeSchema = z.strictObject({
  accountId: z.uuid().transform((id) => id.toLowerCase()),
  consoleRevoked: z.boolean().optional(),
  label,
})
const cancelSchema = z.strictObject({ accountId: z.uuid().transform((id) => id.toLowerCase()) })

/** Fixed refusals the operator can act on; the command shows each of them in Russian. */
export const retirementRefusals = {
  busy: 'Subscription account is being updated; retry retirement',
  notRequested: 'Subscription retirement was not requested',
  unconfirmed: 'Subscription provider revocation is not confirmed',
  changed: 'Subscription retirement state changed',
  notDrained: 'Subscription retirement has not drained',
  notFound: 'Subscription account was not found',
  unsupported: 'Unsupported subscription backend',
  backendChanged: 'Subscription backend changed during retirement',
  foreignPath: 'Subscription credential reference does not match its account',
  labelMismatch: 'Subscription account label does not match',
  revoked: 'Subscription credentials were already revoked; import the account again',
} as const

/** Operator retirement fences issuance in SQL before any Vault or provider work. */
export class SubscriptionRetirement {
  readonly #options: SubscriptionRetirementOptions
  readonly #backends: Map<string, Backend>

  constructor(options: SubscriptionRetirementOptions) {
    this.#options = options
    this.#backends = new Map(options.backends.map((backend) => [backend.id, backend]))
    if (this.#backends.size !== options.backends.length)
      throw badRequest('Duplicate subscription backend')
  }

  async request(input: z.input<typeof requestSchema>): Promise<SubscriptionRetirementResult> {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid subscription retirement request')
    const { accountId, compromised } = parsed.data
    return this.#safe(async () => {
      const keys = await this.#transaction(async (tx) => {
        const before = await this.#poolAccount(tx, accountId)
        this.#confirm(before, parsed.data.label)
        // Gateway admission/close locks key → account. Do not hold the account while
        // waiting for key rows: a concurrent gateway call would wait in the reverse order.
        if (compromised && before.status !== 'retired')
          await tx.$executeRaw`UPDATE llm_keys
            SET revoke_requested_at = coalesce(revoke_requested_at, clock_timestamp())
            WHERE subscription_account_id = ${accountId}::uuid AND revoked_at IS NULL`
        const account = await this.#lockAccount(tx, accountId, before.provider.slug)
        if (account.status === 'retired') return []
        await tx.$executeRaw`UPDATE subscription_accounts
          SET retire_requested_at = coalesce(retire_requested_at, clock_timestamp()),
            enabled = CASE WHEN ${compromised === true} THEN false ELSE enabled END,
            updated_at = clock_timestamp()
          WHERE id = ${accountId}::uuid`
        // A later invocation without --compromised also resumes a prior emergency request.
        return tx.llmKey.findMany({
          where: {
            subscriptionAccountId: accountId,
            revokedAt: null,
            revokeRequestedAt: { not: null },
          },
          orderBy: { id: 'asc' },
          select: { taskId: true, sessionId: true, turnNo: true, firstEpoch: true },
        })
      })
      // SQL has committed every retry marker. One failed secret deletion cannot stop the rest.
      for (let offset = 0; offset < keys.length; offset += 4)
        await Promise.allSettled(
          keys
            .slice(offset, offset + 4)
            .map((key) =>
              withTimeout(
                this.#options.credentials.revoke(ref(key)),
                10_000,
                'Subscription turn revocation timeout',
              ),
            ),
        )
      return this.#transaction(async (tx) => this.#result(tx, await this.#account(tx, accountId)))
    })
  }

  async finalize(input: z.input<typeof finalizeSchema>): Promise<SubscriptionRetirementResult> {
    const parsed = finalizeSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid subscription finalization request')
    const { accountId, consoleRevoked } = parsed.data
    return this.#safe(async () => {
      const lease = await this.#external(() => this.#options.locks.tryAcquire(accountId))
      if (!lease) throw conflict(retirementRefusals.busy)
      try {
        lease.signal?.throwIfAborted()
        const preparation = await this.#transaction<FinalizationPreparation>(async (tx) => {
          let account = await this.#lockedAccount(tx, accountId)
          this.#confirm(account, parsed.data.label)
          if (account.status === 'retired') return { result: this.#value(account, 'retired') }
          if (!account.retireRequestedAt) throw conflict(retirementRefusals.notRequested)
          this.#path(account)
          const result = await this.#result(tx, account)
          if (result.stage === 'draining' || result.stage === 'turn_revocation_pending')
            return { result }
          if (!account.credentialsRevokedAt) {
            // The platform cannot revoke a key at its provider: the operator does it in the
            // provider's console and says so here.
            if (!consoleRevoked) return { result }
            // This is a durable acknowledgement, so a Vault outage needs no second console action.
            await tx.$executeRaw`UPDATE subscription_accounts
              SET credentials_revoked_at = clock_timestamp(), updated_at = clock_timestamp()
              WHERE id = ${accountId}::uuid AND retire_requested_at IS NOT NULL AND NOT enabled
                AND credentials_revoked_at IS NULL`
            account = await this.#account(tx, accountId)
          }
          if (!account.credentialsRevokedAt) throw conflict(retirementRefusals.unconfirmed)
          return { path: this.#path(account) }
        })
        if ('result' in preparation) return preparation.result
        lease.signal?.throwIfAborted()
        await this.#external(() =>
          withTimeout(
            this.#options.secrets.kvDestroyAll(preparation.path),
            10_000,
            'Subscription destruction timeout',
          ),
        )
        lease.signal?.throwIfAborted()
        // No SQL locks span Vault I/O. The account lock also excludes a relogin.
        return this.#transaction(async (tx) => {
          const account = await this.#lockedAccount(tx, accountId)
          if (account.status === 'retired') return this.#value(account, 'retired')
          if (
            account.enabled ||
            !account.retireRequestedAt ||
            !account.credentialsRevokedAt ||
            this.#path(account) !== preparation.path
          )
            throw conflict(retirementRefusals.changed)
          const state = await this.#admissionState(tx, accountId)
          if (state.pending || state.active || state.open)
            throw conflict(retirementRefusals.notDrained)
          lease.signal?.throwIfAborted()
          await tx.$executeRaw`UPDATE subscription_accounts
            SET status = 'retired', updated_at = clock_timestamp()
            WHERE id = ${accountId}::uuid AND retire_requested_at IS NOT NULL AND NOT enabled
              AND credentials_revoked_at IS NOT NULL`
          return this.#value(account, 'retired')
        })
      } finally {
        await this.#external(() => lease.release())
      }
    })
  }

  /**
   * Withdraws a request while the key is still valid at the provider. The account keeps its
   * enabled flag: if a drain or --compromised disabled it, the operator enables it after the
   * usual checks. Once the revocation of the key is acknowledged the way back is a new import.
   */
  async cancel(input: z.input<typeof cancelSchema>): Promise<SubscriptionRetirementResult> {
    const parsed = cancelSchema.safeParse(input)
    if (!parsed.success) throw badRequest('Invalid subscription retirement cancellation')
    const { accountId } = parsed.data
    return this.#safe(async () => {
      const lease = await this.#external(() => this.#options.locks.tryAcquire(accountId))
      if (!lease) throw conflict(retirementRefusals.busy)
      try {
        lease.signal?.throwIfAborted()
        return await this.#transaction(async (tx) => {
          const account = await this.#lockedAccount(tx, accountId)
          if (account.status === 'retired' || account.credentialsRevokedAt)
            throw conflict(retirementRefusals.revoked)
          lease.signal?.throwIfAborted()
          await tx.$executeRaw`UPDATE subscription_accounts
            SET retire_requested_at = NULL, updated_at = clock_timestamp()
            WHERE id = ${accountId}::uuid AND retire_requested_at IS NOT NULL
              AND credentials_revoked_at IS NULL AND status <> 'retired'`
          return this.#value(account, 'cancelled')
        })
      } finally {
        await this.#external(() => lease.release())
      }
    })
  }

  #confirm(account: Account, label: string | undefined): void {
    if (label !== undefined && account.label !== label)
      throw conflict(retirementRefusals.labelMismatch)
  }

  async #account(tx: Transaction, accountId: string): Promise<Account> {
    const account = await tx.subscriptionAccount.findUnique({
      where: { id: accountId },
      include: { provider: true, credentialRef: true },
    })
    if (!account) throw notFound(retirementRefusals.notFound)
    this.#backend(account)
    return account
  }

  async #lockedAccount(tx: Transaction, accountId: string): Promise<Account> {
    const before = await this.#poolAccount(tx, accountId)
    return this.#lockAccount(tx, accountId, before.provider.slug)
  }

  async #poolAccount(tx: Transaction, accountId: string): Promise<Account> {
    const before = await this.#account(tx, accountId)
    await lockSubscriptionPool(tx, before.provider.slug)
    const account = await this.#account(tx, accountId)
    if (account.provider.slug !== before.provider.slug)
      throw conflict(retirementRefusals.backendChanged)
    return account
  }

  async #lockAccount(tx: Transaction, accountId: string, backend: string): Promise<Account> {
    await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${accountId}::uuid FOR UPDATE`
    const account = await this.#account(tx, accountId)
    if (account.provider.slug !== backend) throw conflict(retirementRefusals.backendChanged)
    return account
  }

  #backend(account: Account): Backend {
    const backend = this.#backends.get(account.provider.slug)
    if (!backend) throw badRequest(retirementRefusals.unsupported)
    return backend
  }

  #path(account: Account): string {
    const path = subscriptionCredentialPath(this.#backend(account).id, account.id)
    if (account.credentialRef.kind !== 'subscription' || account.credentialRef.vaultPath !== path)
      throw conflict(retirementRefusals.foreignPath)
    return path
  }

  async #admissionState(tx: Transaction, accountId: string): Promise<AdmissionState> {
    const rows = await tx.$queryRaw<AdmissionState[]>`
      SELECT
        EXISTS (SELECT 1 FROM llm_keys WHERE subscription_account_id = ${accountId}::uuid
          AND revoke_requested_at IS NOT NULL AND revoked_at IS NULL) AS pending,
        EXISTS (SELECT 1 FROM llm_keys WHERE subscription_account_id = ${accountId}::uuid
          AND revoke_requested_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()) AS active,
        EXISTS (SELECT 1 FROM llm_calls WHERE subscription_account_id = ${accountId}::uuid
          AND state = 'open') AS open`
    const state = rows[0]
    if (!state) throw llmGatewayUnavailable()
    return state
  }

  async #result(tx: Transaction, account: Account): Promise<SubscriptionRetirementResult> {
    if (account.status === 'retired') return this.#value(account, 'retired')
    const state = await this.#admissionState(tx, account.id)
    const stage = state.pending
      ? 'turn_revocation_pending'
      : account.enabled || state.active || state.open
        ? 'draining'
        : account.credentialsRevokedAt
          ? 'ready_for_finalization'
          : 'console_revocation_required'
    return this.#value(account, stage)
  }

  #value(account: Account, stage: SubscriptionRetirementStage): SubscriptionRetirementResult {
    return { accountId: account.id, backend: account.provider.slug, stage }
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

  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (isDomainError(error)) throw error
      throw llmGatewayUnavailable()
    }
  }

  async #external<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch {
      throw llmGatewayUnavailable()
    }
  }
}

function ref(key: PendingKey): TurnCredentialRef {
  return {
    taskId: key.taskId,
    sessionId: key.sessionId,
    turn: key.turnNo,
    epoch: key.firstEpoch,
  }
}
