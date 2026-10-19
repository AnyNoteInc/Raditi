import { createHash } from 'node:crypto'

import { billingFixtures } from '@repo/billing/testing'
import { createPrismaClient, PostgresSiteLeaseStore, type PrismaClient } from '@repo/db'
import {
  releaseReportKey,
  siteAccessPath,
  type ReleaseStep,
  type ReleaseStepDetail,
  type ReleaseStepState,
} from '@repo/domain'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ReleaseSkill } from '../releases/release-skill.ts'
import {
  cleanupReleases,
  FakePlanValues,
  FakeProduction,
  FakeReleaseGit,
  FakeReleaseProvider,
  FakeReleaseStorage,
  FakeReleaseVault,
  releaseFixture,
  type ReleaseFixture,
  type ReleaseFixtureOptions,
} from '../testing/releases.ts'
import { ReleaseApi } from './release-api.service.ts'

// The release API of core on PostgreSQL (docs/plan/53-chat-preview-release.md, Р29–Р32): the
// bearer token of one deploy attempt, a report kept once per key, the barrier of the site as the
// owner of every call, and a backup that counts only once core read it back. The release is
// armed by the real skill with stand-ins of the repository, Vault and S3. Only on a disposable
// database (RADITI_GATEWAY_DB_TESTS=1).
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('the release API with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>
  const sites: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await cleanupReleases(db, sites.splice(0))
    await fixtures.cleanup()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  /** A published release: its tag made, its job about to call. */
  async function published(options: ReleaseFixtureOptions = {}) {
    const f: ReleaseFixture = await releaseFixture(db, fixtures, options)
    sites.push(f.siteId)
    const git = new FakeReleaseGit()
    const vault = new FakeReleaseVault()
    vault.kv.set(siteAccessPath(f.siteId, 'ssh'), {
      data: {
        v: '1',
        host: 'hosting.invalid',
        port: '22',
        hostKey: `ssh-ed25519 SHA256:${'A'.repeat(43)}`,
        rootPath: '/www',
        username: 'deploy',
        auth: 'password',
        password: 'synthetic-password',
      },
      version: 1,
    })
    const storage = new FakeReleaseStorage()
    const skill = new ReleaseSkill({
      db,
      leases: new PostgresSiteLeaseStore(db),
      git,
      provider: new FakeReleaseProvider(),
      secrets: vault,
      storage,
      adapter: getSiteAdapter,
      contentAccessKind: (stack) => getSiteContentAdapter(stack).accessKind,
      api: { startTimeoutMs: 10 * 60_000 },
      values: new FakePlanValues(),
      production: new FakeProduction().resolve,
      previewBaseDomain: null,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    const advance = async () =>
      skill.advance({
        releaseId: f.releaseId,
        seq: (await db.siteRelease.findUniqueOrThrow({ where: { id: f.releaseId } })).enqueues,
      })
    await advance()
    const api = new ReleaseApi({
      db,
      git,
      secrets: vault,
      storage,
      adapter: getSiteAdapter,
      contentAdapter: getSiteContentAdapter,
      publicUrl: 'http://release-api.invalid',
    })
    const auth = `Bearer ${vault.latestToken()}`
    const report = (
      step: ReleaseStep,
      state: ReleaseStepState,
      detail: ReleaseStepDetail = {},
      deployAttempt = 1,
      authorization = auth,
    ) =>
      api.step(f.releaseId, authorization, {
        reportKey: releaseReportKey(deployAttempt, step, state),
        deployAttempt,
        step,
        state,
        detail,
      })
    const facts = (body: Buffer) => ({
      deployAttempt: 1,
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.byteLength,
    })
    const release = () => db.siteRelease.findUniqueOrThrow({ where: { id: f.releaseId } })
    return { f, api, auth, report, facts, storage, release, advance, vault }
  }

  it('answers only the token of the attempt, while it lives', async () => {
    const r = await published()
    await expect(r.api.manifest(r.f.releaseId, undefined)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    await expect(r.api.manifest(r.f.releaseId, `Bearer ${'A'.repeat(43)}`)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    await expect(r.api.manifest(r.f.releaseId, r.auth.toLowerCase())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    // The token of one release does not open another.
    const other = await published()
    await expect(r.api.manifest(other.f.releaseId, r.auth)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    await expect(r.api.manifest('not-a-uuid', r.auth)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    const manifest = await r.api.manifest(r.f.releaseId, r.auth)
    expect(manifest.releaseId).toBe(r.f.releaseId)
    // The check after the writes: the pages of the adapter, and where a created record is served.
    expect(manifest.verify).toMatchObject({
      pages: ['/'],
      recordPages: { page: '/?page_id={id}', post: '/?p={id}' },
    })
    await db.$executeRaw`UPDATE site_releases SET deploy_token_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${r.f.releaseId}::uuid`
    await expect(r.api.manifest(r.f.releaseId, r.auth)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('refuses every call of a release that does not hold the barrier of its site', async () => {
    const r = await published()
    await db.$executeRaw`UPDATE site_leases SET inflight_release_id = NULL WHERE site_id = ${r.f.siteId}::uuid`
    await expect(r.api.manifest(r.f.releaseId, r.auth)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(r.report('conflicts', 'started')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await db.releaseStep.count({ where: { releaseId: r.f.releaseId } })).toBe(0)
  })

  it('keeps a report once per key and answers its repeat as the release stands', async () => {
    const r = await published()
    expect(await r.report('conflicts', 'started')).toEqual({
      status: 200,
      answer: { accepted: true, proceed: true },
    })
    expect(await r.report('conflicts', 'started')).toEqual({
      status: 200,
      answer: { accepted: true, proceed: true },
    })
    expect(await db.releaseStep.count({ where: { releaseId: r.f.releaseId } })).toBe(1)
    const row = await r.release()
    expect(row).toMatchObject({ status: 'deploying', step: 'conflicts' })
    expect(
      await db.deployment.findUniqueOrThrow({ where: { releaseId: r.f.releaseId } }),
    ).toMatchObject({ status: 'running' })
    // A report of the job moves the token's deadline on: the job is alive.
    expect(row.deployTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000)
    // A wake-up of the skill for the move.
    expect(
      await db.outboxEvent.count({
        where: {
          dedupeKey: { startsWith: `release.advance:${r.f.releaseId}:deploying:conflicts:` },
        },
      }),
    ).toBe(1)
  })

  it('takes a repeated report as the heartbeat of the job: the token and the lease live on', async () => {
    const r = await published()
    await r.report('conflicts', 'started')
    const wakes = () =>
      db.outboxEvent.count({
        where: { dedupeKey: { startsWith: `release.advance:${r.f.releaseId}:` } },
      })
    const woken = await wakes()
    const soon = async () => {
      await db.$executeRaw`UPDATE site_releases SET deploy_token_expires_at = clock_timestamp() + interval '1 minute' WHERE id = ${r.f.releaseId}::uuid`
      await db.$executeRaw`UPDATE site_leases SET expires_at = clock_timestamp() + interval '1 minute' WHERE site_id = ${r.f.siteId}::uuid`
    }
    const lease = () => db.siteLease.findUniqueOrThrow({ where: { siteId: r.f.siteId } })
    await soon()
    expect(await r.report('conflicts', 'started')).toEqual({
      status: 200,
      answer: { accepted: true, proceed: true },
    })
    const row = await r.release()
    expect(row).toMatchObject({ status: 'deploying', step: 'conflicts' })
    expect(row.deployTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000)
    expect((await lease()).expiresAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000)
    // Nothing moved: one row, no new wake-up of the skill.
    expect(await db.releaseStep.count({ where: { releaseId: r.f.releaseId } })).toBe(1)
    expect(await wakes()).toBe(woken)
    // A heartbeat of a release that no longer goes on keeps nothing alive.
    await db.$executeRaw`UPDATE site_releases SET status = 'published' WHERE id = ${r.f.releaseId}::uuid`
    await soon()
    expect(await r.report('conflicts', 'started')).toEqual({
      status: 200,
      answer: { accepted: true, proceed: false },
    })
    expect((await r.release()).deployTokenExpiresAt!.getTime()).toBeLessThan(
      Date.now() + 2 * 60_000,
    )
    expect((await lease()).expiresAt!.getTime()).toBeLessThan(Date.now() + 2 * 60_000)
  })

  it('gives the access again to its attempt until the attempt went past its start', async () => {
    const r = await published()
    await r.report('conflicts', 'started')
    const first = await r.api.access(r.f.releaseId, r.auth, { deployAttempt: 1 })
    const issuedAt = (await r.release()).accessIssuedAt
    expect(issuedAt).not.toBeNull()
    // The answer was lost: the same attempt asks again and gets the same.
    expect(await r.api.access(r.f.releaseId, r.auth, { deployAttempt: 1 })).toEqual(first)
    expect((await r.release()).accessIssuedAt).toEqual(issuedAt)
    await expect(r.api.access(r.f.releaseId, r.auth, { deployAttempt: 2 })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await r.report('conflicts', 'succeeded')
    await expect(r.api.access(r.f.releaseId, r.auth, { deployAttempt: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('refuses a report out of its place, of another attempt, or malformed — and keeps none', async () => {
    const r = await published()
    // Nothing to verify before the start.
    expect(await r.report('verify', 'started')).toEqual({
      status: 409,
      answer: { accepted: false, proceed: false },
    })
    expect(await r.report('conflicts', 'started', {}, 2)).toMatchObject({ status: 409 })
    await expect(
      r.api.step(r.f.releaseId, r.auth, {
        reportKey: '1:files:started',
        deployAttempt: 1,
        step: 'conflicts',
        state: 'started',
        detail: {},
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      r.api.step(r.f.releaseId, r.auth, {
        reportKey: releaseReportKey(1, 'conflicts', 'started'),
        deployAttempt: 1,
        step: 'conflicts',
        state: 'started',
        detail: { message: '/www/wp-config.php' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await db.releaseStep.count({ where: { releaseId: r.f.releaseId } })).toBe(0)
    expect((await r.release()).status).toBe('published')
  })

  it('takes the first report before core wrote `published`: the tag started the run', async () => {
    const r = await published()
    await db.$executeRaw`UPDATE site_releases SET status = 'publishing' WHERE id = ${r.f.releaseId}::uuid`
    expect((await r.report('conflicts', 'started')).answer.proceed).toBe(true)
    expect((await r.release()).status).toBe('deploying')
  })

  it('lets nothing be written before core verified the backup it reads back', async () => {
    const r = await published()
    await r.report('conflicts', 'started')
    await r.report('conflicts', 'succeeded')
    await r.report('backup', 'started')
    expect(await r.report('files', 'started')).toMatchObject({ status: 409 })
    const body = Buffer.from('sealed backup of the attempt')
    // Verified before anything was named or uploaded: no.
    expect(
      await r.api.backup(r.f.releaseId, r.auth, { phase: 'verify', ...r.facts(body) }),
    ).toEqual({ phase: 'verify', verified: false })
    const put = await r.api.backup(r.f.releaseId, r.auth, { phase: 'put', ...r.facts(body) })
    expect(put).toMatchObject({ phase: 'put', put: { method: 'PUT' } })
    const key = new URL((put as { put: { url: string } }).put.url).pathname
      .split('/')
      .slice(2)
      .join('/')
    expect(key).toBe(`sites/${r.f.siteId}/${r.f.releaseId}/1/backup.tar.zst.enc`)
    // Another body landed than the one named: refused and deleted, the job may upload again.
    await r.storage.put('backups', key, Buffer.from('something else'))
    expect(
      await r.api.backup(r.f.releaseId, r.auth, { phase: 'verify', ...r.facts(body) }),
    ).toEqual({ phase: 'verify', verified: false })
    expect(r.storage.objects.has(`backups/${key}`)).toBe(false)
    await r.storage.put('backups', key, body)
    // Facts other than the ones named for the upload are never verified.
    expect(
      await r.api.backup(r.f.releaseId, r.auth, {
        phase: 'verify',
        ...r.facts(Buffer.from('another backup')),
      }),
    ).toEqual({ phase: 'verify', verified: false })
    expect(
      await r.api.backup(r.f.releaseId, r.auth, { phase: 'verify', ...r.facts(body) }),
    ).toEqual({ phase: 'verify', verified: true })
    // Asked again after a lost answer: the same answer.
    expect(
      await r.api.backup(r.f.releaseId, r.auth, { phase: 'verify', ...r.facts(body) }),
    ).toEqual({ phase: 'verify', verified: true })
    expect(await r.release()).toMatchObject({
      backupObjectKey: key,
      backupSha256: r.facts(body).sha256,
      backupBytes: BigInt(body.byteLength),
    })
    await expect(
      r.api.backup(r.f.releaseId, r.auth, { phase: 'put', ...r.facts(body) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await r.report('files', 'started')).answer.proceed).toBe(true)
  })

  it('gives no access to the job of a site its client no longer has connected', async () => {
    const r = await published()
    await r.report('conflicts', 'started')
    await db.site.update({ where: { id: r.f.siteId }, data: { status: 'paused' } })
    await expect(r.api.access(r.f.releaseId, r.auth, { deployAttempt: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect((await r.release()).accessIssuedAt).toBeNull()
    // Connected again: the same attempt gets it, once.
    await db.site.update({ where: { id: r.f.siteId }, data: { status: 'active' } })
    expect(await r.api.access(r.f.releaseId, r.auth, { deployAttempt: 1 })).toMatchObject({
      hosting: { method: 'sftp' },
    })
  })

  it('gives the plugin access to a job without records too: it refreshes the code cache (R12)', async () => {
    const r = await published({ contentAccess: true })
    r.vault.kv.set(siteAccessPath(r.f.siteId, 'wp'), {
      data: {
        v: '1',
        origin: 'https://site.invalid',
        username: 'raditi',
        applicationPassword: 'x',
      },
      version: 1,
    })
    await r.report('conflicts', 'started')
    const access = await r.api.access(r.f.releaseId, r.auth, { deployAttempt: 1 })
    expect(access.hosting.method).toBe('sftp')
    expect(access.content).toEqual({
      stack: 'wordpress',
      access: {
        v: '1',
        origin: 'https://site.invalid',
        username: 'raditi',
        applicationPassword: 'x',
      },
    })
  })

  it('stops answering once the release ended', async () => {
    const r = await published()
    await r.report('conflicts', 'started')
    await r.report('conflicts', 'failed', { code: 'hosting_unavailable' })
    expect(await r.release()).toMatchObject({
      status: 'failed',
      errorCode: 'hosting_unavailable',
      deployTokenHash: null,
    })
    await expect(r.api.manifest(r.f.releaseId, r.auth)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })
})
