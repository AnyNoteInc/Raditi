import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { EgressHttp, LlmBackend, LlmBackendId, SecretStore } from '@repo/domain'
import { kimiCodeBackend } from '@repo/llm-backends'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createCredentialSource, encodeSubscriptionCredential } from './credentials.ts'
import { SubscriptionRefresher } from './refresher.ts'
import { SessionSubscriptionLock } from './session-lock.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const oldCredential = { v: '1', kind: 'kimi_api_key', apiKey: 'synthetic-old-key' }
const newCredential = { ...oldCredential, apiKey: 'synthetic-new-key' }

describe.skipIf(!enabled)(
  'subscription refresh durability and independent PostgreSQL sessions',
  () => {
    let db: PrismaClient
    const cleanup: (() => Promise<void>)[] = []
    beforeAll(() => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    })
    afterEach(async () => {
      for (const action of cleanup.splice(0).reverse()) await action()
    })
    afterAll(async () => db?.$disconnect())

    async function fixture(id = randomUUID()) {
      const suffix = randomUUID().replaceAll('-', '')
      const backendId = `synthetic-refresh-${suffix}` as LlmBackendId
      const provider = await db.llmProvider.create({
        data: {
          slug: backendId,
          name: 'Synthetic refresh verification',
          kind: 'subscription',
          enabled: true,
        },
      })
      const driver = await db.agentDriver.create({
        data: {
          id: `refresh-${suffix.slice(0, 16)}`,
          image: 'synthetic.invalid/refresher',
          capabilities: {},
          enabled: true,
        },
      })
      const credential = await db.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/${backendId}/${id}`, keyVersion: 1 },
      })
      const account = await db.subscriptionAccount.create({
        data: {
          id,
          providerId: provider.id,
          driverId: driver.id,
          label: `refresh-${suffix}`,
          credentialRefId: credential.id,
          plan: 'synthetic',
          enabled: true,
          credentialVersion: 1,
          credentialRefreshedAt: new Date(Date.now() - 86_400_000),
          credentialExpiresAt: new Date(Date.now() + 43_200_000),
          maxConcurrentTurns: 2,
          maxConcurrentRequests: 2,
        },
      })
      cleanup.push(async () => {
        await db.subscriptionAccount.delete({ where: { id } })
        await db.credentialRef.delete({ where: { id: credential.id } })
        await db.agentDriver.delete({ where: { id: driver.id } })
        await db.llmProvider.delete({ where: { id: provider.id } })
      })
      let value = { version: 1, data: encodeSubscriptionCredential(oldCredential) }
      const secrets = {
        kvRead: vi.fn(async (_path: string) => value),
        kvWrite: vi.fn(
          async (_path: string, data: Record<string, string>, options?: { cas?: number }) => {
            expect(options?.cas).toBe(value.version)
            value = { version: value.version + 1, data }
            return { version: value.version }
          },
        ),
      }
      const refresh = vi
        .fn<NonNullable<LlmBackend['refresh']>>()
        .mockResolvedValue({ kind: 'ok', credential: newCredential })
      const backend: LlmBackend = {
        ...kimiCodeBackend,
        id: backendId,
        credentialMetadata: () => ({
          externalAccountId: null,
          plan: 'synthetic',
          accessIssuedAt: null,
          accessExpiresAt: new Date(Date.now() + 86_400_000),
        }),
        refresh,
      }
      const pool = new Pool({
        connectionString: databaseUrl,
        max: 2,
        connectionTimeoutMillis: 3_000,
      })
      const locks = new SessionSubscriptionLock(pool)
      const refresher = new SubscriptionRefresher({
        prisma: db,
        secrets: secrets as unknown as SecretStore,
        credentials: createCredentialSource(secrets),
        backends: [backend],
        http: { request: vi.fn() } as unknown as EgressHttp,
        channelHealthy: () => true,
        onRegion: vi.fn(),
        locks,
      })
      cleanup.push(async () => {
        await refresher.close()
        await pool.end()
      })
      const done = async () => {
        // A second scheduler pass joins the serial tail, so database persistence has finished.
        await refresher.tick()
        await refresher.close()
        return db.subscriptionAccount.findUniqueOrThrow({ where: { id } })
      }
      return {
        account,
        credential,
        pool,
        locks,
        refresher,
        refresh,
        backend,
        secrets,
        done,
        setVault: (next: typeof value) => (value = next),
      }
    }

    it('refreshes beyond a full page of ambiguous accounts without repeating their OAuth', async () => {
      const suffix = randomUUID().replaceAll('-', '')
      const f = await fixture(`ffffffff-ffff-4fff-8fff-${suffix.slice(0, 12)}`)
      const refs = Array.from({ length: 100 }, (_, index) => {
        const id = `00000000-0000-4000-8000-${suffix.slice(12, 18)}${String(index).padStart(6, '0')}`
        return { id: randomUUID(), accountId: id, vaultPath: `subs/${f.backend.id}/${id}` }
      })
      const readTarget = f.secrets.kvRead.getMockImplementation()!
      f.secrets.kvRead.mockImplementation(async (path) =>
        path === f.credential.vaultPath
          ? readTarget(path)
          : { version: 1, data: encodeSubscriptionCredential(oldCredential) },
      )
      await db.credentialRef.createMany({
        data: refs.map(({ id, vaultPath }) => ({
          id,
          kind: 'subscription',
          vaultPath,
          keyVersion: 1,
        })),
      })
      cleanup.push(async () => {
        await db.subscriptionAccount.deleteMany({
          where: { providerId: f.account.providerId, id: { in: refs.map((ref) => ref.accountId) } },
        })
        await db.credentialRef.deleteMany({ where: { id: { in: refs.map((ref) => ref.id) } } })
      })
      await db.subscriptionAccount.createMany({
        data: refs.map((ref) => ({
          id: ref.accountId,
          providerId: f.account.providerId,
          driverId: f.account.driverId,
          label: `ambiguous-${ref.accountId}`,
          credentialRefId: ref.id,
          plan: 'synthetic',
          enabled: true,
          credentialVersion: 1,
          credentialRefreshedAt: new Date(Date.now() - 2 * 86_400_000),
          credentialExpiresAt: new Date(Date.now() + 43_200_000),
          refreshStartedAt: new Date(Date.now() - 60_000),
          healthReason: 'refresh_ambiguous',
          maxConcurrentTurns: 2,
          maxConcurrentRequests: 2,
        })),
      })
      await f.refresher.tick()
      await f.refresher.tick()
      expect(f.refresh).toHaveBeenCalledTimes(1)
      const target = await db.subscriptionAccount.findUniqueOrThrow({ where: { id: f.account.id } })
      expect(target.credentialVersion).toBe(2)
      const ambiguous = await db.subscriptionAccount.findMany({
        where: { id: { in: refs.map((ref) => ref.accountId) } },
      })
      expect(ambiguous).toHaveLength(100)
      expect(
        ambiguous.every(
          (row) =>
            row.healthReason === 'refresh_ambiguous' &&
            row.refreshFinishedAt === null &&
            row.credentialVersion === 1,
        ),
      ).toBe(true)
      // Two passes over 101 accounts, each under its own session lock: about three seconds on a
      // free machine, and past the default five when the suite shares it with a Docker stand.
    }, 30_000)

    it('holds a non-transactional session lock after the committed marker and until CAS/account completion', async () => {
      const f = await fixture()
      const otherPool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 3_000,
      })
      const contender = new SessionSubscriptionLock(otherPool)
      cleanup.push(async () => {
        await contender.close()
        await otherPool.end()
      })
      f.refresh.mockImplementation(async () => {
        const marked = await db.subscriptionAccount.findUniqueOrThrow({
          where: { id: f.account.id },
        })
        expect(marked.refreshStartedAt).not.toBeNull()
        expect(marked.refreshFinishedAt).toBeNull()
        expect(await contender.tryAcquire(f.account.id)).toBeNull()
        return { kind: 'ok', credential: newCredential }
      })
      expect(await f.refresher.refresh(f.account.id, 'auth', 1)).toEqual(newCredential)
      const row = await f.done()
      expect(row.credentialVersion).toBe(2)
      expect(row.refreshFinishedAt).not.toBeNull()
      const ref = await db.credentialRef.findUniqueOrThrow({ where: { id: f.credential.id } })
      expect(ref.keyVersion).toBe(2)
      const lease = await contender.tryAcquire(f.account.id)
      expect(lease).not.toBeNull()
      await lease!.release()
    })

    it('repairs a completed Vault CAS after a crash without sending another refresh', async () => {
      const f = await fixture()
      await db.subscriptionAccount.update({
        where: { id: f.account.id },
        data: { refreshStartedAt: new Date(), healthReason: 'refresh_ambiguous' },
      })
      f.setVault({ version: 2, data: encodeSubscriptionCredential(newCredential) })
      expect(await f.refresher.refresh(f.account.id, 'auth', 1)).toEqual(newCredential)
      const row = await f.done()
      expect(row.credentialVersion).toBe(2)
      expect(row.healthReason).toBeNull()
      expect(row.refreshFinishedAt).not.toBeNull()
      expect(f.refresh).not.toHaveBeenCalled()
      expect(f.secrets.kvWrite).not.toHaveBeenCalled()
    })

    it('persists ambiguity on equal versions and never repeats the old refresh token', async () => {
      const f = await fixture()
      await db.subscriptionAccount.update({
        where: { id: f.account.id },
        data: { refreshStartedAt: new Date() },
      })
      expect(await f.refresher.refresh(f.account.id, 'auth', 1)).toBeNull()
      expect(await f.refresher.refresh(f.account.id, 'auth', 1)).toBeNull()
      const row = await f.done()
      expect(row.health).toBe('needs_relogin')
      expect(row.healthReason).toBe('refresh_ambiguous')
      expect(row.refreshFinishedAt).toBeNull()
      expect(f.refresh).not.toHaveBeenCalled()
    })

    it('holds a revocation lease while a rotation lease on another account is still held', async () => {
      const locks = new SessionSubscriptionLock(databaseUrl ?? '')
      cleanup.push(() => locks.close())
      const rotation = await locks.tryAcquire(randomUUID())
      const revocation = await locks.tryAcquire(randomUUID())
      expect(rotation).not.toBeNull()
      expect(revocation).not.toBeNull()
      await revocation!.release()
      await rotation!.release()
    })

    it('a final auth refusal and an unknown outcome override a credit warning', async () => {
      for (const outcome of [{ kind: 'final', reason: 'auth' }, { kind: 'ambiguous' }] as const) {
        const f = await fixture()
        await db.subscriptionAccount.update({
          where: { id: f.account.id },
          data: { healthReason: 'credits_balance' },
        })
        f.refresh.mockResolvedValue(outcome)
        // The synthetic adapter must reach the transport, or nothing could have been sent.
        f.backend.refresh = async (credential, http) => {
          await http.request(
            { url: 'https://auth.invalid/token', method: 'POST', headers: new Headers() },
            { signal: AbortSignal.timeout(1_000) },
          )
          return f.refresh(credential, http)
        }
        await f.refresher.refresh(f.account.id, 'scheduled')
        const row = await f.done()
        expect(row).toMatchObject(
          outcome.kind === 'final'
            ? { health: 'needs_relogin', healthReason: 'refresh_auth' }
            : { health: 'ok', healthReason: 'refresh_ambiguous', refreshFinishedAt: null },
        )
      }
    })

    it('extends but never shortens cooling after a region refusal', async () => {
      const f = await fixture()
      const longer = new Date(Date.now() + 5 * 86_400_000)
      await db.subscriptionAccount.update({
        where: { id: f.account.id },
        data: { coolingUntil: longer },
      })
      f.refresh.mockResolvedValue({ kind: 'final', reason: 'region' })
      f.backend.refresh = async (credential, http) => {
        await http.request(
          { url: 'https://auth.invalid/token', method: 'POST', headers: new Headers() },
          { signal: AbortSignal.timeout(1_000) },
        )
        return f.refresh(credential, http)
      }
      await f.refresher.refresh(f.account.id, 'auth', 1)
      const row = await f.done()
      expect(row).toMatchObject({ healthReason: 'refresh_region', coolingUntil: longer })
    })

    it('releases the server-side advisory lock when its connection is destroyed', async () => {
      const f = await fixture()
      const first = await f.locks.tryAcquire(f.account.id)
      expect(first).not.toBeNull()
      const otherPool = new Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 3_000,
      })
      const other = new SessionSubscriptionLock(otherPool)
      cleanup.push(async () => {
        await other.close()
        await otherPool.end()
      })
      expect(await other.tryAcquire(f.account.id)).toBeNull()
      await f.locks.close()
      const recovered = { lease: null as Awaited<ReturnType<typeof other.tryAcquire>> }
      // Destroying the client socket precedes PostgreSQL observing its disconnect.
      await expect
        .poll(
          async () => {
            recovered.lease ??= await other.tryAcquire(f.account.id)
            return recovered.lease !== null
          },
          { timeout: 2000, interval: 20 },
        )
        .toBe(true)
      await recovered.lease!.release()
    })
  },
)
