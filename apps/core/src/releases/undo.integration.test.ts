import { createHash } from 'node:crypto'

import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  PostgresSiteLeaseStore,
  requestUndoPlan,
  type PrismaClient,
} from '@repo/db'
import {
  deployWrapDataSchema,
  releaseReportKey,
  siteAccessPath,
  undoKeyMaterial,
  type DbUndoOperation,
  type PublishedContentState,
  type ReleaseStep,
  type ReleaseStepDetail,
  type ReleaseStepState,
} from '@repo/domain'
import { getSiteAdapter, getSiteContentAdapter } from '@repo/site-adapters'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  absentHashOf,
  contentCallId,
  createdHashOf,
  openOperationValue,
} from '../deploy-step/content.ts'
import { ReleaseApi } from '../release-api/release-api.service.ts'
import {
  cleanupReleases,
  FakePlanValues,
  FakeProduction,
  FakeReleaseGit,
  FakeReleaseProvider,
  FakeReleaseStorage,
  FakeReleaseVault,
  hashedState,
  INSTALLED_SHA,
  INSTALLED_TREE,
  planCreation,
  planOperation,
  planSetting,
  planTable,
  releaseFixture,
  type ReleaseFixture,
} from '../testing/releases.ts'
import { ReleaseSkill } from './release-skill.ts'
import { UndoPlanner } from './undo-planner.ts'

// «Отменить выпуск» on PostgreSQL (docs/plan/53-chat-preview-release.md, «Отмена выпуска»): the
// plan of the undo core makes from git, production and the values of the release; the undo
// itself through the release skill and the release API — the commit with the tree of the plan,
// the values of what production held before the release, the outcomes — with the dialog of the
// release closed and charged before and after. Only on a disposable database
// (RADITI_GATEWAY_DB_TESTS=1), as the other suites of releases.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

const RELEASE_API_URL = 'http://release-api.invalid'
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
const WP_ACCESS = {
  v: '1',
  origin: 'https://site.invalid',
  username: 'raditi',
  applicationPassword: 'x',
}

describe.skipIf(!enabled)('«Отменить выпуск» with PostgreSQL', () => {
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

  const table = planTable()
  const setting = planSetting()
  const creation = planCreation('prices')
  const text = planOperation()
  const plan = [table, setting, creation, text]
  const record = {
    status: 'publish' as const,
    slug: 'prices',
    title: creation.state.title,
    content: creation.state.content,
    excerpt: creation.state.excerpt,
  }

  interface World {
    f: ReleaseFixture
    git: FakeReleaseGit
    provider: FakeReleaseProvider
    vault: FakeReleaseVault
    storage: FakeReleaseStorage
    values: FakePlanValues
    production: FakeProduction
    skill: ReleaseSkill
    planner: UndoPlanner
    api: ReleaseApi
  }

  /** A site whose release of the four kinds is installed, and production as it left it. */
  async function installed(): Promise<World> {
    const f = await releaseFixture(db, fixtures, {
      dbPlan: plan.map(({ operation }) => operation),
      contentAccess: true,
    })
    sites.push(f.siteId)
    const git = new FakeReleaseGit()
    const provider = new FakeReleaseProvider()
    const vault = new FakeReleaseVault()
    vault.kv.set(siteAccessPath(f.siteId, 'ssh'), { data: SSH_ACCESS, version: 1 })
    vault.kv.set(siteAccessPath(f.siteId, 'wp'), { data: WP_ACCESS, version: 1 })
    const storage = new FakeReleaseStorage()
    const values = new FakePlanValues()
    for (const { operation, state, before } of plan) {
      values.states.set(operation.objectRef, state)
      values.befores.set(operation.objectRef, before)
    }
    const production = new FakeProduction()
    production.holdsBaseOf(plan.map(({ operation }) => operation))
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const skill = new ReleaseSkill({
      db,
      leases: new PostgresSiteLeaseStore(db),
      git,
      provider,
      secrets: vault,
      storage,
      adapter: getSiteAdapter,
      contentAccessKind: (stack) => getSiteContentAdapter(stack).accessKind,
      api: { startTimeoutMs: 10 * 60_000 },
      values,
      production: production.resolve,
      previewBaseDomain: 'preview.example.test',
      logger,
    })
    const planner = new UndoPlanner({
      db,
      git,
      production: production.resolve,
      values,
      adapter: getSiteAdapter,
      previewBaseDomain: 'preview.example.test',
      logger,
    })
    const api = new ReleaseApi({
      db,
      git,
      secrets: vault,
      storage,
      adapter: getSiteAdapter,
      contentAdapter: getSiteContentAdapter,
      publicUrl: RELEASE_API_URL,
    })
    const w = { f, git, provider, vault, storage, values, production, skill, planner, api }
    // The release: published, written and checked, its dialog closed and charged.
    await advance(w, f.releaseId)
    const run = job(w, f.releaseId)
    await run.report('conflicts', 'started')
    await run.access()
    await run.report('conflicts', 'succeeded', { files: 2 })
    await run.report('backup', 'started')
    await run.backup()
    await run.report('backup', 'succeeded', { files: 2 })
    await run.report('files', 'started')
    await run.report('files', 'succeeded', { files: 2 })
    await run.report('db', 'started')
    await run.report('db', 'succeeded', { objects: 4 })
    await run.report('verify', 'started')
    await run.report('verify', 'succeeded', { pages: 1 })
    await advance(w, f.releaseId)
    expect(await taskStatus(w)).toBe('done')
    // Production as the release left it: production gave the new page its own id.
    production.states.set(setting.operation.objectRef, setting.state)
    production.states.set(text.operation.objectRef, text.state)
    production.states.set(table.operation.objectRef, table.state)
    const callId = contentCallId(f.releaseId, 1, creation.operation.objectRef, 'apply')
    production.receipts.set(callId, {
      version: 1,
      kind: 'committed',
      callId,
      siteId: f.siteId,
      epoch: 2,
      requestHash: 'a'.repeat(64),
      objectRef: creation.operation.objectRef,
      createdRef: 'page:900',
      stateHash: createdHashOf('page:900', record),
    })
    const { stateHash: _plan, ...created } = creation.state
    production.states.set('page:900', hashedState({ ...created, objectRef: 'page:900' }))
    return w
  }

  const release = (id: string) => db.siteRelease.findUniqueOrThrow({ where: { id } })
  const taskStatus = async (w: World) =>
    (await db.task.findUniqueOrThrow({ where: { id: w.f.taskId } })).status
  const advance = async (w: World, id: string) =>
    w.skill.advance({ releaseId: id, seq: (await release(id)).enqueues })
  const undoFeed = async (w: World) =>
    (
      await db.taskEvent.findMany({
        where: { taskId: w.f.taskId, type: 'feed.undo' },
        orderBy: { id: 'asc' },
      })
    ).map((row) => row.payload)

  function job(w: World, releaseId: string) {
    const auth = `Bearer ${w.vault.latestToken()}`
    const attempt = Number(w.vault.wrappings.at(-1)!.data.attempt)
    return {
      auth,
      report: (step: ReleaseStep, state: ReleaseStepState, detail: ReleaseStepDetail = {}) =>
        w.api.step(releaseId, auth, {
          reportKey: releaseReportKey(attempt, step, state),
          deployAttempt: attempt,
          step,
          state,
          detail,
        }),
      manifest: () => w.api.manifest(releaseId, auth),
      access: () => w.api.access(releaseId, auth, { deployAttempt: attempt }),
      backup: async () => {
        const body = Buffer.from('sealed backup')
        const facts = {
          deployAttempt: attempt,
          sha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.byteLength,
        }
        const put = await w.api.backup(releaseId, auth, { phase: 'put', ...facts })
        if (put.phase !== 'put') throw new Error('expected a PUT')
        await w.storage.put(
          'backups',
          new URL(put.put.url).pathname.split('/').slice(2).join('/'),
          body,
        )
        return w.api.backup(releaseId, auth, { phase: 'verify', ...facts })
      },
    }
  }

  /** The plan of the undo, as the window asks for it and core makes it. */
  async function planOf(w: World) {
    const installedSha = (await release(w.f.releaseId)).approvedSha!
    const asked = await db.$transaction((tx) =>
      requestUndoPlan(tx, {
        releaseId: w.f.releaseId,
        siteId: w.f.siteId,
        installedSha,
        userId: w.f.userId,
      }),
    )
    await w.planner.plan({ planId: asked.id })
    return db.releaseUndoPlan.findUniqueOrThrow({ where: { id: asked.id } })
  }

  /** The confirmation of the plan, as `release.undoConfirm` writes it. */
  async function confirmed(w: World, planId: string) {
    const planRow = await db.releaseUndoPlan.findUniqueOrThrow({ where: { id: planId } })
    const undone = await release(w.f.releaseId)
    const undo = await db.siteRelease.create({
      data: {
        siteId: w.f.siteId,
        taskId: w.f.taskId,
        kind: 'undo',
        undoesReleaseId: undone.id,
        undoPlanId: planId,
        undoPlanSha256: planRow.planSha256,
        attempt: 1,
        releaseKey: createHash('sha256')
          .update(
            undoKeyMaterial({
              undoesReleaseId: undone.id,
              planId,
              version: 'v0.1.1',
              attempt: 1,
            }),
          )
          .digest('hex'),
        version: 'v0.1.1',
        tag: 'v0.1.1',
        bump: 'patch',
        mainBeforeSha: undone.approvedSha!,
        installedBeforeSha: undone.approvedSha!,
        committedAt: new Date('2026-10-18T12:00:00.000Z'),
        status: 'approved',
        approvedBy: w.f.userId,
        approvedAt: new Date(),
      },
    })
    return undo.id
  }

  it('plans the undo from production: what goes back, what stays, the tree of the version before', async () => {
    const w = await installed()
    const planRow = await planOf(w)
    expect(planRow).toMatchObject({ status: 'ready', nothingToUndo: false })
    expect(planRow.items).toEqual([
      expect.objectContaining({ objectRef: 'table:bookings', verdict: 'stays' }),
      expect.objectContaining({ objectRef: 'option:blogdescription', verdict: 'return' }),
      expect.objectContaining({
        objectRef: 'page:1000000001',
        productionRef: 'page:900',
        verdict: 'return',
      }),
      expect.objectContaining({ objectRef: 'page:42', verdict: 'return' }),
    ])
    // The writes in the reverse of the release's order; the new page under production's id.
    expect(
      (planRow.dbPlan as DbUndoOperation[]).map((write) => [write.kind, write.objectRef]),
    ).toEqual([
      ['content_update', 'page:42'],
      ['post_trash', 'page:900'],
      ['option_update', 'option:blogdescription'],
    ])
    expect((planRow.dbPlan as DbUndoOperation[])[1]).toMatchObject({
      createdRef: 'page:1000000001',
      beforeHash: createdHashOf('page:900', record),
      afterHash: absentHashOf('page:900'),
    })
    expect(planRow.files).toMatchObject({ back: 1, removed: 0, restored: 1, mediaKept: 0 })
    expect(planRow.targetTree).toBe(INSTALLED_TREE)
    expect(planRow.planSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps and names what the site changed since the release and the page it built on', async () => {
    const w = await installed()
    w.production.states.set(text.operation.objectRef, { stateHash: 'e'.repeat(64) })
    w.production.dependentsOf.set('page:900', 3)
    w.production.states.set(setting.operation.objectRef, setting.before)
    const planRow = await planOf(w)
    expect((planRow.items as { verdict: string }[]).map((item) => item.verdict)).toEqual([
      'stays',
      'already',
      'kept_dependents',
      'changed',
    ])
    expect(planRow.dbPlan).toEqual([])
    // The files still go back: there is something to undo.
    expect(planRow.nothingToUndo).toBe(false)
  })

  it('keeps a new page whose address alone changed since the release', async () => {
    const w = await installed()
    // The hash of a record leaves its address out: the owner renamed only the address.
    const held = w.production.states.get('page:900') as PublishedContentState
    const { stateHash: _hash, ...page } = held
    w.production.states.set(
      'page:900',
      hashedState<PublishedContentState>({ ...page, slug: 'nashi-ceny' }),
    )
    const planRow = await planOf(w)
    expect(planRow.items).toContainEqual(
      expect.objectContaining({ objectRef: 'page:1000000001', verdict: 'changed' }),
    )
    expect((planRow.dbPlan as DbUndoOperation[]).map((write) => write.kind)).not.toContain(
      'post_trash',
    )
  })

  it('waits for a production that does not answer, then fails the plan', async () => {
    const w = await installed()
    w.production.unreachable = true
    const planRow = await planOf(w)
    expect(planRow.status).toBe('pending')
    await db.$executeRaw`UPDATE release_undo_plans SET created_at = created_at - interval '2 minutes' WHERE id = ${planRow.id}::uuid`
    await w.planner.plan({ planId: planRow.id })
    expect(await db.releaseUndoPlan.findUniqueOrThrow({ where: { id: planRow.id } })).toMatchObject(
      {
        status: 'failed',
        errorCode: 'site_unreachable',
      },
    )
  })

  it('installs the undo: the tree of the plan, the values before the release, the dialog left done', async () => {
    const w = await installed()
    const planRow = await planOf(w)
    const undoId = await confirmed(w, planRow.id)
    const holdsBefore = await db.creditHold.findMany({ where: { taskId: w.f.taskId } })
    const ledgerBefore = await db.creditLedger.count({ where: { taskId: w.f.taskId } })
    await advance(w, undoId)
    const row = await release(undoId)
    expect(row.status).toBe('published')
    // The undo commit: the version before the release on top of `main`, a new tag.
    expect(w.git.trees.get(row.approvedSha!)).toBe(INSTALLED_TREE)
    expect(w.git.parents.get(row.approvedSha!)).toBe((await release(w.f.releaseId)).approvedSha)
    expect(w.provider.tags.get('v0.1.1')).toBe(row.approvedSha)
    expect(w.provider.tags.get('v0.1.0')).toBe((await release(w.f.releaseId)).approvedSha)

    const run = job(w, undoId)
    const manifest = await run.manifest()
    expect(manifest.kind).toBe('undo')
    expect(manifest.installedSha).toBe((await release(w.f.releaseId)).approvedSha)
    expect(manifest.db.map(({ operation }) => operation.kind)).toEqual([
      'content_update',
      'post_trash',
      'option_update',
    ])
    const key = Buffer.from(
      deployWrapDataSchema.parse(w.vault.wrappings.at(-1)!.data).backupKey,
      'base64',
    )
    const opened = await Promise.all(
      manifest.db.map(async ({ operation }, index) =>
        openOperationValue(
          await w.api.value(undoId, run.auth, String(index)),
          key,
          undoId,
          operation,
          'undo',
        ),
      ),
    )
    expect(opened).toEqual([
      { v: 1, fields: { title: text.before.title } },
      {
        v: 1,
        slug: 'prices',
        createCallId: contentCallId(w.f.releaseId, 1, 'page:1000000001', 'apply'),
      },
      { v: 1, value: setting.before.value },
    ])
    // A release's way of opening does not open an undo's value.
    expect(() =>
      openOperationValue(Buffer.alloc(64), key, undoId, manifest.db[0]!.operation),
    ).toThrow()

    await run.report('conflicts', 'started')
    await run.access()
    await run.report('conflicts', 'succeeded', { files: 2, objects: 3 })
    await run.report('backup', 'started')
    await run.backup()
    await run.report('backup', 'succeeded', { files: 2 })
    await run.report('files', 'started')
    await run.report('files', 'succeeded', { files: 2 })
    await run.report('verify', 'started')
    // The dialog of the release stays as it was while its undo goes on.
    expect(await taskStatus(w)).toBe('done')
    await run.report('verify', 'succeeded', { pages: 1 })
    await advance(w, undoId)

    expect(await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).toMatchObject({
      installedVersion: 'v0.1.1',
      installedSha: row.approvedSha,
      installedReleaseId: undoId,
    })
    expect(await db.deployment.findUniqueOrThrow({ where: { releaseId: undoId } })).toMatchObject({
      status: 'succeeded',
    })
    expect(await taskStatus(w)).toBe('done')
    expect(await db.creditHold.findMany({ where: { taskId: w.f.taskId } })).toEqual(holdsBefore)
    expect(await db.creditLedger.count({ where: { taskId: w.f.taskId } })).toBe(ledgerBefore)
    expect(await undoFeed(w)).toEqual([
      {
        v: 1,
        stage: 'installed',
        undoId,
        releaseId: w.f.releaseId,
        undoneVersion: 'v0.1.0',
        version: 'v0.1.1',
        returnsTo: 'v0.0.0',
        reason: null,
        records: { returned: 3, kept: 0 },
      },
    ])
    const site = await db.siteLease.findUnique({ where: { siteId: w.f.siteId } })
    expect(site?.inflightReleaseId ?? null).toBeNull()
  })

  it('refuses an undo before `main` moves when the site runs another version or the plan changed', async () => {
    for (const change of ['installed', 'tree', 'path'] as const) {
      const w = await installed()
      const planRow = await planOf(w)
      const undoId = await confirmed(w, planRow.id)
      if (change === 'installed')
        await db.site.update({ where: { id: w.f.siteId }, data: { installedSha: INSTALLED_SHA } })
      else if (change === 'tree')
        await db.releaseUndoPlan.update({
          where: { id: planRow.id },
          data: { targetTree: '7'.repeat(40) },
        })
      // The release changed a path of CI (moved by someone else than the platform): the undo
      // would write it back — rule 6 refuses it before `main` moves.
      else
        w.git.digests = [
          ...w.git.digests,
          {
            path: '.gitea/workflows/deploy.yml',
            change: 'added',
            before: null,
            after: 'f'.repeat(64),
            sizeBytes: 10,
            executable: false,
          },
        ]
      const main = w.git.main
      await advance(w, undoId)
      const row = await release(undoId)
      const code = {
        installed: 'undo_outdated',
        tree: 'undo_plan_changed',
        path: 'forbidden_path',
      }[change]
      expect(row).toMatchObject({ status: 'failed', errorCode: code, mainPushedAt: null })
      expect(w.git.main).toBe(main)
      expect(await taskStatus(w)).toBe('done')
      expect(await undoFeed(w)).toEqual([
        expect.objectContaining({
          stage: 'refused',
          reason: { installed: 'undo_outdated', tree: 'conflict', path: 'technical' }[change],
        }),
      ])
    }
  })

  it('goes back to the release when the undo fails its check: the revert commit, the dialog done', async () => {
    const w = await installed()
    const planRow = await planOf(w)
    const undoId = await confirmed(w, planRow.id)
    await advance(w, undoId)
    const run = job(w, undoId)
    await run.report('conflicts', 'started')
    await run.access()
    await run.report('conflicts', 'succeeded', { files: 2 })
    await run.report('backup', 'started')
    await run.backup()
    await run.report('backup', 'succeeded', { files: 2 })
    await run.report('files', 'started')
    await run.report('files', 'succeeded', { files: 2 })
    await run.report('verify', 'started')
    await run.report('verify', 'failed', { pages: 1, code: 'site_broken' })
    await run.report('rollback', 'started')
    await run.report('rollback', 'succeeded', { files: 2, objects: 3 })
    await run.report('reverify', 'started')
    await run.report('reverify', 'succeeded', { pages: 1 })
    await advance(w, undoId)
    const row = await release(undoId)
    expect(row.status).toBe('rolled_back')
    // `main` is back at the tree the site runs: the release undone.
    expect(w.git.trees.get(w.git.main)).toBe(
      w.git.trees.get((await release(w.f.releaseId)).approvedSha!),
    )
    expect(row.revertSha).toBe(w.git.main)
    expect(
      (await db.site.findUniqueOrThrow({ where: { id: w.f.siteId } })).installedReleaseId,
    ).toBe(w.f.releaseId)
    expect(await taskStatus(w)).toBe('done')
    expect(await undoFeed(w)).toEqual([
      expect.objectContaining({ stage: 'rolled_back', reason: 'site_check' }),
    ])
  })

  it('leaves the site to the operator when it failed its check before the undo and after it', async () => {
    const w = await installed()
    const planRow = await planOf(w)
    const undoId = await confirmed(w, planRow.id)
    await advance(w, undoId)
    const run = job(w, undoId)
    await run.report('conflicts', 'started')
    await run.access()
    await run.report('conflicts', 'succeeded', { files: 2, brokenBefore: true })
    await run.report('backup', 'started')
    await run.backup()
    await run.report('backup', 'succeeded', { files: 2 })
    await run.report('files', 'started')
    await run.report('files', 'succeeded', { files: 2 })
    await run.report('verify', 'started')
    await run.report('verify', 'unknown', { pages: 1, code: 'site_broken_both' })
    const row = await release(undoId)
    expect(row).toMatchObject({ status: 'unknown', errorCode: 'site_broken_both' })
    // No grace for a rollback that will not come, and no attempt «только возврат».
    expect(row.deployTokenHash).toBeNull()
    await advance(w, undoId)
    expect(w.provider.dispatches).toEqual([])
    expect(await db.siteLease.findUnique({ where: { siteId: w.f.siteId } })).toMatchObject({
      inflightReleaseId: undoId,
      heldForOperator: true,
    })
    expect(await undoFeed(w)).toEqual([expect.objectContaining({ stage: 'unknown', reason: null })])
  })

  it('leaves the site to the operator at once when a write failed on a site broken before the undo', async () => {
    const w = await installed()
    const planRow = await planOf(w)
    const undoId = await confirmed(w, planRow.id)
    await advance(w, undoId)
    const run = job(w, undoId)
    await run.report('conflicts', 'started')
    await run.access()
    await run.report('conflicts', 'succeeded', { files: 2, brokenBefore: true })
    await run.report('backup', 'started')
    await run.backup()
    await run.report('backup', 'succeeded', { files: 2 })
    await run.report('files', 'started')
    await run.report('files', 'succeeded', { files: 2 })
    await run.report('db', 'started')
    await run.report('db', 'failed', { code: 'write_failed' })
    await run.report('rollback', 'started')
    await run.report('rollback', 'succeeded', { files: 2, objects: 0 })
    await run.report('reverify', 'started')
    await run.report('reverify', 'failed', { pages: 1, code: 'site_broken_both' })
    // The decisive fact, not the first error: going back mends nothing.
    expect(await release(undoId)).toMatchObject({
      status: 'unknown',
      errorCode: 'site_broken_both',
    })
    await advance(w, undoId)
    // No attempt «только возврат»: the site waits for the operator.
    expect(w.provider.dispatches).toEqual([])
    expect(await db.siteLease.findUnique({ where: { siteId: w.f.siteId } })).toMatchObject({
      inflightReleaseId: undoId,
      heldForOperator: true,
    })
  })
})
