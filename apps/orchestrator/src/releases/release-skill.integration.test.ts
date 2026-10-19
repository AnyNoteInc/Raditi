import { randomUUID } from 'node:crypto'

import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  insertFeedEvent,
  PostgresSiteLeaseStore,
  resolveRelease,
  type PrismaClient,
} from '@repo/db'
import {
  DEPLOY_WRAP_SECRET_NAME,
  DEPLOY_WRAP_TTL_SECONDS,
  deployValueAad,
  deployWrapDataSchema,
  parseDeployWrap,
  releaseReportKey,
  siteAccessPath,
  siteEnvVarPath,
  siteEnvVarSecret,
  workspaceTransitKey,
  type DbTableState,
  type ReleaseStep,
  type ReleaseStepDetail,
  type ReleaseStepState,
} from '@repo/domain'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { openOperationValue } from '../deploy-step/content.ts'
import { openDeployEnvelope } from '../deploy-step/envelope.ts'
import { newTurnKeys } from '../llm/turn-key.ts'
import { ReleaseApi } from '../release-api/release-api.service.ts'
import {
  CANDIDATE_TREE,
  cleanupReleases,
  FakePlanValues,
  FakeProduction,
  hashedState,
  planCreation,
  planSetting,
  planTable,
  FakeReleaseGit,
  FakeReleaseProvider,
  FakeReleaseStorage,
  FakeReleaseVault,
  INSTALLED_SHA,
  INSTALLED_TREE,
  planOperation,
  releaseFixture,
  type ReleaseFixture,
  type ReleaseFixtureOptions,
} from '../testing/releases.ts'
import { ReleaseSkill, type ReleaseSkillDependencies } from './release-skill.ts'
import {
  RELEASE_PRODUCTION_WAIT_MS,
  RELEASE_PUBLISH_GIVE_UP_MS,
  RELEASE_SITE_WAIT_MS,
} from './release-row.ts'

// The release skill of core on PostgreSQL with the credits of @repo/billing (docs/plan/53-chat-
// preview-release.md, Р25–Р33): every step from the confirmation to the outcome, with the
// repository, the provider, Vault and S3 as stand-ins that can lose an answer, and the deploy
// job played through the release API. Only on a disposable database (RADITI_GATEWAY_DB_TESTS=1),
// as the other suites that write the reserves of whole workspaces.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const RELEASE_API_URL = 'http://release-api.invalid'
const WP_ACCESS = {
  v: '1',
  origin: 'https://site.invalid',
  username: 'raditi',
  applicationPassword: 'x',
}

const SSH_ACCESS = {
  v: '1',
  host: 'hosting.invalid',
  port: '22',
  hostKey: `ssh-ed25519 SHA256:${'A'.repeat(43)}`,
  rootPath: '/www',
  username: 'deploy',
  auth: 'password',
  password: 'synthetic-password',
}

describe.skipIf(!enabled)('the release skill with PostgreSQL', () => {
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

  interface World {
    f: ReleaseFixture
    git: FakeReleaseGit
    provider: FakeReleaseProvider
    vault: FakeReleaseVault
    storage: FakeReleaseStorage
    values: FakePlanValues
    production: FakeProduction
    skill: ReleaseSkill
    /** What the skill was made with: another skill of the same core is made from it. */
    deps: ReleaseSkillDependencies
    api: ReleaseApi
    logger: {
      log: ReturnType<typeof vi.fn>
      warn: ReturnType<typeof vi.fn>
      error: ReturnType<typeof vi.fn>
    }
    now: { at: Date }
  }

  async function world(
    options: ReleaseFixtureOptions & { gitOff?: boolean; noValues?: boolean } = {},
  ): Promise<World> {
    const f = await releaseFixture(db, fixtures, options)
    sites.push(f.siteId)
    const git = new FakeReleaseGit()
    const provider = new FakeReleaseProvider()
    const vault = new FakeReleaseVault()
    vault.kv.set(siteAccessPath(f.siteId, 'ssh'), { data: SSH_ACCESS, version: 1 })
    const storage = new FakeReleaseStorage()
    const values = new FakePlanValues()
    const production = new FakeProduction()
    production.holdsBaseOf(options.dbPlan ?? [])
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const now = { at: new Date() }
    const deps: ReleaseSkillDependencies = {
      db,
      leases: new PostgresSiteLeaseStore(db),
      git: options.gitOff ? null : git,
      provider,
      secrets: vault,
      storage,
      adapter: getSiteAdapter,
      contentAccessKind: (stack) => getSiteContentAdapter(stack).accessKind,
      api: { startTimeoutMs: 10 * 60_000 },
      values: options.noValues ? null : values,
      production: production.resolve,
      previewBaseDomain: 'preview.example.test',
      logger,
      now: () => now.at,
    }
    const skill = new ReleaseSkill(deps)
    const api = new ReleaseApi({
      db,
      git,
      secrets: vault,
      storage,
      adapter: getSiteAdapter,
      contentAdapter: getSiteContentAdapter,
      publicUrl: RELEASE_API_URL,
    })
    return { f, git, provider, vault, storage, values, production, skill, deps, api, logger, now }
  }

  const release = (w: World) => db.siteRelease.findUniqueOrThrow({ where: { id: w.f.releaseId } })
  const taskStatus = async (w: World) =>
    (await db.task.findUniqueOrThrow({ where: { id: w.f.taskId } })).status
  const lease = (w: World) => db.siteLease.findUnique({ where: { siteId: w.f.siteId } })
  const holds = async (w: World) =>
    (await db.creditHold.findMany({ where: { taskId: w.f.taskId } })).map((hold) => hold.status)
  const feed = async (w: World) =>
    (
      await db.taskEvent.findMany({
        where: { taskId: w.f.taskId, type: 'feed.release' },
        orderBy: { id: 'asc' },
      })
    ).map((row) => row.payload)
  /** One run of `release.advance`, as the latest wake-up of the release. */
  const advance = async (w: World) =>
    w.skill.advance({ releaseId: w.f.releaseId, seq: (await release(w)).enqueues })
  /** The deadline of the token has passed: what minutes of silence do. */
  const silence = (w: World) =>
    db.$executeRaw`UPDATE site_releases SET deploy_token_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${w.f.releaseId}::uuid AND deploy_token_expires_at IS NOT NULL`
  /** The deadline of the token is a minute away: core asks the provider about the run. */
  const nearDeadline = (w: World) =>
    db.$executeRaw`UPDATE site_releases SET deploy_token_expires_at = clock_timestamp() + interval '1 minute' WHERE id = ${w.f.releaseId}::uuid AND deploy_token_expires_at IS NOT NULL`
  /** The wait of the latest wake-up of the release, from the skill's clock. */
  const latestWait = async (w: World) => {
    const wakes = await db.outboxEvent.findMany({
      where: { dedupeKey: { startsWith: `release.advance:${w.f.releaseId}:` } },
      select: { dedupeKey: true, availableAt: true },
    })
    const latest = wakes.sort(
      (a, b) => Number(b.dedupeKey!.split(':').at(-1)) - Number(a.dedupeKey!.split(':').at(-1)),
    )[0]!
    return latest.availableAt.getTime() - w.now.at.getTime()
  }

  /** A synthetic value of a client's variable and the variable that holds it (R10). */
  const CLIENT_VALUE = 'synthetic-client-value-42'
  async function clientVariable(w: World, value = CLIENT_VALUE) {
    await db.siteEnvVar.create({ data: { siteId: w.f.siteId, name: 'API_TOKEN', keyVersion: 1 } })
    w.vault.kv.set(siteEnvVarPath(w.f.siteId, 'API_TOKEN'), {
      data: siteEnvVarSecret(value),
      version: 1,
    })
  }

  /** The deploy job of the latest armed attempt, through the release API. */
  function job(w: World) {
    const token = w.vault.latestToken()
    const auth = `Bearer ${token}`
    const attempt = Number(w.vault.wrappings.at(-1)!.data.attempt)
    return {
      auth,
      attempt,
      report: (step: ReleaseStep, state: ReleaseStepState, detail: ReleaseStepDetail = {}) =>
        w.api.step(w.f.releaseId, auth, {
          reportKey: releaseReportKey(attempt, step, state),
          deployAttempt: attempt,
          step,
          state,
          detail,
        }),
      manifest: () => w.api.manifest(w.f.releaseId, auth),
      access: () => w.api.access(w.f.releaseId, auth, { deployAttempt: attempt }),
      /** Uploads a backup and asks core to verify it. */
      backup: async (body = Buffer.from('sealed backup')) => {
        const { createHash } = await import('node:crypto')
        const facts = {
          deployAttempt: attempt,
          sha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.byteLength,
        }
        const put = await w.api.backup(w.f.releaseId, auth, { phase: 'put', ...facts })
        if (put.phase !== 'put') throw new Error('expected a PUT')
        const key = new URL(put.put.url).pathname.split('/').slice(2).join('/')
        await w.storage.put('backups', key, body)
        return w.api.backup(w.f.releaseId, auth, { phase: 'verify', ...facts })
      },
    }
  }

  /** From the confirmation to a published release whose job may start. */
  async function published(w: World) {
    await advance(w)
    expect(await release(w)).toMatchObject({ status: 'published' })
  }

  /** The job writes and checks: the release ends `installed` on its last report. */
  async function deployed(w: World) {
    const run = job(w)
    expect(await run.report('conflicts', 'started')).toMatchObject({
      status: 200,
      answer: { accepted: true, proceed: true },
    })
    await run.access()
    expect((await run.report('conflicts', 'succeeded', { files: 2 })).answer.proceed).toBe(true)
    await run.report('backup', 'started')
    expect(await run.backup()).toEqual({ phase: 'verify', verified: true })
    await run.report('backup', 'succeeded', { files: 2, bytes: 13 })
    await run.report('files', 'started')
    await run.report('files', 'succeeded', { files: 2 })
    await run.report('verify', 'started')
    return run
  }

  it('publishes, deploys and installs: the version, the barrier, the dialog and its charge', async () => {
    const w = await world()
    await published(w)

    // The release commit: the candidate's tree on top of `main`, stored before the push.
    const row = await release(w)
    expect(row.approvedSha).toBe(w.git.main)
    expect(w.git.trees.get(row.approvedSha!)).toBe(CANDIDATE_TREE)
    expect(w.git.parents.get(row.approvedSha!)).toBe(INSTALLED_SHA)
    // The lease acquired at the readiness (epoch 1) was taken over by the publishing step.
    expect(row).toMatchObject({ mainBeforeSha: INSTALLED_SHA, deployAttempt: 1, leaseEpoch: 2 })
    expect(row.mainPushedAt).toBeInstanceOf(Date)
    // `v*` belongs to the release account; the secret is set before the tag that starts the run.
    expect(w.provider.protectedPatterns).toEqual(['v*'])
    expect(w.provider.calls).toEqual(['protectTags', 'setActionsSecret', 'createTag'])
    expect(w.provider.tags.get('v0.1.0')).toBe(row.approvedSha)
    // The wrapping: the API token of this attempt and the backup key, 30 minutes.
    const wrapping = w.vault.wrappings[0]!
    expect(wrapping.ttl).toBe(DEPLOY_WRAP_TTL_SECONDS)
    const data = deployWrapDataSchema.parse(wrapping.data)
    expect(data).toMatchObject({ releaseId: w.f.releaseId, attempt: '1' })
    expect(row.wrapAccessor).toBe(wrapping.accessor)
    expect(row.deployTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(parseDeployWrap(w.provider.secrets.get(DEPLOY_WRAP_SECRET_NAME)!)).toEqual({
      releaseId: w.f.releaseId,
      attempt: 1,
      tag: 'v0.1.0',
      sha: row.approvedSha,
      wrapToken: wrapping.token,
    })
    // The backup key is kept only as Transit wrapped it.
    const keyObject = [...w.storage.objects.keys()].find((key) => key.endsWith('/1/backup.key'))!
    expect(JSON.parse(w.storage.objects.get(keyObject)!.toString())).toMatchObject({
      v: 1,
      key: expect.stringContaining(`vault:v1:${workspaceTransitKey(w.f.workspaceId)}`),
    })
    expect(await lease(w)).toMatchObject({
      operation: 'deploy',
      holderTaskId: w.f.taskId,
      inflightReleaseId: w.f.releaseId,
    })
    expect(
      await db.deployment.findUniqueOrThrow({ where: { releaseId: w.f.releaseId } }),
    ).toMatchObject({ status: 'pending', commitSha: row.approvedSha, tag: 'v0.1.0' })

    const run = await deployed(w)
    expect(await taskStatus(w)).toBe('verifying')
    expect(await run.report('verify', 'succeeded', { pages: 1 })).toMatchObject({
      answer: { accepted: true, proceed: false },
    })
    expect((await release(w)).status).toBe('installed')
    await advance(w)

    expect(await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).toMatchObject({
      installedVersion: 'v0.1.0',
      installedSha: row.approvedSha,
      installedReleaseId: w.f.releaseId,
    })
    expect(
      (await db.taskCandidate.findUniqueOrThrow({ where: { id: w.f.candidateId } })).status,
    ).toBe('released')
    // The way in is closed, the site is free, the dialog done and charged by its usage.
    expect(w.provider.secrets.has(DEPLOY_WRAP_SECRET_NAME)).toBe(false)
    expect(w.vault.revoked).toContain(wrapping.accessor)
    expect(await lease(w)).toMatchObject({
      holderTaskId: null,
      operation: null,
      inflightReleaseId: null,
    })
    expect(await taskStatus(w)).toBe('done')
    expect(await holds(w)).not.toContain('active')
    expect(await feed(w)).toEqual([
      {
        v: 1,
        releaseId: w.f.releaseId,
        version: 'v0.1.0',
        outcome: 'installed',
        reason: null,
        credits: null,
      },
    ])
    expect(
      await db.deployment.findUniqueOrThrow({ where: { releaseId: w.f.releaseId } }),
    ).toMatchObject({ status: 'succeeded' })
    // `main` is what the hosting holds: no revert after `installed`.
    expect(w.git.main).toBe(row.approvedSha)
    expect((await release(w)).revertSha).toBeNull()
    // A late wake-up changes nothing.
    await advance(w)
    expect(await feed(w)).toHaveLength(1)
  })

  it('seals the values of the database plan for the attempt; the manifest hands them over', async () => {
    const { operation, state } = planOperation()
    const w = await world({ dbPlan: [operation], contentAccess: true })
    w.values.states.set(operation.objectRef, state)
    w.vault.kv.set(siteAccessPath(w.f.siteId, 'wp'), { data: WP_ACCESS, version: 1 })
    await published(w)
    const run = job(w)
    const manifest = await run.manifest()
    expect(manifest).toMatchObject({
      releaseId: w.f.releaseId,
      deployAttempt: 1,
      tag: 'v0.1.0',
      installedSha: null,
      method: 'sftp',
      contentEpoch: (await release(w)).leaseEpoch,
      rollbackOf: null,
      files: {
        write: [{ path: 'wp-content/themes/site/header.php', before: 'c'.repeat(64) }],
        delete: [{ path: 'wp-content/themes/site/old.css', before: 'e'.repeat(64) }],
      },
    })
    expect(manifest.verify.pages.length).toBeGreaterThan(0)
    expect(manifest.verify.origin).toBe(
      new URL((await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).url).origin,
    )
    expect(manifest.db).toHaveLength(1)
    expect(manifest.db[0]!.operation).toEqual(operation)
    // The value is the release API's to hand out, with the job's own token, on each call: it
    // does not expire while the job reads the hosting first.
    expect(manifest.db[0]!.after).toEqual({
      method: 'GET',
      url: `${RELEASE_API_URL}/v1/releases/${w.f.releaseId}/values/0`,
      headers: { authorization: run.auth },
      expiresAt: expect.any(String),
    })
    expect(w.storage.presigned.filter((request) => request.key.includes('/db/'))).toEqual([])
    // What the job opens with the key of its wrapping: exactly the fields of the operation.
    const key = Buffer.from(
      deployWrapDataSchema.parse(w.vault.wrappings[0]!.data).backupKey,
      'base64',
    )
    const sealed = await w.api.value(w.f.releaseId, run.auth, '0')
    expect(sealed).toEqual(
      w.storage.objects.get(`backups/sites/${w.f.siteId}/${w.f.releaseId}/1/db/0.bin`),
    )
    await expect(w.api.value(w.f.releaseId, run.auth, '1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(w.api.value(w.f.releaseId, undefined, '0')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    const opened = openDeployEnvelope(
      sealed,
      key,
      deployValueAad(w.f.releaseId, operation.objectRef, operation.afterHash),
    )
    expect(JSON.parse(opened.toString('utf8'))).toEqual({ v: 1, fields: { title: state.title } })
    // Another object's associated data does not open it.
    expect(() =>
      openDeployEnvelope(
        sealed,
        key,
        deployValueAad(w.f.releaseId, 'page:43', operation.afterHash),
      ),
    ).toThrow()
    // The access of the hosting and of the plugin, after the start; asked again (an answer lost)
    // before the attempt went past its start — the same; after — never again.
    await expect(run.access()).rejects.toMatchObject({ code: 'CONFLICT' })
    await run.report('conflicts', 'started')
    const access = await run.access()
    expect(access).toMatchObject({
      hosting: { method: 'sftp', access: { host: 'hosting.invalid', auth: 'password' } },
      content: { stack: 'wordpress', access: { username: 'raditi' } },
    })
    expect(await run.access()).toEqual(access)
    await run.report('conflicts', 'succeeded')
    await expect(run.access()).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('seals a value of every kind of a plan; the job opens each as its kind', async () => {
    const table = planTable()
    const setting = planSetting()
    const creation = planCreation('prices')
    const text = planOperation()
    const plan = [table, setting, creation, text]
    const w = await world({ dbPlan: plan.map(({ operation }) => operation), contentAccess: true })
    for (const { operation, state, before } of plan) {
      w.values.states.set(operation.objectRef, state)
      w.values.befores.set(operation.objectRef, before)
    }
    w.vault.kv.set(siteAccessPath(w.f.siteId, 'wp'), { data: WP_ACCESS, version: 1 })
    await published(w)
    const run = job(w)
    const manifest = await run.manifest()
    expect(manifest.db.map(({ operation }) => operation.kind)).toEqual([
      'schema_migration',
      'option_update',
      'post_create',
      'content_update',
    ])
    const key = Buffer.from(
      deployWrapDataSchema.parse(w.vault.wrappings[0]!.data).backupKey,
      'base64',
    )
    const opened = await Promise.all(
      manifest.db.map(async ({ operation }, index) =>
        openOperationValue(
          await w.api.value(w.f.releaseId, run.auth, String(index)),
          key,
          w.f.releaseId,
          operation,
        ),
      ),
    )
    expect(opened).toEqual([
      {
        v: 1,
        before: { exists: false, managed: false, definition: null },
        definition: table.state.definition,
      },
      { v: 1, value: setting.state.value },
      {
        v: 1,
        record: {
          status: 'publish',
          slug: 'prices',
          title: creation.state.title,
          content: creation.state.content,
          excerpt: '',
        },
      },
      { v: 1, fields: { title: text.state.title } },
    ])
  })

  describe('refused before `main` moves', () => {
    async function refused(w: World, code: string, reason: string | null) {
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'failed', errorCode: code, mainPushedAt: null })
      expect(w.git.main).toBe(INSTALLED_SHA)
      expect(w.git.pushes).toEqual([])
      expect(await taskStatus(w)).toBe('awaiting_approval')
      expect(await holds(w)).toEqual(['active'])
      expect(await feed(w)).toEqual([
        {
          v: 1,
          releaseId: w.f.releaseId,
          version: 'v0.1.0',
          outcome: 'refused',
          reason,
          credits: null,
        },
      ])
      const site = await lease(w)
      expect(site?.inflightReleaseId ?? null).toBeNull()
      expect(site?.holderTaskId ?? null).toBeNull()
    }

    it('when the approver is no longer an owner or an admin', async () => {
      await refused(await world({ role: 'member' }), 'not_allowed', 'not_allowed')
    })

    it('when `main` stands on another tree than the candidate', async () => {
      const w = await world({ baseTree: '7'.repeat(40) })
      await refused(w, 'candidate_outdated', 'outdated')
      // The dialog is offered «Обновить» now, not the same refused `/release` again.
      expect(
        (await db.taskCandidate.findUniqueOrThrow({ where: { id: w.f.candidateId } })).status,
      ).toBe('stale')
    })

    it('when the candidate changes a path publication could not have written (rule 6)', async () => {
      for (const candidatePath of ['.gitea/workflows/deploy.yml', 'wp-config.php'])
        await refused(await world({ candidatePath }), 'forbidden_path', 'technical')
    })

    it('when a check of the candidate failed', async () => {
      await refused(await world({ failedCheck: true }), 'checks_failed', 'checks_failed')
    })

    it('when the site has no access of its hosting', async () => {
      await refused(await world({ noHostingAccess: true }), 'hosting_unsupported', 'technical')
    })

    it('when git is not configured', async () => {
      await refused(await world({ gitOff: true }), 'releases_off', 'technical')
    })

    it('when the plan of the database cannot be delivered', async () => {
      const { operation } = planOperation()
      await refused(
        await world({ dbPlan: [operation], contentAccess: true, noValues: true }),
        'db_plan_unsupported',
        'technical',
      )
    })

    it('when a value of the plan does not read back', async () => {
      const { operation } = planOperation()
      // The reader knows no state of the object: the value failed verification.
      await refused(
        await world({ dbPlan: [operation], contentAccess: true }),
        'db_plan_unsupported',
        'technical',
      )
    })

    it('when another release of the site is under way', async () => {
      const w = await world()
      const other = await releaseFixture(db, fixtures, { version: 'v0.2.0' })
      sites.push(other.siteId)
      // The same site: the other release is publishing on it.
      await db.$executeRaw`UPDATE site_releases SET site_id = ${w.f.siteId}::uuid, status = 'publishing' WHERE id = ${other.releaseId}::uuid`
      await refused(w, 'release_in_progress', 'technical')
    })

    it('when the site is no longer active', async () => {
      await refused(await world({ siteStatus: 'paused' }), 'site_inactive', 'site_inactive')
    })

    it('when a value of the plan holds the value of a client variable', async () => {
      const { operation, state } = planOperation('page:42', { title: `Ключ ${CLIENT_VALUE}` })
      const w = await world({ dbPlan: [operation], contentAccess: true })
      w.values.states.set(operation.objectRef, state)
      await clientVariable(w)
      await refused(w, 'client_variable', 'client_variable')
    })

    it("when a new page's address or a name of a table holds the value of a client variable", async () => {
      // The value as an address: a UUID passes for one.
      const uuid = '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b'
      const creation = planCreation(uuid)
      const page = await world({ dbPlan: [creation.operation], contentAccess: true })
      page.values.states.set(creation.operation.objectRef, creation.state)
      await clientVariable(page, uuid)
      await refused(page, 'client_variable', 'client_variable')
      // The value as the name of a column or an index: the plugin would create them as they are.
      const hex = 'deadbeefcafe0042'
      for (const definition of [
        { columns: [{ name: hex, type: 'integer' as const, nullable: true }], indexes: [] },
        {
          columns: [{ name: 'n', type: 'integer' as const, nullable: true }],
          indexes: [{ name: hex, columns: ['n'], unique: false }],
        },
      ]) {
        const table = planTable()
        const state = hashedState<DbTableState>({ ...table.state, definition })
        const operation = { ...table.operation, afterHash: state.stateHash }
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, state)
        w.values.befores.set(operation.objectRef, table.before)
        await clientVariable(w, hex)
        await refused(w, 'client_variable', 'client_variable')
      }
    })

    it('when a value of the plan names a preview or holds a turn credential', async () => {
      // The preview runs the agent's code: what its plugin said it stored is checked again.
      for (const title of [
        'См. https://site-ffff1111-chat-ffff11.preview.example.test/about/',
        `Ключ ${newTurnKeys().mcpToken}`,
      ]) {
        const { operation, state } = planOperation('page:42', { title })
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, state)
        await refused(w, 'content_refused', 'technical')
      }
    })

    it('when the plan holds a value the client has just changed (any Vault version)', async () => {
      const { operation, state } = planOperation('page:42', { title: `Ключ ${CLIENT_VALUE}` })
      const w = await world({ dbPlan: [operation], contentAccess: true })
      w.values.states.set(operation.objectRef, state)
      // The row still names version 1; Vault already holds the client's new value at version 2.
      await db.siteEnvVar.create({ data: { siteId: w.f.siteId, name: 'API_TOKEN', keyVersion: 1 } })
      w.vault.kv.set(siteEnvVarPath(w.f.siteId, 'API_TOKEN'), {
        data: siteEnvVarSecret(CLIENT_VALUE),
        version: 2,
      })
      await refused(w, 'client_variable', 'client_variable')
    })

    it('when git refuses for good', async () => {
      const w = await world()
      w.git.fail.set('readBranchHead', 'final')
      await refused(w, 'repository_refused', 'technical')
    })

    it('when the release account has no token: `v*` is protected before `main` moves', async () => {
      const w = await world()
      w.provider.fail.set('protectTags', 'not_configured')
      await refused(w, 'tag_refused', 'technical')
      expect(w.provider.calls).toEqual([])
    })

    it('when the provider refuses the protection of `v*` for good', async () => {
      const w = await world()
      w.provider.fail.set('protectTags', 'final')
      await refused(w, 'tag_refused', 'technical')
    })

    it('when it could not start for two hours', async () => {
      const w = await world()
      w.git.fail.set('readBranchHead', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'approved' })
      w.now.at = new Date(w.now.at.getTime() + RELEASE_PUBLISH_GIVE_UP_MS + 60_000)
      await refused(w, 'publish_timeout', 'technical')
    })

    it('when `main` moved between the readiness and the push', async () => {
      const w = await world()
      w.git.fail.set('trustedCommit', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'publishing', approvedSha: null })
      w.git.moveMain()
      // The trees were compared under the lease; the push is by CAS against `main` as found.
      await advance(w)
      expect(await release(w)).toMatchObject({
        status: 'failed',
        errorCode: 'main_moved',
        mainPushedAt: null,
        revertSha: null,
      })
      expect(await taskStatus(w)).toBe('awaiting_approval')
      expect((await feed(w))[0]).toMatchObject({ outcome: 'refused', reason: 'outdated' })
      expect((await lease(w))?.inflightReleaseId).toBeNull()
    })

    describe('when the database plan does not fit production (docs/plan/53, «Операции БД и миграции»)', () => {
      it('its plugin cannot write a kind of the plan', async () => {
        const { operation, state } = planSetting()
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, state)
        w.production.capabilities = {
          ...w.production.capabilities,
          operations: ['content_update'],
        }
        await refused(w, 'plugin_outdated', 'plugin_outdated')
      })

      it('its plugin does not keep a setting of the plan', async () => {
        const { operation, state } = planSetting('posts_per_page', '12')
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, state)
        await refused(w, 'plugin_outdated', 'plugin_outdated')
      })

      it('an object of the plan changed on production', async () => {
        const { operation, state } = planOperation()
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, state)
        w.production.states.set(operation.objectRef, { stateHash: '9'.repeat(64) })
        await refused(w, 'db_conflict', 'conflict')
      })

      it('the address of a new page is taken on production', async () => {
        const { operation, state } = planCreation('prices')
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, state)
        w.production.taken.add('page/prices')
        await refused(w, 'slug_taken', 'slug_taken')
        // Nothing of production was taken in the meantime: no tag, no secret, no wrapping.
        expect(w.provider.tags.size).toBe(0)
        expect(w.vault.wrappings).toEqual([])
      })

      it("a value names the preview's number of a new page of the plan", async () => {
        const creation = planCreation('prices')
        const text = planOperation('page:42', { title: 'См. ?page_id=1000000001' })
        const w = await world({
          dbPlan: [creation.operation, text.operation],
          contentAccess: true,
        })
        w.values.states.set(creation.operation.objectRef, creation.state)
        w.values.states.set(text.operation.objectRef, text.state)
        await refused(w, 'created_id_in_code', 'created_id_in_code')
      })

      it("a changed file names the preview's number of a new page", async () => {
        const { operation, state } = planCreation('prices')
        const w = await world({
          dbPlan: [operation],
          contentAccess: true,
          facts: { createdIdFiles: 1 },
        })
        w.values.states.set(operation.objectRef, state)
        await refused(w, 'created_id_in_code', 'created_id_in_code')
      })

      it('the description the client confirms is missing', async () => {
        const { operation, state } = planOperation()
        const w = await world({ dbPlan: [operation], contentAccess: true, dbView: null })
        w.values.states.set(operation.objectRef, state)
        await refused(w, 'values_unavailable', 'values_unavailable')
      })

      it('a table of the plan is not an addition', async () => {
        const table = planTable()
        // Its `before` says a table of the site the platform did not make.
        const foreign = hashedState<DbTableState>({
          ...table.before,
          exists: true,
          managed: false,
        })
        const operation = { ...table.operation, beforeHash: foreign.stateHash }
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, table.state)
        w.values.befores.set(operation.objectRef, foreign)
        await refused(w, 'db_plan_unsupported', 'technical')
      })

      it('production does not answer: the site is not taken, and the release gives up later', async () => {
        const { operation, state } = planOperation()
        const w = await world({ dbPlan: [operation], contentAccess: true })
        w.values.states.set(operation.objectRef, state)
        w.production.unreachable = true
        await advance(w)
        expect(await release(w)).toMatchObject({ status: 'approved', leaseEpoch: 0 })
        expect((await lease(w))?.holderTaskId ?? null).toBeNull()
        expect(w.git.pushes).toEqual([])
        expect(await latestWait(w)).toBeGreaterThan(0)
        w.now.at = new Date(w.now.at.getTime() + RELEASE_PRODUCTION_WAIT_MS + 1000)
        await refused(w, 'site_unreachable', 'site_unreachable')
      })
    })
  })

  it('waits for a site a turn holds, and gives up after an hour', async () => {
    const w = await world()
    const turn = await new PostgresSiteLeaseStore(db).acquire({
      siteId: w.f.siteId,
      taskId: w.f.taskId,
      operation: 'turn',
      ttlMs: 60_000,
    })
    expect(turn).not.toBeNull()
    await advance(w)
    expect((await release(w)).status).toBe('approved')
    expect(w.logger.warn).toHaveBeenCalledWith(expect.stringContaining('reason=site_busy'))
    w.now.at = new Date(Date.now() + RELEASE_SITE_WAIT_MS + 60_000)
    await advance(w)
    expect(await release(w)).toMatchObject({ status: 'failed', errorCode: 'site_busy' })
    expect(await taskStatus(w)).toBe('awaiting_approval')
    // The turn keeps its lease.
    expect(await lease(w)).toMatchObject({ operation: 'turn', epoch: turn!.epoch })
  })

  describe('a refusal before the barrier leaves the site free', () => {
    it('releases switched off after a run recorded its lease: the lease is taken and freed', async () => {
      const w = await world()
      // A run got the site and stopped: `main` did not answer.
      w.git.fail.set('readBranchHead', 'before')
      await advance(w)
      const first = await release(w)
      expect(first).toMatchObject({ status: 'approved' })
      expect(first.leaseEpoch).toBeGreaterThan(0)
      expect(await lease(w)).toMatchObject({ operation: 'deploy' })
      // core restarts without git: the release is refused, and the site is not held by a lease
      // nobody will ever use.
      const off = new ReleaseSkill({ ...w.deps, git: null })
      await off.advance({ releaseId: w.f.releaseId, seq: (await release(w)).enqueues })
      expect(await release(w)).toMatchObject({ status: 'failed', errorCode: 'releases_off' })
      expect((await lease(w))?.holderTaskId ?? null).toBeNull()
    })

    it('a run that waited for the site does not refuse a release another run has just got', async () => {
      const w = await world()
      // An hour of waiting is over; meanwhile another run of the same release got the site and
      // recorded its lease right after this one read the row.
      w.now.at = new Date(Date.now() + RELEASE_SITE_WAIT_MS + 60_000)
      const lost = new ReleaseSkill({
        ...w.deps,
        leases: {
          acquire: async () => {
            await db.$executeRaw`UPDATE site_releases SET lease_epoch = 41 WHERE id = ${w.f.releaseId}::uuid`
            return null
          },
          release: async () => false,
        },
      })
      await lost.advance({ releaseId: w.f.releaseId, seq: (await release(w)).enqueues })
      expect(await release(w)).toMatchObject({
        status: 'approved',
        leaseEpoch: 41,
        errorCode: null,
      })
    })

    it('a run whose release moved on before its readiness gives back the site it got', async () => {
      const w = await world()
      // Another run refused the release while this one was reading `main`.
      const read = w.git.readBranchHead
      w.git.readBranchHead = async (input) => {
        await db.$executeRaw`UPDATE site_releases SET status = 'failed', error_code = 'site_busy' WHERE id = ${w.f.releaseId}::uuid`
        return read(input)
      }
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'failed', errorCode: 'site_busy' })
      expect((await lease(w))?.holderTaskId ?? null).toBeNull()
    })
  })

  describe('lost answers while publishing', () => {
    it('a commit that did not answer is built again: the same SHA', async () => {
      const w = await world()
      w.git.fail.set('trustedCommit', 'after')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'publishing', approvedSha: null })
      await advance(w)
      const row = await release(w)
      expect(row.status).toBe('published')
      expect(w.git.pushes).toEqual([row.approvedSha])
    })

    it('a push whose answer was lost is read back from `main`', async () => {
      const w = await world()
      w.git.fail.set('pushTrustedCommit', 'after')
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'published' })
      expect(row.mainPushedAt).toBeInstanceOf(Date)
      expect(w.git.main).toBe(row.approvedSha)
    })

    it('a push that did not happen is tried again later, never guessed', async () => {
      const w = await world()
      w.git.fail.set('pushTrustedCommit', 'before')
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'publishing', mainPushedAt: null })
      expect(row.approvedSha).not.toBeNull()
      expect(w.git.main).toBe(INSTALLED_SHA)
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'published', approvedSha: row.approvedSha })
    })

    it('a tag whose answer was lost is found: the armed attempt stays', async () => {
      const w = await world()
      w.provider.fail.set('createTag', 'after')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'publishing', deployAttempt: 1 })
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'published', deployAttempt: 1 })
      expect(w.vault.wrappings).toHaveLength(1)
      expect(w.vault.revoked).toEqual([])
    })

    it('a secret that was not set arms a new attempt and revokes the old wrapping', async () => {
      const w = await world()
      w.provider.fail.set('setActionsSecret', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'publishing', deployAttempt: 1 })
      expect(w.provider.tags.size).toBe(0)
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'published', deployAttempt: 2 })
      expect(w.vault.revoked).toEqual([w.vault.wrappings[0]!.accessor])
      expect(row.wrapAccessor).toBe(w.vault.wrappings[1]!.accessor)
      expect(parseDeployWrap(w.provider.secrets.get(DEPLOY_WRAP_SECRET_NAME)!)?.attempt).toBe(2)
    })

    it('a wrapping that did not answer is made again for the next attempt', async () => {
      const w = await world()
      w.vault.fail.set('wrap', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({
        status: 'publishing',
        deployAttempt: 1,
        wrapAccessor: null,
      })
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'published', deployAttempt: 2 })
      expect(w.provider.calls.filter((call) => call === 'createTag')).toHaveLength(1)
    })

    it('a wrapping made whose answer was lost is never handed out: the next attempt arms', async () => {
      const w = await world()
      w.vault.fail.set('wrap', 'after')
      await advance(w)
      expect(await release(w)).toMatchObject({
        status: 'publishing',
        deployAttempt: 1,
        wrapAccessor: null,
        deployTokenHash: null,
      })
      expect(w.vault.wrappings).toHaveLength(1)
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'published', deployAttempt: 2 })
      // The secret names the second wrapping; the first expires unused within 30 minutes.
      expect(parseDeployWrap(w.provider.secrets.get(DEPLOY_WRAP_SECRET_NAME)!)?.wrapToken).toBe(
        w.vault.wrappings[1]!.token,
      )
      expect(row.wrapAccessor).toBe(w.vault.wrappings[1]!.accessor)
    })

    it('a secret that keeps failing is tried again later each time', async () => {
      const w = await world()
      w.provider.fail.set('setActionsSecret', 'before')
      await advance(w)
      expect(await latestWait(w)).toBe(30_000)
      w.provider.fail.set('setActionsSecret', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'publishing', deployAttempt: 2 })
      expect(await latestWait(w)).toBe(60_000)
      w.provider.fail.set('setActionsSecret', 'before')
      await advance(w)
      expect(await latestWait(w)).toBe(120_000)
    })

    it('a tag taken by another commit burns the version: `main` gets the revert commit', async () => {
      const w = await world()
      w.provider.tags.set('v0.1.0', '6'.repeat(40))
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'failed', errorCode: 'tag_taken' })
      expect(row.mainPushedAt).toBeInstanceOf(Date)
      // Р27: `main` equals what the hosting holds again, on top of the release commit.
      expect(row.revertSha).toBe(w.git.main)
      expect(w.git.parents.get(row.revertSha!)).toBe(row.approvedSha)
      expect(w.git.trees.get(row.revertSha!)).toBe(INSTALLED_TREE)
      expect(await taskStatus(w)).toBe('awaiting_approval')
      expect((await feed(w))[0]).toMatchObject({ outcome: 'failed', reason: 'technical' })
      expect(w.provider.tags.get('v0.1.0')).toBe('6'.repeat(40))
      expect((await lease(w))?.inflightReleaseId).toBeNull()
    })
  })

  it('a job that does not start in time is revoked: nothing written, `main` reverted', async () => {
    const w = await world()
    await published(w)
    const row = await release(w)
    // Not yet: the latest wake-up waits for the deadline.
    await advance(w)
    expect((await release(w)).status).toBe('published')
    await silence(w)
    await advance(w)
    expect(await release(w)).toMatchObject({
      status: 'failed',
      errorCode: 'start_timeout',
      deployTokenHash: null,
      revertSha: w.git.main,
    })
    expect(w.vault.revoked).toEqual([row.wrapAccessor])
    expect(w.provider.secrets.has(DEPLOY_WRAP_SECRET_NAME)).toBe(false)
    expect(await taskStatus(w)).toBe('awaiting_approval')
    expect(await holds(w)).toEqual(['active'])
    expect((await feed(w))[0]).toMatchObject({ outcome: 'failed', reason: 'not_started' })
    expect(
      await db.deployment.findUniqueOrThrow({ where: { releaseId: w.f.releaseId } }),
    ).toMatchObject({ status: 'failed' })
    // The candidate can be released again without «Обновить»: `main` has its base tree.
    expect(w.git.trees.get(w.git.main)).toBe(INSTALLED_TREE)
  })

  it('a failed check rolls back: the dialog ends rolled_back, its reserve goes back', async () => {
    const w = await world()
    await published(w)
    const run = await deployed(w)
    expect(await run.report('verify', 'failed', { code: 'site_broken' })).toMatchObject({
      answer: { accepted: true, proceed: true },
    })
    expect((await release(w)).status).toBe('rolling_back')
    await run.report('rollback', 'started')
    await run.report('rollback', 'succeeded', { files: 2 })
    await run.report('reverify', 'started')
    await run.report('reverify', 'succeeded', { pages: 1 })
    expect(await release(w)).toMatchObject({ status: 'rolled_back', errorCode: 'verify_failed' })
    await advance(w)
    const row = await release(w)
    expect(row.revertSha).toBe(w.git.main)
    expect(w.git.trees.get(w.git.main)).toBe(INSTALLED_TREE)
    expect(await taskStatus(w)).toBe('rolled_back')
    expect(await holds(w)).not.toContain('active')
    expect((await feed(w))[0]).toMatchObject({ outcome: 'rolled_back', reason: 'site_check' })
    expect(await lease(w)).toMatchObject({ holderTaskId: null, inflightReleaseId: null })
    expect(
      (await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).installedVersion,
    ).toBeNull()
  })

  it('puts back on the queue the turns of other dialogs that waited for the site (R12)', async () => {
    const w = await world()
    // Another dialog of the site whose turn found it held by the release.
    const waiting = await db.task.create({
      data: {
        workspaceId: w.f.workspaceId,
        siteId: w.f.siteId,
        modelClass: 'standard',
        status: 'queued',
        waiting: 'site',
      },
    })
    const request = await insertFeedEvent(db, {
      taskId: waiting.id,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'first',
          authorId: w.f.userId,
          requestId: randomUUID(),
          text: 'Поменяйте адрес в подвале',
        },
      },
    })
    const wakeKey = `turn.run:${waiting.id}:1:${request}:retry:release-${w.f.releaseId}`
    try {
      await published(w)
      const run = await deployed(w)
      await run.report('verify', 'failed', { code: 'site_broken' })
      await run.report('rollback', 'started')
      await run.report('rollback', 'succeeded', { files: 2 })
      await run.report('reverify', 'started')
      await run.report('reverify', 'succeeded', { pages: 1 })
      // While the release holds the site, nothing wakes the waiting turn.
      expect(await db.outboxEvent.count({ where: { dedupeKey: wakeKey } })).toBe(0)
      await advance(w)
      expect(await lease(w)).toMatchObject({ inflightReleaseId: null })
      const woken = await db.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: wakeKey } })
      expect(woken).toMatchObject({
        topic: 'agent-turns',
        type: 'turn.run',
        payload: { taskId: waiting.id, attempt: 1, requestEventId: String(request) },
      })
      // The end of the release wakes it once.
      await advance(w)
      expect(await db.outboxEvent.count({ where: { dedupeKey: wakeKey } })).toBe(1)
    } finally {
      await db.outboxEvent.deleteMany({ where: { dedupeKey: wakeKey } })
      await db.taskEvent.deleteMany({ where: { taskId: waiting.id } })
      await db.task.delete({ where: { id: waiting.id } })
    }
  })

  it('a conflict found before the first write ends failed without a write', async () => {
    const w = await world()
    await published(w)
    const run = job(w)
    await run.report('conflicts', 'started')
    expect(await run.report('conflicts', 'failed', { code: 'conflict' })).toMatchObject({
      answer: { accepted: true, proceed: false },
    })
    await advance(w)
    expect(await release(w)).toMatchObject({ status: 'failed', errorCode: 'conflict' })
    expect(w.git.trees.get(w.git.main)).toBe(INSTALLED_TREE)
    expect(await taskStatus(w)).toBe('awaiting_approval')
    expect((await feed(w))[0]).toMatchObject({ outcome: 'failed', reason: 'conflict' })
  })

  /** The way an `unknown` release looks once it is the operator's. */
  async function heldForOperator(w: World) {
    expect(await release(w)).toMatchObject({ status: 'unknown', deployTokenHash: null })
    expect(await lease(w)).toMatchObject({
      heldForOperator: true,
      inflightReleaseId: w.f.releaseId,
    })
    expect(await feed(w)).toEqual([
      {
        v: 1,
        releaseId: w.f.releaseId,
        version: 'v0.1.0',
        outcome: 'unknown',
        reason: null,
        credits: null,
      },
    ])
    expect(w.provider.secrets.has(DEPLOY_WRAP_SECRET_NAME)).toBe(false)
    expect(w.logger.error).toHaveBeenCalledWith(expect.stringContaining('release_unknown'))
    // Nothing more happens by itself.
    await advance(w)
    expect(await feed(w)).toHaveLength(1)
  }

  it('a job silent after a write: core starts an attempt «только возврат» that restores', async () => {
    const w = await world()
    await published(w)
    const first = await deployed(w)
    const firstKey = deployWrapDataSchema.parse(w.vault.wrappings[0]!.data).backupKey
    const backup = await release(w)
    await silence(w)
    await advance(w)

    // The attempt that wrote kept a verified backup: a second attempt restores from it.
    const row = await release(w)
    expect(row).toMatchObject({
      status: 'unknown',
      errorCode: 'step_unknown',
      deployAttempt: 2,
      backupSha256: backup.backupSha256,
    })
    expect(w.provider.dispatches).toEqual([
      {
        repo: w.f.repo,
        workflow: 'deploy.yml',
        ref: 'refs/tags/v0.1.0',
        source: { provider: 'gitea', owner: 'platform', name: 'ci' },
      },
    ])
    expect(w.vault.revoked).toContain(w.vault.wrappings[0]!.accessor)
    const data = deployWrapDataSchema.parse(w.vault.wrappings[1]!.data)
    // The key of the attempt it restores: its backup and its values open with it.
    expect(data).toMatchObject({ attempt: '2', backupKey: firstKey })
    expect(parseDeployWrap(w.provider.secrets.get(DEPLOY_WRAP_SECRET_NAME)!)?.attempt).toBe(2)
    expect(
      await db.deployment.findUniqueOrThrow({ where: { releaseId: w.f.releaseId } }),
    ).toMatchObject({ workflowRunId: '101' })
    expect((await lease(w))?.heldForOperator).toBe(false)
    expect(await feed(w)).toEqual([])
    // The first job is done with.
    await expect(first.report('rollback', 'started')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })

    const run = job(w)
    expect(run.attempt).toBe(2)
    const manifest = await run.manifest()
    expect(manifest.rollbackOf).toMatchObject({
      deployAttempt: 1,
      sha256: backup.backupSha256,
      sizeBytes: Number(backup.backupBytes),
      backup: { method: 'GET' },
    })
    expect(new URL(manifest.rollbackOf!.backup.url).pathname).toBe(
      `/raditi-backups/sites/${w.f.siteId}/${w.f.releaseId}/1/backup.tar.zst.enc`,
    )
    expect((await run.report('rollback', 'started')).answer.proceed).toBe(true)
    expect(await run.access()).toMatchObject({ hosting: { method: 'sftp' } })
    await run.report('rollback', 'succeeded', { files: 2 })
    await run.report('reverify', 'started')
    await run.report('reverify', 'succeeded', { pages: 1 })
    expect((await release(w)).status).toBe('rolled_back')
    await advance(w)
    expect((await release(w)).revertSha).toBe(w.git.main)
    expect(w.git.trees.get(w.git.main)).toBe(INSTALLED_TREE)
    expect(await taskStatus(w)).toBe('rolled_back')
    expect(await lease(w)).toMatchObject({ holderTaskId: null, inflightReleaseId: null })
    expect((await feed(w))[0]).toMatchObject({ outcome: 'rolled_back' })
  })

  it('an attempt «только возврат» that does not answer leaves the site to the operator', async () => {
    const w = await world()
    await published(w)
    await deployed(w)
    await silence(w)
    await advance(w)
    expect((await release(w)).deployAttempt).toBe(2)
    // Not before its deadline; once only.
    await advance(w)
    expect(w.provider.dispatches).toHaveLength(1)
    await silence(w)
    await advance(w)
    await heldForOperator(w)
    expect(w.provider.dispatches).toHaveLength(1)

    // The operator found the old version on the hosting.
    expect(
      await db.$transaction((tx) =>
        resolveRelease(tx, {
          releaseId: w.f.releaseId,
          outcome: 'rolled_back',
          operator: 'ops',
          reason: 'Проверил хостинг',
        }),
      ),
    ).toMatchObject({ kind: 'resolved' })
    await advance(w)
    expect((await release(w)).revertSha).toBe(w.git.main)
    expect(await taskStatus(w)).toBe('rolled_back')
    expect(await lease(w)).toMatchObject({ holderTaskId: null, inflightReleaseId: null })
    expect((await feed(w)).at(-1)).toMatchObject({ outcome: 'rolled_back' })
  })

  it('a dispatch the provider refuses leaves the site to the operator at once', async () => {
    const w = await world()
    await published(w)
    await deployed(w)
    await silence(w)
    w.provider.fail.set('dispatchWorkflow', 'final')
    await advance(w)
    await heldForOperator(w)
    expect(w.vault.revoked).toContain(w.vault.wrappings[1]!.accessor)
  })

  it('without a verified backup there is nothing to restore from: the operator decides', async () => {
    const w = await world()
    await published(w)
    const run = job(w)
    await run.report('conflicts', 'started')
    await run.access()
    await run.report('conflicts', 'succeeded')
    await run.report('backup', 'started')
    await run.backup()
    await run.report('backup', 'succeeded')
    await run.report('files', 'started')
    await db.$executeRaw`UPDATE site_releases SET backup_verified_at = NULL WHERE id = ${w.f.releaseId}::uuid`
    await silence(w)
    await advance(w)
    await heldForOperator(w)
    expect(w.provider.dispatches).toEqual([])
    expect((await release(w)).deployAttempt).toBe(1)
  })

  it('an operator who found the new version installs it', async () => {
    const w = await world()
    await published(w)
    await deployed(w)
    await silence(w)
    w.provider.fail.set('dispatchWorkflow', 'final')
    await advance(w)
    await db.$transaction((tx) =>
      resolveRelease(tx, {
        releaseId: w.f.releaseId,
        outcome: 'installed',
        operator: 'ops',
        reason: 'Новая версия на хостинге',
      }),
    )
    await advance(w)
    const row = await release(w)
    expect(await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).toMatchObject({
      installedVersion: 'v0.1.0',
      installedReleaseId: w.f.releaseId,
    })
    expect(w.git.main).toBe(row.approvedSha)
    expect(await taskStatus(w)).toBe('done')
  })

  it('a write the job cannot prove may still be rolled back by the same job', async () => {
    const w = await world()
    await published(w)
    const run = job(w)
    await run.report('conflicts', 'started')
    await run.access()
    await run.report('conflicts', 'succeeded')
    await run.report('backup', 'started')
    await run.backup()
    await run.report('backup', 'succeeded')
    await run.report('files', 'started')
    // A write without a receipt, mid-way: the job must not write on, it rolls back.
    expect(await run.report('files', 'unknown', { code: 'write_failed' })).toMatchObject({
      answer: { accepted: true, proceed: false },
    })
    expect(await release(w)).toMatchObject({ status: 'unknown', errorCode: 'write_failed' })
    // The job restores at once; core neither starts another attempt nor calls the operator yet.
    await advance(w)
    expect((await lease(w))?.heldForOperator).toBe(false)
    expect(w.provider.dispatches).toEqual([])
    expect(await feed(w)).toEqual([])
    expect((await run.report('rollback', 'started')).answer.proceed).toBe(true)
    await run.report('rollback', 'succeeded')
    await run.report('reverify', 'started')
    await run.report('reverify', 'succeeded')
    await advance(w)
    expect(await release(w)).toMatchObject({ status: 'rolled_back' })
    expect(await taskStatus(w)).toBe('rolled_back')
    expect((await feed(w))[0]).toMatchObject({ outcome: 'rolled_back', reason: 'technical' })
  })

  it('a rollback the job could not prove leaves the site to the operator after one more attempt', async () => {
    const w = await world()
    await published(w)
    const run = await deployed(w)
    await run.report('verify', 'failed', { code: 'site_broken' })
    await run.report('rollback', 'started')
    await run.report('rollback', 'unknown', { code: 'changed_meanwhile' })
    // The way in of this job is closed at once: its rollback ended.
    expect(await release(w)).toMatchObject({ status: 'unknown', deployTokenHash: null })
    await advance(w)
    expect(w.provider.dispatches).toHaveLength(1)
    const again = job(w)
    await again.report('rollback', 'started')
    await again.report('rollback', 'unknown', { code: 'changed_meanwhile' })
    await advance(w)
    await heldForOperator(w)
    expect(w.provider.dispatches).toHaveLength(1)
  })

  it('an installed dialog whose usage is still open is charged later; the site is free at once', async () => {
    const w = await world()
    const pool = await fixtures.modelPool()
    const price = await fixtures.modelPrice(pool, {
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    })
    const call = await fixtures.modelCall({
      taskId: w.f.taskId,
      pool,
      priceId: price.id,
      costRub: '1',
      occurredAt: new Date(),
      usageClosed: false,
    })
    await published(w)
    const run = await deployed(w)
    await run.report('verify', 'succeeded')
    await advance(w)
    expect(
      (await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).installedReleaseId,
    ).toBe(w.f.releaseId)
    expect(await lease(w)).toMatchObject({ inflightReleaseId: null, holderTaskId: null })
    expect(await taskStatus(w)).toBe('verifying')
    expect(await holds(w)).toEqual(['active'])
    expect(w.logger.warn).toHaveBeenCalledWith(expect.stringContaining('charge usage_open'))

    // The gateway closes the key; the call was never billable work.
    await db.tokenUsage.delete({ where: { id: call.usageId } })
    await db.llmCall.delete({ where: { id: call.callId } })
    await db.llmKey.update({ where: { id: call.keyId }, data: { usageClosedAt: new Date() } })
    await advance(w)
    expect(await taskStatus(w)).toBe('done')
    expect(await holds(w)).not.toContain('active')
    expect(await feed(w)).toHaveLength(1)
  })
  describe('refused for good after `main` moved: the revert commit, the site free', () => {
    async function failedAfterMain(w: World, code: string) {
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'failed', errorCode: code })
      expect(row.mainPushedAt).toBeInstanceOf(Date)
      expect(row.revertSha).toBe(w.git.main)
      expect(w.git.parents.get(w.git.main)).toBe(row.approvedSha)
      expect(w.git.trees.get(w.git.main)).toBe(INSTALLED_TREE)
      expect(await taskStatus(w)).toBe('awaiting_approval')
      expect(await holds(w)).toEqual(['active'])
      expect(await lease(w)).toMatchObject({ holderTaskId: null, inflightReleaseId: null })
      expect(w.provider.secrets.has(DEPLOY_WRAP_SECRET_NAME)).toBe(false)
      return row
    }

    it('a secret the repository refuses: the armed wrapping is revoked', async () => {
      const w = await world()
      w.provider.fail.set('setActionsSecret', 'final')
      await failedAfterMain(w, 'secret_refused')
      expect(w.provider.tags.size).toBe(0)
      expect(w.vault.wrappings).toHaveLength(1)
      expect(w.vault.revoked).toEqual([w.vault.wrappings[0]!.accessor])
      expect((await feed(w))[0]).toMatchObject({ outcome: 'failed', reason: 'technical' })
    })

    it('a secret the release account cannot set without its token', async () => {
      const w = await world()
      w.provider.fail.set('setActionsSecret', 'not_configured')
      await failedAfterMain(w, 'secret_refused')
      // Once, not every 30 seconds with a new attempt.
      expect(w.vault.wrappings).toHaveLength(1)
    })

    it('a tag the release account cannot make without its token', async () => {
      const w = await world()
      w.provider.fail.set('createTag', 'not_configured')
      await failedAfterMain(w, 'tag_refused')
      expect(w.provider.tags.size).toBe(0)
      // The secret was set for the run the tag would have started: gone, its wrapping revoked.
      expect(w.vault.revoked).toEqual([w.vault.wrappings[0]!.accessor])
    })

    it('a client variable added after the readiness stops the arming', async () => {
      const { operation, state } = planOperation('page:42', { title: `Ключ ${CLIENT_VALUE}` })
      const w = await world({ dbPlan: [operation], contentAccess: true })
      w.values.states.set(operation.objectRef, state)
      w.vault.kv.set(siteAccessPath(w.f.siteId, 'wp'), { data: WP_ACCESS, version: 1 })
      w.git.fail.set('trustedCommit', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'publishing' })
      await clientVariable(w)
      await failedAfterMain(w, 'client_variable')
      // Nothing was sealed, wrapped or tagged with the value.
      expect(w.vault.wrappings).toEqual([])
      expect([...w.storage.objects.keys()]).toEqual([])
      expect(w.provider.tags.size).toBe(0)
      expect((await feed(w))[0]).toMatchObject({ outcome: 'failed', reason: 'client_variable' })
    })

    it('a release that keeps failing to publish gives up two hours after the confirmation', async () => {
      const w = await world()
      w.provider.fail.set('setActionsSecret', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'publishing', deployAttempt: 1 })
      w.now.at = new Date(w.now.at.getTime() + RELEASE_PUBLISH_GIVE_UP_MS + 60_000)
      await failedAfterMain(w, 'publish_timeout')
      expect(w.vault.revoked).toEqual([w.vault.wrappings[0]!.accessor])
      expect(w.provider.tags.size).toBe(0)
    })
  })

  describe('the revert commit', () => {
    it('whose answer was lost is read back from `main`', async () => {
      const w = await world()
      await published(w)
      await silence(w)
      w.git.fail.set('pushTrustedCommit', 'after')
      await advance(w)
      const row = await release(w)
      expect(row).toMatchObject({ status: 'failed', errorCode: 'start_timeout' })
      expect(row.revertSha).toBe(w.git.main)
      expect(w.git.parents.get(w.git.main)).toBe(row.approvedSha)
      expect(w.git.trees.get(w.git.main)).toBe(INSTALLED_TREE)
      expect(await lease(w)).toMatchObject({ holderTaskId: null, inflightReleaseId: null })
      expect(await taskStatus(w)).toBe('awaiting_approval')
    })

    it('that did not answer is tried again; the site waits', async () => {
      const w = await world()
      await published(w)
      await silence(w)
      w.git.fail.set('pushTrustedCommit', 'before')
      w.git.fail.set('readBranchHead', 'before')
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'failed', revertSha: null })
      expect(await lease(w)).toMatchObject({
        inflightReleaseId: w.f.releaseId,
        heldForOperator: false,
      })
      expect(await taskStatus(w)).toBe('deploying')
      await advance(w)
      expect((await release(w)).revertSha).toBe(w.git.main)
      expect(await taskStatus(w)).toBe('awaiting_approval')
    })

    it('that cannot land leaves the site to the operator until `main` is put back', async () => {
      const w = await world()
      await published(w)
      const row = await release(w)
      await silence(w)
      const foreign = w.git.moveMain()
      await advance(w)
      expect(await release(w)).toMatchObject({
        status: 'failed',
        errorCode: 'start_timeout',
        revertSha: null,
      })
      expect(await lease(w)).toMatchObject({
        heldForOperator: true,
        inflightReleaseId: w.f.releaseId,
      })
      expect(w.git.main).toBe(foreign)
      expect(w.logger.error).toHaveBeenCalledWith(expect.stringContaining('release_revert_blocked'))
      // The dialog waits with the site: nothing is said before the end.
      expect(await taskStatus(w)).toBe('deploying')
      expect(await feed(w)).toEqual([])
      // The way in is closed all the same.
      expect(w.provider.secrets.has(DEPLOY_WRAP_SECRET_NAME)).toBe(false)
      expect(w.vault.revoked).toContain(row.wrapAccessor)
      // Nothing more happens by itself.
      await advance(w)
      expect((await lease(w))?.heldForOperator).toBe(true)

      // The operator puts `main` back at the release commit and hands the release back.
      w.git.main = row.approvedSha!
      expect(
        await db.$transaction((tx) =>
          resolveRelease(tx, {
            releaseId: w.f.releaseId,
            outcome: 'rolled_back',
            operator: 'ops',
            reason: 'Вернул main к коммиту выпуска',
          }),
        ),
      ).toMatchObject({ kind: 'revert_retried', status: 'failed' })
      await advance(w)
      expect((await release(w)).revertSha).toBe(w.git.main)
      expect(w.git.parents.get(w.git.main)).toBe(row.approvedSha)
      expect(w.git.trees.get(w.git.main)).toBe(INSTALLED_TREE)
      expect(await lease(w)).toMatchObject({
        holderTaskId: null,
        inflightReleaseId: null,
        heldForOperator: false,
      })
      expect(await taskStatus(w)).toBe('awaiting_approval')
      expect(await feed(w)).toEqual([
        expect.objectContaining({ outcome: 'failed', reason: 'not_started' }),
      ])
    })

    it('is `main` itself when the operator put it back at the installed tree', async () => {
      const w = await world()
      await published(w)
      await silence(w)
      w.git.moveMain()
      await advance(w)
      expect((await lease(w))?.heldForOperator).toBe(true)
      w.git.main = INSTALLED_SHA
      await db.$transaction((tx) =>
        resolveRelease(tx, {
          releaseId: w.f.releaseId,
          outcome: 'rolled_back',
          operator: 'ops',
          reason: 'Вернул main к установленной версии',
        }),
      )
      await advance(w)
      expect((await release(w)).revertSha).toBe(INSTALLED_SHA)
      expect(w.git.main).toBe(INSTALLED_SHA)
      expect(await lease(w)).toMatchObject({ holderTaskId: null, inflightReleaseId: null })
      expect(await taskStatus(w)).toBe('awaiting_approval')
    })
  })

  describe('a job silent in a long phase', () => {
    /** The job of the first attempt, from its start to its first write: nothing reported since. */
    async function writing(w: World) {
      const run = job(w)
      await run.report('conflicts', 'started')
      await run.access()
      await run.report('conflicts', 'succeeded')
      await run.report('backup', 'started')
      await run.backup()
      await run.report('backup', 'succeeded')
      await run.report('files', 'started')
      return run
    }

    it('keeps its token and the lease while the provider shows its run at work', async () => {
      const w = await world()
      await published(w)
      const run = await writing(w)
      const sha = (await release(w)).approvedSha!
      w.provider.deployRun({ id: '7', tag: 'v0.1.0', sha, status: 'in_progress' })
      // A dispatched run of another attempt is not this job's.
      w.provider.deployRun({
        id: '8',
        tag: 'v0.1.0',
        sha,
        status: 'completed',
        event: 'workflow_dispatch',
      })
      await nearDeadline(w)
      await advance(w)
      const kept = await release(w)
      expect(kept.status).toBe('deploying')
      expect(kept.deployTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000)
      expect((await lease(w))!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000)
      expect(w.logger.log).toHaveBeenCalledWith(expect.stringContaining('release_job_running'))
      // Even a minute past its deadline: a run at work keeps its job.
      await silence(w)
      await advance(w)
      expect((await release(w)).status).toBe('deploying')
      // The job goes on with its token.
      expect((await run.report('files', 'succeeded', { files: 2 })).answer.proceed).toBe(true)
      expect(w.provider.dispatches).toEqual([])
    })

    it('is stopped at once when its run ended without its last report', async () => {
      const w = await world()
      await published(w)
      const run = await writing(w)
      w.provider.deployRun({
        id: '7',
        tag: 'v0.1.0',
        sha: (await release(w)).approvedSha!,
        status: 'completed',
      })
      // Not yet due: the provider is not asked, the job keeps its token.
      await advance(w)
      expect((await release(w)).status).toBe('deploying')
      await nearDeadline(w)
      await advance(w)
      // It wrote: the release is `unknown`, and the attempt «только возврат» goes at once.
      expect(await release(w)).toMatchObject({ status: 'unknown', deployAttempt: 2 })
      expect(w.provider.dispatches).toHaveLength(1)
      await expect(run.report('files', 'succeeded')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      })
    })

    it('waits for the run that wrote to end before an attempt «только возврат»', async () => {
      const w = await world()
      await published(w)
      const run = await writing(w)
      const sha = (await release(w)).approvedSha!
      w.provider.deployRun({ id: '7', tag: 'v0.1.0', sha, status: 'in_progress' })
      // A write the job cannot prove; its own rollback never reports.
      await run.report('files', 'unknown', { code: 'write_failed' })
      await silence(w)
      await advance(w)
      expect(await release(w)).toMatchObject({
        status: 'unknown',
        deployAttempt: 1,
        deployTokenHash: null,
      })
      expect(w.provider.dispatches).toEqual([])
      expect(w.logger.warn).toHaveBeenCalledWith(expect.stringContaining('reason=job_running'))
      // Its run ended: the attempt «только возврат» restores alone.
      w.provider.deployRun({ id: '7', tag: 'v0.1.0', sha, status: 'completed' })
      await advance(w)
      expect(await release(w)).toMatchObject({ status: 'unknown', deployAttempt: 2 })
      expect(w.provider.dispatches).toHaveLength(1)
    })
  })

  it('a refused charge of an installed dialog waits two hours from its install, not from the site', async () => {
    const w = await world()
    await published(w)
    const run = await deployed(w)
    // The reserve went another way: the charge finds nothing to charge (`no_reserve`).
    await db.creditHold.updateMany({ where: { taskId: w.f.taskId }, data: { status: 'released' } })
    await run.report('verify', 'succeeded')
    await advance(w)
    expect(
      (await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).installedReleaseId,
    ).toBe(w.f.releaseId)
    expect(await taskStatus(w)).toBe('verifying')
    // Another release of the site installed since: the site names it, not this one.
    await db.site.update({ where: { id: w.f.siteId }, data: { installedReleaseId: null } })
    await advance(w)
    expect(await taskStatus(w)).toBe('verifying')
    w.now.at = new Date(w.now.at.getTime() + 2 * 60 * 60_000 + 60_000)
    await advance(w)
    expect(await taskStatus(w)).toBe('done')
    expect(w.logger.error).toHaveBeenCalledWith(expect.stringContaining('release_charge_refused'))
  })
})
