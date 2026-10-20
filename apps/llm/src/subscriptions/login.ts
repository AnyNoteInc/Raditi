import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient } from '@repo/db'
import {
  credentialMetadataSchema,
  type CredentialMetadata,
  type LlmBackend,
  type SecretStore,
} from '@repo/domain'
import { z } from 'zod'
import { lockSubscriptionPool, subscriptionCredentialPath } from '@repo/turn-keys'

import { encodeSubscriptionCredential } from '../gateway/credentials.ts'
import type { SubscriptionLockLease, SubscriptionLocks } from '../gateway/session-lock.ts'

export type SubscriptionLoginErrorCode =
  | 'invalid_input'
  | 'account_conflict'
  | 'account_unavailable'
  | 'identity_mismatch'
  | 'busy'
  | 'vault_unavailable'
  | 'persistence_failed'

/** Only fixed messages and the non-secret account id can escape this boundary. */
export class SubscriptionLoginError extends Error {
  readonly code: SubscriptionLoginErrorCode
  readonly accountId?: string

  constructor(code: SubscriptionLoginErrorCode, accountId?: string) {
    super(`Subscription login failed: ${code}`)
    this.name = 'SubscriptionLoginError'
    this.code = code
    this.accountId = accountId
  }
}

export interface SubscriptionLoginResult {
  accountId: string
  backend: string
  credentialVersion: number
  enabled: boolean
}

export interface SubscriptionImportInput {
  backend: string
  driverId: string
  credential: unknown
  label: string
  /** Required when the adapter cannot report a plan; cannot override reported metadata. */
  plan?: string
  paidUntil?: Date | null
  maxConcurrentTurns?: number
  maxConcurrentRequests?: number
}

export interface SubscriptionReloginInput {
  backend: string
  accountId: string
  credential: unknown
}

export interface SubscriptionLoginOptions {
  prisma: Pick<PrismaClient, '$transaction'>
  /** Import intentionally cannot read subscription credential contents. */
  writer: Pick<SecretStore, 'kvWrite' | 'kvMetadata'>
  locks: SubscriptionLocks
  backends: readonly LlmBackend[]
}

/**
 * The operator's name of an account (`subscription_accounts.label`, VarChar 255), printed to
 * terminals and logs: one line, so no Unicode control character (Cc), C1 included — U+009B
 * opens an escape sequence on an 8-bit terminal. The rule of user names in @repo/auth.
 */
export const subscriptionLabelSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^\P{Cc}*$/u)
const accountIdSchema = z.uuid().regex(/^[0-9a-f-]+$/)
const planSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/)
const metadataSchema = credentialMetadataSchema.and(
  z.object({ externalAccountId: z.string().max(128).nullable(), plan: planSchema.nullable() }),
)
const importSchema = z
  .object({
    backend: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/),
    driverId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_-]+$/),
    credential: z.unknown(),
    label: subscriptionLabelSchema,
    plan: planSchema.optional(),
    paidUntil: z.date().nullable().optional(),
    maxConcurrentTurns: z.number().int().min(1).max(8).default(1),
    maxConcurrentRequests: z.number().int().min(1).max(16).default(1),
  })
  .strict()
const reloginSchema = z
  .object({
    backend: importSchema.shape.backend,
    accountId: accountIdSchema,
    credential: z.unknown(),
  })
  .strict()
type Account = Prisma.SubscriptionAccountGetPayload<{
  include: { provider: true; credentialRef: true }
}>

/** A key the provider has confirmed enters Vault through a write-only operator capability. */
export class SubscriptionLogin {
  readonly #options: SubscriptionLoginOptions

  constructor(options: SubscriptionLoginOptions) {
    this.#options = options
  }

  /**
   * Runs before the key is asked for: a dead or unauthorized writer token, or a label already
   * in use, would otherwise surface only after the operator has typed it in. The import
   * repeats both checks under its locks. The token's remaining lifetime is not known here.
   */
  async preflight(input: { backend: string; label?: string }): Promise<void> {
    try {
      const backend = this.#options.backends.find((entry) => entry.id === input.backend)
      if (!backend) throw new SubscriptionLoginError('invalid_input')
      try {
        // Writer may read metadata of any subs/ path; an unused one answers 404 → null.
        await this.#options.writer.kvMetadata(subscriptionCredentialPath(backend.id, randomUUID()))
      } catch {
        throw new SubscriptionLoginError('vault_unavailable')
      }
      if (input.label === undefined) return
      const label = input.label
      const existing = await this.#transaction((tx) =>
        tx.subscriptionAccount.findFirst({
          where: { label, status: { not: 'retired' } },
          select: { id: true },
        }),
      )
      if (existing) throw new SubscriptionLoginError('account_conflict', existing.id)
    } catch (error) {
      if (error instanceof SubscriptionLoginError) throw error
      throw new SubscriptionLoginError('persistence_failed')
    }
  }

  async importAccount(input: SubscriptionImportInput): Promise<SubscriptionLoginResult> {
    let accountId: string | undefined
    let lease: SubscriptionLockLease | null = null
    try {
      const parsed = importSchema.safeParse(input)
      if (!parsed.success) throw new SubscriptionLoginError('invalid_input')
      const value = parsed.data
      const { backend, encoded, metadata } = this.#credential(value.backend, value.credential)
      const plan = metadata.plan ?? value.plan
      if (!plan || (metadata.plan !== null && value.plan !== undefined && plan !== value.plan))
        throw new SubscriptionLoginError('invalid_input')
      accountId = randomUUID()
      lease = await this.#options.locks.tryAcquire(accountId)
      if (!lease) throw new SubscriptionLoginError('busy')
      this.#assertLease(lease, accountId)
      const path = subscriptionCredentialPath(backend.id, accountId)
      const account = await this.#transaction(async (tx) => {
        await lockSubscriptionPool(tx, backend.id)
        const provider = await tx.llmProvider.findUnique({ where: { slug: backend.id } })
        const driver = await tx.agentDriver.findUnique({ where: { id: value.driverId } })
        if (!provider || provider.kind !== 'subscription' || !driver)
          throw new SubscriptionLoginError('account_unavailable')
        // The unique indexes skip retired rows: never findUnique by label or external id.
        const existing = await tx.subscriptionAccount.findFirst({
          where: {
            status: { not: 'retired' },
            OR: [
              { label: value.label },
              ...(metadata.externalAccountId === null
                ? []
                : [{ providerId: provider.id, externalAccountId: metadata.externalAccountId }]),
            ],
          },
        })
        if (existing) throw new SubscriptionLoginError('account_conflict', existing.id)
        const ref = await tx.credentialRef.create({
          data: { kind: 'subscription', vaultPath: path, keyVersion: 0 },
        })
        const now = await this.#databaseNow(tx)
        this.#assertLease(lease!, accountId!)
        return tx.subscriptionAccount.create({
          data: {
            id: accountId,
            providerId: provider.id,
            driverId: value.driverId,
            label: value.label,
            credentialRefId: ref.id,
            plan,
            externalAccountId: metadata.externalAccountId,
            paidUntil: value.paidUntil ?? null,
            maxConcurrentTurns: value.maxConcurrentTurns,
            maxConcurrentRequests: value.maxConcurrentRequests,
            enabled: false,
            health: 'needs_relogin',
            healthReason: 'import_pending',
            healthChangedAt: now,
          },
          include: { provider: true, credentialRef: true },
        })
      })
      const version = await this.#write(path, encoded, 0, accountId)
      this.#assertLease(lease, accountId)
      return await this.#finishConfirmed(account, metadata, plan, version, lease)
    } catch (error) {
      if (error instanceof SubscriptionLoginError) throw error
      throw new SubscriptionLoginError('persistence_failed', accountId)
    } finally {
      await lease?.release().catch(() => undefined)
    }
  }

  async relogin(input: SubscriptionReloginInput): Promise<SubscriptionLoginResult> {
    let accountId: string | undefined
    let lease: SubscriptionLockLease | null = null
    try {
      const parsed = reloginSchema.safeParse(input)
      if (!parsed.success) throw new SubscriptionLoginError('invalid_input')
      const value = parsed.data
      accountId = value.accountId
      const { backend, encoded, metadata } = this.#credential(value.backend, value.credential)
      lease = await this.#options.locks.tryAcquire(accountId)
      if (!lease) throw new SubscriptionLoginError('busy', accountId)
      this.#assertLease(lease, accountId)
      const account = await this.#transaction(async (tx) => {
        await lockSubscriptionPool(tx, backend.id)
        await this.#rowLock(tx, accountId!)
        const current = await tx.subscriptionAccount.findUnique({
          where: { id: accountId },
          include: { provider: true, credentialRef: true },
        })
        this.#checkAccount(current, backend, metadata, accountId!)
        return current!
      })
      let cas: number
      try {
        const info = await this.#options.writer.kvMetadata(account.credentialRef.vaultPath)
        if (!info && account.credentialVersion === 0) cas = 0
        else {
          if (
            !info ||
            info.deleted ||
            info.destroyed ||
            !Number.isSafeInteger(info.currentVersion) ||
            info.currentVersion < Math.max(1, account.credentialVersion) ||
            info.currentVersion >= 2_147_483_647
          )
            throw new SubscriptionLoginError('vault_unavailable', accountId)
          cas = info.currentVersion
        }
      } catch {
        throw new SubscriptionLoginError('vault_unavailable', accountId)
      }
      this.#assertLease(lease, accountId)
      await this.#transaction(async (tx) => {
        await lockSubscriptionPool(tx, backend.id)
        await this.#rowLock(tx, accountId!)
        const current = await tx.subscriptionAccount.findUnique({
          where: { id: accountId },
          include: { provider: true, credentialRef: true },
        })
        this.#checkAccount(current, backend, metadata, accountId!)
        if (current!.credentialVersion !== account.credentialVersion)
          throw new SubscriptionLoginError('account_conflict', accountId)
        const now = await this.#databaseNow(tx)
        this.#assertLease(lease!, accountId!)
        await tx.subscriptionAccount.update({
          where: { id: accountId },
          data: {
            health: 'needs_relogin',
            healthReason: 'relogin_pending',
            healthChangedAt: now,
          },
        })
      })
      this.#assertLease(lease, accountId)
      const version = await this.#write(account.credentialRef.vaultPath, encoded, cas, accountId)
      this.#assertLease(lease, accountId)
      return await this.#finishConfirmed(
        account,
        metadata,
        metadata.plan ?? account.plan,
        version,
        lease,
      )
    } catch (error) {
      if (error instanceof SubscriptionLoginError) throw error
      throw new SubscriptionLoginError('persistence_failed', accountId)
    } finally {
      await lease?.release().catch(() => undefined)
    }
  }

  #credential(backendId: string, input: unknown) {
    try {
      const backend = this.#options.backends.find((entry) => entry.id === backendId)
      if (!backend) throw new SubscriptionLoginError('invalid_input')
      const credential = backend.credentialSchema.parse(input)
      const metadata = metadataSchema.parse(backend.credentialMetadata(credential))
      if (metadata.accessExpiresAt !== null && +metadata.accessExpiresAt <= Date.now())
        throw new SubscriptionLoginError('invalid_input')
      return { backend, metadata, encoded: encodeSubscriptionCredential(credential) }
    } catch {
      throw new SubscriptionLoginError('invalid_input')
    }
  }

  #checkAccount(
    account: Account | null,
    backend: LlmBackend,
    metadata: CredentialMetadata,
    accountId: string,
  ): void {
    if (
      !account ||
      account.provider.slug !== backend.id ||
      account.provider.kind !== 'subscription' ||
      account.credentialRef.kind !== 'subscription' ||
      account.credentialRef.vaultPath !== subscriptionCredentialPath(backend.id, account.id) ||
      account.status === 'retired' ||
      account.retireRequestedAt !== null ||
      account.credentialsRevokedAt !== null
    )
      throw new SubscriptionLoginError('account_unavailable', accountId)
    if (account.externalAccountId !== metadata.externalAccountId)
      throw new SubscriptionLoginError('identity_mismatch', accountId)
  }

  async #write(
    path: string,
    data: Record<string, string>,
    cas: number,
    accountId: string,
  ): Promise<number> {
    try {
      // An ambiguous write is never automatically repeated, even with the same CAS.
      const result = await this.#options.writer.kvWrite(path, data, { cas })
      if (result.version !== cas + 1) throw new Error('Invalid Vault version')
      return result.version
    } catch {
      throw new SubscriptionLoginError('vault_unavailable', accountId)
    }
  }

  async #finishConfirmed(
    account: Account,
    metadata: CredentialMetadata,
    plan: string,
    version: number,
    lease: SubscriptionLockLease,
  ): Promise<SubscriptionLoginResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.#assertLease(lease, account.id)
      try {
        return await this.#finish(account, metadata, plan, version, lease)
      } catch (error) {
        if (error instanceof SubscriptionLoginError) throw error
      }
    }
    throw new SubscriptionLoginError('persistence_failed', account.id)
  }

  async #finish(
    account: Account,
    metadata: CredentialMetadata,
    plan: string,
    version: number,
    lease: SubscriptionLockLease,
  ): Promise<SubscriptionLoginResult> {
    return this.#transaction(async (tx) => {
      await lockSubscriptionPool(tx, account.provider.slug)
      await this.#rowLock(tx, account.id)
      const current = await tx.subscriptionAccount.findUnique({
        where: { id: account.id },
        include: { provider: true, credentialRef: true },
      })
      const backend = this.#options.backends.find((entry) => entry.id === account.provider.slug)!
      this.#checkAccount(current, backend, metadata, account.id)
      this.#assertLease(lease, account.id)
      // A lost COMMIT reply can be resolved because this process owns the confirmed CAS.
      if (
        current!.credentialVersion === version &&
        current!.credentialRef.keyVersion === version &&
        current!.plan === plan &&
        current!.health === 'ok' &&
        current!.healthReason === null
      )
        return {
          accountId: account.id,
          backend: backend.id,
          credentialVersion: version,
          enabled: current!.enabled,
        }
      if (
        current!.credentialVersion !== account.credentialVersion ||
        !['import_pending', 'relogin_pending'].includes(current!.healthReason ?? '') ||
        current!.health !== 'needs_relogin'
      )
        throw new SubscriptionLoginError('account_conflict', account.id)
      const now = await this.#databaseNow(tx)
      this.#assertLease(lease, account.id)
      const updated = await tx.subscriptionAccount.update({
        where: { id: account.id },
        data: {
          credentialVersion: version,
          credentialExpiresAt: metadata.accessExpiresAt,
          credentialRefreshedAt: metadata.accessIssuedAt ?? now,
          plan,
          health: 'ok',
          healthReason: null,
          healthChangedAt: now,
        },
      })
      await tx.credentialRef.update({
        where: { id: account.credentialRefId },
        data: { keyVersion: version },
      })
      return {
        accountId: account.id,
        backend: backend.id,
        credentialVersion: version,
        enabled: updated.enabled,
      }
    })
  }

  #assertLease(lease: SubscriptionLockLease, accountId: string): void {
    if (lease.signal?.aborted) throw new SubscriptionLoginError('persistence_failed', accountId)
  }

  async #rowLock(tx: Prisma.TransactionClient, accountId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM subscription_accounts WHERE id = ${accountId}::uuid FOR UPDATE`
  }

  async #databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    if (!rows[0]) throw new SubscriptionLoginError('persistence_failed')
    return rows[0].now
  }

  #transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.#options.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
        return operation(tx)
      },
      { maxWait: 5_000, timeout: 8_000 },
    )
  }
}
