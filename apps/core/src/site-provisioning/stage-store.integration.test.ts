// The SQL of the import stage on a real PostgreSQL (docs/plan/39-site-connection-wizard.md): the
// claim under the workspace lock, the fence of every write, the requeue with its outbox event, the
// release, the sweep and the plan of the first version. Only verify:db's disposable database and
// the gateway-db job of CI: the sweep reads every unfinished stage of the database.
import { randomBytes, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { provisioningLimits, siteProvisionDedupeKey } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { isTransientDatabaseError } from './database-errors.ts'
import { PostgresSiteImportStore, type StageLease } from './stage-store.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const SHA = 'b'.repeat(40)
const OTHER_SHA = 'c'.repeat(40)

describe.skipIf(!enabled)('the import stage store with PostgreSQL', () => {
  let db: PrismaClient
  let store: PostgresSiteImportStore
  const workspaces: string[] = []
  const sites: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresSiteImportStore(db)
  })
  afterEach(async () => {
    const ids = sites.splice(0)
    await db.outboxEvent.deleteMany({
      where: { OR: ids.map((id) => ({ dedupeKey: { startsWith: `site-provisioning:${id}:` } })) },
    })
    await db.siteInitialVersion.deleteMany({ where: { siteId: { in: ids } } })
    await db.gitRepository.deleteMany({ where: { siteId: { in: ids } } })
    await db.siteProvisioningStage.deleteMany({ where: { siteId: { in: ids } } })
    await db.siteCodeSource.deleteMany({ where: { siteId: { in: ids } } })
    await db.siteDatabase.deleteMany({ where: { siteId: { in: ids } } })
    await db.credentialRef.deleteMany({ where: { siteId: { in: ids } } })
    await db.site.deleteMany({ where: { id: { in: ids } } })
    await db.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function workspace(): Promise<string> {
    const created = await db.workspace.create({
      data: { name: 'Synthetic import', dataClass: 'synthetic' },
    })
    workspaces.push(created.id)
    return created.id
  }

  /** A site of the wizard: onboarding, an FTP source, its reference and a queued code_import. */
  async function site(workspaceId: string, extra: { status?: 'onboarding' | 'archived' } = {}) {
    const created = await db.site.create({
      data: {
        workspaceId,
        name: 'Synthetic import',
        url: `https://${randomBytes(6).toString('hex')}.example.test`,
        stack: 'wordpress',
        status: extra.status ?? 'onboarding',
      },
    })
    sites.push(created.id)
    const reference = await db.credentialRef.create({
      data: {
        workspaceId,
        siteId: created.id,
        kind: 'ftp',
        vaultPath: `kv/sites/${created.id}/ftp`,
        keyVersion: 3,
      },
    })
    await db.siteCodeSource.create({
      data: {
        siteId: created.id,
        kind: 'ftp',
        host: 'files.example.test',
        port: 21,
        rootPath: '/www',
        tls: 'verified',
        credentialRefId: reference.id,
      },
    })
    await db.siteProvisioningStage.create({ data: { siteId: created.id, stage: 'code_import' } })
    return created.id
  }

  const row = (siteId: string) =>
    db.siteProvisioningStage.findUniqueOrThrow({
      where: { siteId_stage: { siteId, stage: 'code_import' } },
    })

  async function claimed(siteId: string): Promise<StageLease & { workspaceId: string }> {
    const claim = await store.claim(siteId)
    if (claim.kind !== 'claimed') throw new Error(`not claimed: ${claim.kind}`)
    return claim.stage
  }

  it('claims a queued stage once, with a new epoch, the fetch step and a heartbeat', async () => {
    const ws = await workspace()
    const id = await site(ws)

    const first = await store.claim(id)
    expect(first).toEqual({
      kind: 'claimed',
      stage: expect.objectContaining({
        siteId: id,
        workspaceId: ws,
        stack: 'wordpress',
        attempt: 1,
        enqueues: 1,
        leaseEpoch: 1,
      }),
    })
    expect(await row(id)).toMatchObject({
      status: 'running',
      step: 'fetch',
      leaseEpoch: 1,
      heartbeatAt: expect.any(Date),
      startedAt: expect.any(Date),
    })
    expect(await store.claim(id)).toEqual({ kind: 'idle' })
    expect(await store.claim(randomUUID())).toEqual({ kind: 'idle' })
  })

  it('lets one import of a workspace run at a time, even when two claims race', async () => {
    const ws = await workspace()
    const [a, b] = [await site(ws), await site(ws)]
    const results = await Promise.all([store.claim(a), store.claim(b)])
    expect(results.map((result) => result.kind).sort()).toEqual(['busy', 'claimed'])
    // Another workspace is not held back.
    expect((await store.claim(await site(await workspace()))).kind).toBe('claimed')
  })

  it('fails the stage of a site that is not being connected any more', async () => {
    const ws = await workspace()
    const id = await site(ws, { status: 'archived' })
    expect(await store.claim(id)).toEqual({ kind: 'refused', workspaceId: ws, leaseEpoch: 0 })
    expect(await row(id)).toMatchObject({
      status: 'failed',
      errorCode: 'access_refused',
      finishedAt: expect.any(Date),
    })
  })

  it('fences every write by the epoch of the claim', async () => {
    const id = await site(await workspace())
    const lease = await claimed(id)
    expect(await store.heartbeat(lease)).toBe(true)
    await store.setStep(lease, 'publish')
    expect((await row(id)).step).toBe('publish')

    const stale = { ...lease, leaseEpoch: lease.leaseEpoch + 1 }
    expect(await store.heartbeat(stale)).toBe(false)
    await expect(store.setStep(stale, 'fetch')).rejects.toMatchObject({ name: 'LeaseLost' })
    await expect(store.fail(stale, 'internal')).rejects.toMatchObject({ name: 'LeaseLost' })
    await expect(store.readAccess(stale)).rejects.toMatchObject({ name: 'LeaseLost' })
    expect((await row(id)).status).toBe('running')
  })

  it('reads the access rows of a held stage', async () => {
    const ws = await workspace()
    const id = await site(ws)
    const access = await store.readAccess(await claimed(id))
    expect(access).toEqual({
      siteStatus: 'onboarding',
      workspaceId: ws,
      source: expect.objectContaining({
        kind: 'ftp',
        host: 'files.example.test',
        port: 21,
        rootPath: '/www',
        tls: 'verified',
        hostKey: null,
      }),
      reference: {
        kind: 'ftp',
        siteId: id,
        workspaceId: ws,
        vaultPath: `kv/sites/${id}/ftp`,
        keyVersion: 3,
      },
      database: null,
    })
  })

  it('reads the database row of a site and its reference along with the source', async () => {
    const ws = await workspace()
    const id = await site(ws)
    const reference = await db.credentialRef.create({
      data: {
        workspaceId: ws,
        siteId: id,
        kind: 'db',
        vaultPath: `kv/sites/${id}/db`,
        keyVersion: 4,
      },
    })
    await db.siteDatabase.create({
      data: {
        siteId: id,
        engine: 'mysql',
        host: 'db.example.test',
        port: 3306,
        databaseName: 'wordpress',
        tls: 'verified',
        credentialRefId: reference.id,
      },
    })
    expect((await store.readAccess(await claimed(id))).database).toEqual({
      row: {
        engine: 'mysql',
        host: 'db.example.test',
        port: 3306,
        databaseName: 'wordpress',
        tls: 'verified',
        credentialRefId: reference.id,
      },
      reference: {
        kind: 'db',
        siteId: id,
        workspaceId: ws,
        vaultPath: `kv/sites/${id}/db`,
        keyVersion: 4,
      },
    })
  })

  it('names the timeouts of PostgreSQL hiccups and a refused statement an answer', async () => {
    const statement = await db
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', '50ms', true)`
        await tx.$queryRaw`SELECT pg_sleep(2)`
      })
      .catch((error: unknown) => error)
    expect(isTransientDatabaseError(statement)).toBe(true)

    const id = await site(await workspace())
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked = () => {}
    const taken = new Promise<void>((resolve) => (locked = resolve))
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM site_provisioning_stages WHERE site_id = ${id}::uuid FOR UPDATE`
      locked()
      await held
    })
    await taken
    const lock = await db
      .$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '50ms', true)`
        await tx.$queryRaw`SELECT 1 FROM site_provisioning_stages WHERE site_id = ${id}::uuid FOR UPDATE`
      })
      .catch((error: unknown) => error)
    release()
    await holder
    expect(isTransientDatabaseError(lock)).toBe(true)

    const refused = await db.$queryRaw`SELECT 1 / 0`.catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(isTransientDatabaseError(refused)).toBe(false)
  })

  it('records one repository per site and refuses a name another site holds', async () => {
    const ws = await workspace()
    const id = await site(ws)
    const lease = await claimed(id)
    const repository = {
      provider: 'gitea' as const,
      owner: 'sites',
      name: `site-${id}`,
      url: `https://gitea.raditi.test/sites/site-${id}`,
    }
    const first = await store.recordRepository(lease, repository)
    expect(
      await store.recordRepository(lease, { ...repository, url: `${repository.url}-moved` }),
    ).toBe(first)
    expect(await db.gitRepository.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      siteId: id,
      defaultBranch: 'main',
      url: `${repository.url}-moved`,
    })

    const other = await site(await workspace())
    await expect(store.recordRepository(await claimed(other), repository)).rejects.toMatchObject({
      code: 'repository_not_created',
    })
  })

  it('replaces a plan until it is imported, then keeps it; success confirms it', async () => {
    const id = await site(await workspace())
    const lease = await claimed(id)
    const gitRepositoryId = await store.recordRepository(lease, {
      provider: 'gitea',
      owner: 'sites',
      name: `site-${id}`,
      url: `https://gitea.raditi.test/sites/site-${id}`,
    })
    await store.recordPlan(
      lease,
      { gitRepositoryId, commitSha: OTHER_SHA, files: 1, bytes: 2 },
      { files: 1, bytes: 2 },
    )
    await store.recordPlan(
      lease,
      { gitRepositoryId, commitSha: SHA, files: 3, bytes: 40 },
      { files: 3, bytes: 40, skipped: { excluded: 2 } },
    )
    expect(await store.readPlan(id)).toEqual({
      gitRepositoryId,
      commitSha: SHA,
      files: 3,
      bytes: 40,
      leaseEpoch: 1,
      importedAt: null,
    })
    await expect(store.succeed(lease, OTHER_SHA)).rejects.toMatchObject({
      code: 'repository_mismatch',
    })
    await store.succeed(lease, SHA)
    expect(await row(id)).toMatchObject({
      status: 'succeeded',
      step: null,
      heartbeatAt: null,
      errorCode: null,
      finishedAt: expect.any(Date),
      summary: { files: 3, bytes: 40, skipped: { excluded: 2 } },
    })
    expect((await store.readPlan(id))?.importedAt).toBeInstanceOf(Date)
    // The tag of the row is the initial tag.
    expect((await db.siteInitialVersion.findUniqueOrThrow({ where: { siteId: id } })).tag).toBe(
      'v0.0.0',
    )
    // The first version is the installed one, and the site with its repository takes tasks.
    expect(await db.site.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'active',
      installedVersion: 'v0.0.0',
      installedSha: SHA,
      installedAt: expect.any(Date),
      installedReleaseId: null,
    })
  })

  it('requeues a hiccup with its outbox event and fails it at the limit of the attempt', async () => {
    const id = await site(await workspace())
    let lease = await claimed(id)
    const before = Date.now()
    expect(await store.retry(lease, 'unreachable', 30_000)).toBe('requeued')
    expect(await row(id)).toMatchObject({
      status: 'queued',
      enqueues: 2,
      step: null,
      heartbeatAt: null,
    })
    const event = await db.outboxEvent.findUniqueOrThrow({
      where: { dedupeKey: siteProvisionDedupeKey(id, 'code_import', 1, 2) },
    })
    expect(event).toMatchObject({
      topic: 'site-import',
      type: 'site.provision',
      payload: { siteId: id, stage: 'code_import' },
    })
    expect(event.availableAt.getTime()).toBeGreaterThanOrEqual(before + 29_000)

    await db.siteProvisioningStage.update({
      where: { siteId_stage: { siteId: id, stage: 'code_import' } },
      data: { enqueues: provisioningLimits.enqueuesPerAttempt },
    })
    lease = await claimed(id)
    expect(await store.retry(lease, 'unreachable', 30_000)).toBe('failed')
    expect(await row(id)).toMatchObject({ status: 'failed', errorCode: 'unreachable' })
  })

  it('releases a stage at shutdown after releaseDelayMs', async () => {
    const id = await site(await workspace())
    const lease = await claimed(id)
    const before = Date.now()
    expect(await store.release(lease)).toBe('requeued')
    const event = await db.outboxEvent.findUniqueOrThrow({
      where: { dedupeKey: siteProvisionDedupeKey(id, 'code_import', 1, 2) },
    })
    expect(event.availableAt.getTime()).toBeGreaterThanOrEqual(
      before + provisioningLimits.releaseDelayMs - 1_000,
    )
  })

  it('sweeps silent stages back to the queue or to interrupted, and lists waiting ones', async () => {
    const ws = await workspace()
    const [silent, exhausted, alive, waiting] = [
      await site(ws),
      await site(await workspace()),
      await site(await workspace()),
      await site(await workspace()),
    ]
    for (const id of [silent, exhausted, alive]) await claimed(id)
    await db.$executeRaw`
      UPDATE site_provisioning_stages SET heartbeat_at = now() - interval '10 minutes'
      WHERE site_id IN (${silent}::uuid, ${exhausted}::uuid)`
    await db.$executeRaw`
      UPDATE site_provisioning_stages SET enqueues = ${provisioningLimits.enqueuesPerAttempt}::int
      WHERE site_id = ${exhausted}::uuid`
    await db.$executeRaw`
      UPDATE site_provisioning_stages SET updated_at = now() - interval '10 minutes'
      WHERE site_id = ${waiting}::uuid`

    const swept = await store.sweepSilent()
    expect(swept.requeued.filter((stage) => sites.includes(stage.siteId))).toEqual([
      { siteId: silent, workspaceId: ws, attempt: 1, enqueues: 2, leaseEpoch: 1 },
    ])
    expect(
      swept.interrupted
        .filter((stage) => sites.includes(stage.siteId))
        .map((stage) => stage.siteId),
    ).toEqual([exhausted])
    expect(await row(silent)).toMatchObject({ status: 'queued', enqueues: 2, heartbeatAt: null })
    expect(await row(exhausted)).toMatchObject({ status: 'failed', errorCode: 'interrupted' })
    expect((await row(alive)).status).toBe('running')
    expect(
      await db.outboxEvent.count({
        where: { dedupeKey: siteProvisionDedupeKey(silent, 'code_import', 1, 2) },
      }),
    ).toBe(1)
    expect((await store.waiting()).filter((stage) => sites.includes(stage.siteId))).toEqual([
      { siteId: waiting, attempt: 1 },
    ])
  })

  it('names the oldest other queued import of a workspace as the next one', async () => {
    const ws = await workspace()
    const [ended, older, newer] = [await site(ws), await site(ws), await site(ws)]
    await db.$executeRaw`
      UPDATE site_provisioning_stages SET updated_at = now() - interval '1 minute'
      WHERE site_id = ${older}::uuid`
    expect(await store.nextQueued(ws, ended)).toEqual({ siteId: older, attempt: 1 })
    expect(await store.nextQueued(ws, older)).not.toEqual({ siteId: older, attempt: 1 })
    expect(newer).toBeTruthy()
  })
})
