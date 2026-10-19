import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'

import { createPrismaClient, markStaleCandidates, type PrismaClient } from '@repo/db'
import {
  conflict,
  previewAccessPath,
  previewDatabaseSecretPath,
  previewBrowserSecretPath,
  previewBrowserSecretSchema,
  previewHostname,
  siteAccessPath,
  siteWorkspaceRules,
  type ContentWriteRequest,
  type DatabaseCopier,
  type DbPlan,
  type PublishedContentGateway,
  type SiteFacts,
  type SiteRuntime,
  type PreviewUpstream,
  type TurnPlan,
} from '@repo/domain'
import { wordpressAdapter } from '@repo/site-adapters'
import { createHostLookup, siteSource } from '@repo/site-connections'
import { databaseInspector } from '@repo/site-connections/databases'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { PreviewsConfig } from '../config/config.ts'
import { sampleDriverId } from '../testing/ids.ts'
import {
  contentAdapter,
  contentGateway,
  fakeCatalog,
  fakeCopier,
  FakeGit,
  FakeRuntime,
  hash,
  MemoryStorage,
  MemoryVault,
  upstreamServer,
  workingTreeArchive,
  recordValues,
} from '../testing/previews.ts'
import { PreviewManager } from './preview-manager.ts'
import { previewRecordOf } from './preview-record.ts'
import { createPreviewSiteSources } from './site-sources.ts'

// The manager of previews over PostgreSQL with its runtime, copier, git, storage and Vault faked
// (docs/plan/53-chat-preview-release.md, R5c). Runs on a disposable database only:
// RADITI_GATEWAY_DB_TESTS=1 with DATABASE_URL.

const siteFacts: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/',
  extras: {},
}
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl) && process.env.RADITI_GATEWAY_DB_TESTS === '1'
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const main = 'a'.repeat(40)
const candidateHead = 'c'.repeat(40)
const turnCredentials = {
  llmApiKey: 'synthetic-turn-key-0123456789abcdef',
  mcpToken: 'synthetic-mcp-token-fedcba9876543210',
}

const config: PreviewsConfig = {
  address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
  ttlHours: 72,
  executor: 'local',
  runtime: 'runc',
  webImages: { '8.3': `registry.invalid/web@sha256:${'1'.repeat(64)}` },
  images: {
    db: `registry.invalid/db@sha256:${'2'.repeat(64)}`,
    cli: `registry.invalid/cli@sha256:${'3'.repeat(64)}`,
    forwarder: `registry.invalid/tools@sha256:${'4'.repeat(64)}`,
    browser: `registry.invalid/browser@sha256:${'5'.repeat(64)}`,
    egress: null,
  },
  upstreamHost: '127.0.0.1',
  gatewayPort: 8090,
  egressRefusedSubnets: [],
  docker: { socketPath: '/var/run/docker.sock', firewallImage: null },
}

/** A gateway whose plugin tells what its server runs; without `runtime` it cannot tell. */
const withRuntime = (
  gateway: PublishedContentGateway,
  runtime: SiteRuntime | undefined,
): PublishedContentGateway => (runtime ? { ...gateway, runtime: async () => runtime } : gateway)

describe.skipIf(!enabled)('the manager of previews with PostgreSQL', () => {
  let db: PrismaClient
  let server: Server
  let upstream: PreviewUpstream
  const workspaces: string[] = []

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    ;({ server, upstream } = await upstreamServer())
  })
  afterEach(async () => {
    const ids = workspaces.splice(0)
    const of = { task: { workspaceId: { in: ids } } }
    const previews = await db.previewEnvironment.findMany({ where: of, select: { id: true } })
    for (const preview of previews)
      await db.outboxEvent.deleteMany({
        where: { dedupeKey: { startsWith: `preview.sync:${preview.id}:` } },
      })
    await db.previewDbOperation.deleteMany({ where: of })
    await db.mcpCall.deleteMany({ where: { turn: of } })
    await db.snapshot.deleteMany({ where: { site: { workspaceId: { in: ids } } } })
    await db.previewEnvironment.deleteMany({ where: of })
    await db.site.updateMany({
      where: { workspaceId: { in: ids } },
      data: {
        installedReleaseId: null,
        installedVersion: null,
        installedSha: null,
        installedAt: null,
      },
    })
    await db.siteRelease.deleteMany({ where: of })
    await db.turnAssignment.deleteMany({ where: of })
    await db.siteLease.deleteMany({ where: { site: { workspaceId: { in: ids } } } })
    await db.task.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.gitRepository.deleteMany({ where: { site: { workspaceId: { in: ids } } } })
    await db.credentialRef.deleteMany({ where: { site: { workspaceId: { in: ids } } } })
    await db.site.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.workspace.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function dialog(status: 'awaiting_approval' | 'running' | 'done' = 'awaiting_approval') {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic preview verification', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Preview test',
        url: `https://${randomUUID()}.example.invalid`,
        stack: 'wordpress',
      },
    })
    await db.gitRepository.create({
      data: {
        siteId: site.id,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${site.id}`,
        url: `https://gitea.invalid/sites/site-${site.id}.git`,
      },
    })
    await db.credentialRef.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        kind: 'db',
        vaultPath: siteAccessPath(site.id, 'db'),
        keyVersion: 1,
      },
    })
    const task = await db.task.create({
      data: { workspaceId: workspace.id, siteId: site.id, status, turnNo: 1 },
    })
    const preview = await db.previewEnvironment.create({
      data: {
        siteId: site.id,
        taskId: task.id,
        status: 'pending',
        dbMode: 'copy',
        hostname: previewHostname({ siteAlias: site.alias, taskAlias: task.alias }, 'localhost'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    return { workspace, site, task, preview }
  }

  function manager(
    options: {
      production?: Map<string, string> | null
      previewStates?: Map<string, string>
      writes?: ContentWriteRequest[]
      exportArchive?: Uint8Array
      exportDeletes?: string[]
      copier?: DatabaseCopier
      /** What the plugins of production and of the preview say their servers run. */
      runtimes?: { production?: SiteRuntime; preview?: SiteRuntime }
    } = {},
  ) {
    const runtime = new FakeRuntime(upstream)
    const git = new FakeGit(main)
    const storage = new MemoryStorage()
    const vault = new MemoryVault()
    const previewStates =
      options.previewStates ??
      new Map([
        ['post:1', hash('a')],
        ['post:2', hash('b')],
        ['page:3', hash('c')],
      ])
    const production =
      options.production === undefined
        ? new Map([
            ['post:1', hash('a')],
            ['post:2', hash('9')],
            ['page:3', hash('c')],
          ])
        : options.production
    const exportCalls: unknown[] = []
    const m = new PreviewManager(
      {
        db,
        config,
        runtime,
        copier: options.copier ?? fakeCopier(),
        catalog: fakeCatalog(),
        // No file source in these sites: the prefix comes from the catalog.
        sources: createPreviewSiteSources({
          db,
          secrets: vault,
          sources: siteSource,
          databases: databaseInspector,
          lookup: createHostLookup(),
          appEnv: 'test',
        }),
        git,
        storage,
        secrets: vault,
        adapters: () => wordpressAdapter,
        contentAdapters: () =>
          contentAdapter(
            withRuntime(contentGateway(previewStates, options.writes), options.runtimes?.preview),
          ),
        production: async () => {
          if (!production) throw new Error('unreachable')
          return withRuntime(contentGateway(production), options.runtimes?.production)
        },
        values: recordValues(async (_owner, objectRef) => ({
          version: 1,
          objectRef,
          kind: 'post',
          title: 'Новый',
          content: 'C',
          excerpt: '',
          stateHash: hash('e'),
        })),
        executor: {
          exportWorkingTree: async (input) => {
            exportCalls.push(input)
            return {
              archive: options.exportArchive ?? workingTreeArchive({}),
              deletes: options.exportDeletes ?? [],
            }
          },
        },
        credentials: { recover: async () => turnCredentials },
      },
      { heartbeatMs: 60_000 },
    )
    return { m, runtime, git, storage, vault, exportCalls, previewStates }
  }

  async function databaseAccess(f: ReturnType<typeof manager>, siteId: string) {
    await f.vault.kvWrite(siteAccessPath(siteId, 'db'), {
      v: '1',
      engine: 'mysql',
      host: 'db.example.invalid',
      port: '3306',
      tls: 'verified',
      database: 'wp',
      username: 'wp',
      password: 'synthetic-password-1',
    })
  }

  it('builds a new preview to the base of its dialog', async () => {
    const { site, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    expect(await f.m.refresh(preview.id, { requested: true })).toBe(true)

    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row).toMatchObject({
      status: 'ready',
      upstreamHost: upstream.host,
      upstreamPort: upstream.port,
      revision: 0,
      candidateId: null,
      filesSha: main,
      dirty: false,
      writeEpoch: 1,
      seedObjectKey: `previews/${site.id}/${preview.id}/seed.sql.zst.enc`,
      seedReleaseId: null,
      heartbeatAt: null,
    })
    expect(previewRecordOf(row.runtime)).toMatchObject({
      database: { tablePrefix: 'wp_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
      seedChecked: true,
      sync: null,
    })
    expect(f.runtime.calls).toEqual(['ensure', 'writeFiles', 'loadDatabase'])
    expect(f.runtime.specs[0]).toMatchObject({
      previewId: preview.id,
      hostname: preview.hostname,
      origin: `http://${preview.hostname}:8090`,
      productionOrigin: site.url,
      images: { egress: null },
    })
    expect(f.runtime.writes[0]).toMatchObject({ replace: true, deletes: [] })
    expect(f.runtime.writes[0]!.platform!.map((file) => file.path)).toEqual([
      'wp-config.php',
      'wp-content/mu-plugins/raditi-content.php',
      'wp-content/mu-plugins/raditi-preview.php',
    ])
    expect(f.runtime.seeds).toEqual(['INSERT INTO `wp_posts` VALUES (1);\n'])
    expect(f.storage.objects.has(row.seedObjectKey!)).toBe(true)
    // The account of the platform for the mcp role, with the origin of the preview.
    expect(f.vault.kv.get(previewAccessPath(preview.id, 'wp'))?.data).toEqual({
      v: '1',
      username: 'raditi-platform',
      applicationPassword: 'abcd efgh ijkl',
      origin: `http://${preview.hostname}:8090`,
    })
    // post:2 differs from production: the agent may not edit it in this preview.
    expect(
      (await db.previewSeedMismatch.findMany({ where: { previewId: preview.id } })).map(
        (mismatch) => mismatch.objectRef,
      ),
    ).toEqual(['post:2'])
    // The passwords of its database: made once in Vault, handed to the runtime on each build.
    const stored = f.vault.kv.get(previewDatabaseSecretPath(preview.id))!
    const passwords = { user: stored.data.user, root: stored.data.root }
    expect(stored).toMatchObject({ version: 1, data: { v: '1' } })
    expect(passwords.user).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(passwords.root).not.toBe(passwords.user)
    expect(f.runtime.secrets[0]).toEqual({ env: {}, database: passwords })
    expect(f.runtime.databasePasswords).toEqual([passwords])
    // The runtime lost it (a restart of the host): the next build gets the same passwords.
    f.runtime.running.delete(preview.id)
    await f.m.refresh(preview.id, { requested: true, lost: true })
    expect(f.runtime.secrets).toHaveLength(2)
    expect(f.vault.kv.get(previewDatabaseSecretPath(preview.id))?.version).toBe(1)
    expect(f.runtime.secrets.at(-1)).toEqual({ env: {}, database: passwords })
  })

  it('runs on the closest PHP to the site’s and keeps what the preview lacks (Р2, Р18)', async () => {
    const { site, preview } = await dialog()
    const runtime = (runtimeVersion: string, extensions: string[]): SiteRuntime => ({
      version: 1,
      kind: 'runtime',
      runtimeVersion,
      extensions,
    })
    const f = manager({
      runtimes: {
        production: runtime('7.4', ['curl', 'imagick', 'zend opcache']),
        preview: runtime('8.3', ['curl', 'zend opcache']),
      },
    })
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    // The recipe asks for the site's own version first; the host runs the closest it has.
    expect(f.runtime.specs[0]!.recipe.runtimeVersions[0]).toBe('7.4')
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(previewRecordOf(row.runtime).runtimeMatch).toEqual({
      production: '7.4',
      preview: '8.3',
      missing: ['imagick'],
    })
  })

  it('destroys what is left of a preview it cannot take over and builds it anew', async () => {
    const { site, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    f.runtime.failNextEnsure = conflict('The database of this preview was lost')
    await f.m.refresh(preview.id, { requested: true })
    expect(f.runtime.calls).toEqual(['ensure', 'destroy', 'ensure', 'writeFiles', 'loadDatabase'])
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } }),
    ).toMatchObject({ status: 'ready' })
  })

  it('holds every object of the copy back while production cannot be asked', async () => {
    const { site, preview } = await dialog()
    const f = manager({ production: null })
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(previewRecordOf(row.runtime).seedChecked).toBe(false)
    expect(await db.previewSeedMismatch.count({ where: { previewId: preview.id } })).toBe(3)
  })

  it('rebuilds to a candidate: its plan replayed, its checks recorded, earlier ones stale', async () => {
    const { site, task, preview } = await dialog()
    const writes: ContentWriteRequest[] = []
    const f = manager({ writes })
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    const value = { key: `tasks/${task.id}/db/x/after.json`, sha256: hash('f'), sizeBytes: 10 }
    const plan = [
      {
        kind: 'content_update',
        objectRef: 'post:1',
        fields: ['title'],
        beforeHash: hash('a'),
        afterHash: hash('e'),
        before: value,
        after: value,
      },
    ] as DbPlan
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: task.id,
        revision: 1,
        turnNo: 1,
        baseSha: main,
        baseTree: 'b'.repeat(40),
        headSha: candidateHead,
        files: [
          {
            path: 'wp-content/themes/shop/functions.php',
            change: 'modified',
            sizeBytes: 10,
            executable: false,
          },
        ],
        dbPlan: plan as object,
        dbPlanSha256: hash('d'),
        proposedBump: 'patch',
        proposedVersion: 'v0.0.1',
        facts: {},
        previewRevision: 1,
      },
    })
    await db.candidateCheck.createMany({
      data: [
        { candidateId: candidate.id, revision: 1, kind: 'php_lint' },
        { candidateId: candidate.id, revision: 1, kind: 'preview_smoke' },
      ],
    })
    f.runtime.lintFailures = ['wp-content/themes/shop/functions.php']
    await f.m.refresh(preview.id, { requested: true })

    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row).toMatchObject({
      status: 'ready',
      revision: 1,
      candidateId: candidate.id,
      filesSha: candidateHead,
      writeEpoch: 2,
    })
    // The containers were kept: the files go as a difference of the two commits.
    expect(f.runtime.writes[1]).toMatchObject({ replace: false })
    expect(f.git.exports[1]).toEqual({
      sha: candidateHead,
      paths: ['wp-content/themes/shop/style.css'],
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      siteId: preview.id,
      epoch: 2,
      objectRef: 'post:1',
      expectedStateHash: hash('a'),
      mode: 'restore',
      fields: { title: 'Новый' },
    })
    const checks = await db.candidateCheck.findMany({
      where: { candidateId: candidate.id },
      orderBy: { kind: 'asc' },
    })
    expect(checks.map((check) => [check.kind, check.status, check.summary])).toEqual([
      ['php_lint', 'failed', { files: 1, failed: 1 }],
      ['preview_smoke', 'passed', { pages: 2, failed: 0 }],
    ])
  })

  it('takes no seed while a release holds the site and asks again later', async () => {
    const { site, task, preview } = await dialog()
    await db.siteLease.create({
      data: {
        siteId: site.id,
        operation: 'deploy',
        holderTaskId: task.id,
        epoch: 1,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      },
    })
    const f = manager()
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row).toMatchObject({ status: 'pending', writeEpoch: 0, enqueues: 2, heartbeatAt: null })
    expect(f.runtime.calls).toEqual([])
    const later = await db.outboxEvent.findFirstOrThrow({
      where: { dedupeKey: `preview.sync:${preview.id}:0:2` },
    })
    expect(later.availableAt.getTime()).toBeGreaterThan(Date.now() + 20_000)
  })

  it('throws away a copy a release wrote under and waits for the site', async () => {
    const { site, task, preview } = await dialog()
    let released = false
    const copier: DatabaseCopier = {
      async copy(_input, write) {
        // A release takes the site during the first copy and is done with it before it ends.
        if (!released)
          await db.$executeRaw`
          INSERT INTO site_leases (site_id, operation, holder_task_id, epoch, acquired_at,
            expires_at, updated_at)
          VALUES (${site.id}::uuid, 'deploy', ${task.id}::uuid, 1, now(),
            now() - interval '1 second', now())`
        released = true
        await write(Buffer.from('INSERT INTO `wp_posts` VALUES (1);\n'))
        return {
          tables: 1,
          structureOnly: 0,
          rows: 1,
          bytes: 1,
          sha256: hash('5'),
          serverVersion: null,
        }
      },
    }
    const f = manager({ copier })
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row).toMatchObject({ status: 'building', seedObjectKey: null, seedSha256: null })
    expect(f.storage.objects.size).toBe(0)
    expect(f.runtime.calls).toEqual([])
    expect(
      await db.outboxEvent.count({ where: { dedupeKey: `preview.sync:${preview.id}:0:2` } }),
    ).toBe(1)
    // The site is free again: the next build copies it anew and keeps that copy.
    await f.m.refresh(preview.id, { requested: true })
    const built = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(built.status).toBe('ready')
    expect(f.storage.objects.has(built.seedObjectKey!)).toBe(true)
  })

  it('forgets a seed that is gone and copies the site again', async () => {
    const { site, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    f.storage.objects.clear()
    f.runtime.running.delete(preview.id)
    await f.m.refresh(preview.id, { requested: true, lost: true })
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } }),
    ).toMatchObject({ status: 'failed', errorCode: 'seed_missing', seedObjectKey: null })
    await f.m.refresh(preview.id, { requested: true })
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row.status).toBe('ready')
    expect(f.storage.objects.has(row.seedObjectKey!)).toBe(true)
  })

  it('never replays an unreadable plan as an empty one', async () => {
    const { site, task, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    await db.taskCandidate.create({
      data: {
        taskId: task.id,
        revision: 1,
        turnNo: 1,
        baseSha: main,
        baseTree: 'b'.repeat(40),
        headSha: candidateHead,
        dbPlan: [{ kind: 'drop_everything' }],
        dbPlanSha256: hash('d'),
        proposedBump: 'patch',
        proposedVersion: 'v0.0.1',
        facts: {},
      },
    })
    await f.m.refresh(preview.id, { requested: true })
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } }),
    ).toMatchObject({ status: 'failed', errorCode: 'plan_invalid', revision: 0 })
  })

  it('rebuilds a preview the agent wrote content into when the same revision is asked', async () => {
    const { site, task, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    await f.m.refresh(preview.id, { requested: true })
    expect(f.runtime.calls.filter((call) => call === 'loadDatabase')).toHaveLength(1)

    // A write of a pass that failed afterwards: its operation is out of the plan (R3), the copy
    // still holds it. The row of the journal with its assignment and snapshot (no turn key: the
    // key id is not a reference); the database user of the stands may not switch triggers off.
    const turn = await db.taskTurn.create({
      data: { taskId: task.id, turnNo: 1, status: 'failed', driverId: sampleDriverId, image },
    })
    const assignment = await db.turnAssignment.create({
      data: {
        taskId: task.id,
        siteId: site.id,
        sessionId: 'synthetic-session',
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 60_000),
        outcome: 'failed',
        finishedAt: new Date(),
      },
    })
    const snapshot = await db.snapshot.create({
      data: {
        siteId: site.id,
        taskId: task.id,
        previewId: preview.id,
        objectRef: 'post:1',
        s3Key: `snapshots/${randomUUID()}.json`,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const call = randomUUID()
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO mcp_calls (id, turn_id, tool, idempotency_key, assignment_id,
          credential_key_id, preview_id, preview_write_epoch, request_hash, lease_epoch,
          snapshot_id, object_ref)
        VALUES (${call}::uuid, ${turn.id}::uuid, 'wp_rest', ${`synthetic-${call}`},
          ${assignment.id}::uuid, ${randomUUID()}::uuid, ${preview.id}::uuid, 1, ${hash('1')},
          1, ${snapshot.id}::uuid, 'post:1')`
      await tx.previewDbOperation.create({
        data: {
          taskId: task.id,
          previewId: preview.id,
          turnNo: 1,
          mcpCallId: call,
          kind: 'content_update',
          objectRef: 'post:1',
          fields: ['title'],
          beforeHash: hash('a'),
          afterHash: hash('e'),
          beforeObjectKey: `tasks/${task.id}/db/${call}/before.json`,
          beforeSha256: hash('2'),
          beforeBytes: 10,
          afterObjectKey: `tasks/${task.id}/db/${call}/after.json`,
          afterSha256: hash('3'),
          afterBytes: 10,
          excluded: true,
        },
      })
    })
    await f.m.refresh(preview.id, { requested: true })
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row).toMatchObject({ status: 'ready', writeEpoch: 2, revision: 0 })
    expect(f.runtime.calls.filter((call) => call === 'loadDatabase')).toHaveLength(2)
    // The write of the old epoch does not count any more.
    await f.m.refresh(preview.id, { requested: true })
    expect(f.runtime.calls.filter((call) => call === 'loadDatabase')).toHaveLength(2)
  })

  it('marks stale a candidate older than the installed release, never one on the new main', async () => {
    const { site, task, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    const candidate = (revision: number, baseSha: string) =>
      db.taskCandidate.create({
        data: {
          taskId: task.id,
          revision,
          turnNo: 1,
          baseSha,
          baseTree: 'b'.repeat(40),
          headSha: candidateHead,
          dbPlanSha256: hash('d'),
          proposedBump: 'patch',
          proposedVersion: 'v0.0.1',
          facts: {},
        },
      })
    const old = await candidate(1, main)
    // Another dialog's release installs: its commit is the new `main`.
    const installedSha = 'f'.repeat(40)
    const release = await db.siteRelease.create({
      data: {
        siteId: site.id,
        taskId: task.id,
        candidateId: old.id,
        candidateRevision: 1,
        attempt: 1,
        releaseKey: hash('7'),
        version: 'v1.0.0',
        tag: 'v1.0.0',
        bump: 'major',
        mainBeforeSha: main,
        approvedSha: installedSha,
        mainPushedAt: new Date(),
        status: 'installed',
        committedAt: new Date(),
        approvedAt: new Date(),
      },
    })
    await db.$executeRaw`UPDATE sites SET installed_release_id = ${release.id}::uuid,
      installed_version = 'v1.0.0', installed_sha = ${installedSha}, installed_at = now()
      WHERE id = ${site.id}::uuid`
    expect(await markStaleCandidates(db, { siteId: site.id })).toEqual([old.id])

    // «Обновить»: a new candidate on the new main while the preview still holds the old seed.
    await db.taskCandidate.update({
      where: { id: old.id },
      data: { status: 'superseded', supersededAt: new Date() },
    })
    const fresh = await candidate(2, installedSha)
    expect(await markStaleCandidates(db, { siteId: site.id })).toEqual([])
    await f.m.sweep()
    await f.m.idle()
    expect((await db.taskCandidate.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(
      'current',
    )
  })

  it('says why a preview cannot be built, and keeps the code of a failure', async () => {
    const { site, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    f.git.missing = ['wp-includes/version.php']
    await f.m.refresh(preview.id, { requested: true })
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } }),
    ).toMatchObject({ status: 'unavailable', unavailableReason: 'no_core', upstreamHost: null })

    const other = await dialog()
    const g = manager()
    // No access in Vault for the reference: the build fails with a code, never a message.
    await g.m.refresh(other.preview.id, { requested: true })
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: other.preview.id } }),
    ).toMatchObject({ status: 'failed', errorCode: 'access_missing' })
  })

  it('destroys the preview of a closed dialog with its secrets and its seed', async () => {
    const { site, task, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    const seedKey = (await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } }))
      .seedObjectKey!
    const request = await db.previewSyncRequest.create({ data: { previewId: preview.id } })
    await db.task.update({ where: { id: task.id }, data: { status: 'done' } })
    await f.m.refresh(preview.id, { requested: true })

    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row).toMatchObject({
      status: 'destroyed',
      upstreamHost: null,
      accessEpoch: 1,
      seedObjectKey: null,
    })
    expect(f.runtime.calls.at(-1)).toBe('destroy')
    expect(f.vault.kv.has(previewAccessPath(preview.id, 'wp'))).toBe(false)
    expect(f.vault.kv.has(previewDatabaseSecretPath(preview.id))).toBe(false)
    expect(f.storage.objects.has(seedKey)).toBe(false)
    expect(
      await db.previewSyncRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).toMatchObject({ errorCode: 'preview_destroyed' })
  })

  it('stops a preview whose time is up and builds it again when it is opened', async () => {
    const { site, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    await db.previewEnvironment.update({
      where: { id: preview.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await f.m.refresh(preview.id, { requested: false })
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } }),
    ).toMatchObject({ status: 'expired', upstreamHost: null })
    expect(f.runtime.calls.at(-1)).toBe('stop')
    await f.m.refresh(preview.id, { requested: true })
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row.status).toBe('ready')
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 70 * 3_600_000)
    // The stopped containers kept their volume: only the difference is written.
    expect(f.runtime.writes.at(-1)).toMatchObject({ replace: false })
  })

  describe('during a turn', () => {
    function plan(ids: { workspaceId: string; siteId: string; taskId: string }): TurnPlan {
      return {
        sandbox: {
          image,
          labels: { ...ids, sessionId: 'session1', turn: 1 },
          runtime: 'runc',
          resources: { cpu: 1, memoryMiB: 256, pids: 64 },
          user: { uid: 10001, gid: 10001 },
          env: {},
          secrets: [],
          network: { mode: 'none' },
          hardTimeoutMs: 600_000,
        },
        context: {
          taskId: ids.taskId,
          sessionId: 'session1',
          turn: 1,
          llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
          mcp: { url: 'http://mcp.invalid/mcp' },
          instructions: 'Synthetic',
        },
        input: { prompt: 'Synthetic', attachments: [] },
        driverId: sampleDriverId,
        driverVersion: '1.0.0',
        workspace: {
          repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
          branch: `agent/${ids.taskId}`,
          expectedBaseSha: main,
          sandboxBaseSha: 'f'.repeat(40),
          ...siteWorkspaceRules(wordpressAdapter, siteFacts),
        },
        committedAt: '2026-10-17T00:00:00.000Z',
      }
    }

    async function running(f: ReturnType<typeof manager>) {
      const d = await dialog('awaiting_approval')
      await databaseAccess(f, d.site.id)
      await f.m.refresh(d.preview.id, { requested: true })
      await db.task.update({ where: { id: d.task.id }, data: { status: 'running' } })
      const assignment = await db.turnAssignment.create({
        data: {
          taskId: d.task.id,
          siteId: d.site.id,
          sessionId: 'session1',
          turnNo: 1,
          executor: 'local',
          plan: plan({
            workspaceId: d.workspace.id,
            siteId: d.site.id,
            taskId: d.task.id,
          }) as object,
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(Date.now() + 600_000),
          containerId: 'container-1',
        },
      })
      return { ...d, assignment }
    }

    it('writes the agent working tree over the files of the preview', async () => {
      const f = manager({
        exportArchive: workingTreeArchive({ 'wp-content/themes/shop/header.php': '<?php echo 2;' }),
        exportDeletes: ['wp-content/themes/shop/old.php'],
      })
      const d = await running(f)
      const request = await db.previewSyncRequest.create({
        data: { previewId: d.preview.id, assignmentId: d.assignment.id },
      })
      expect(await f.m.serveSync(request.id)).toBe(true)

      const answered = await db.previewSyncRequest.findUniqueOrThrow({ where: { id: request.id } })
      expect(answered.errorCode).toBeNull()
      expect(answered.completedAt).not.toBeNull()
      expect(answered.filesDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(f.exportCalls[0]).toMatchObject({
        assignmentId: d.assignment.id,
        containerId: 'container-1',
        baseSha: 'f'.repeat(40),
        labels: { taskId: d.task.id, turn: 1 },
      })
      expect(f.runtime.writes.at(-1)).toMatchObject({
        replace: false,
        deletes: ['wp-content/themes/shop/old.php'],
      })
      const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: d.preview.id } })
      expect(row.dirty).toBe(true)
      expect(previewRecordOf(row.runtime).sync).toEqual({
        assignmentId: d.assignment.id,
        baseSha: main,
        paths: ['wp-content/themes/shop/header.php', 'wp-content/themes/shop/old.php'],
      })

      // The next sync of the turn asks the paths of the earlier one again.
      const second = await db.previewSyncRequest.create({
        data: { previewId: d.preview.id, assignmentId: d.assignment.id },
      })
      await f.m.serveSync(second.id)
      expect(f.exportCalls[1]).toMatchObject({
        alsoPaths: ['wp-content/themes/shop/header.php', 'wp-content/themes/shop/old.php'],
      })
    })

    it('refuses a sync that breaks the rules of a candidate or names no open turn', async () => {
      const f = manager({ exportArchive: workingTreeArchive({ 'wp-config.php': '<?php' }) })
      const d = await running(f)
      const refused = await db.previewSyncRequest.create({
        data: { previewId: d.preview.id, assignmentId: d.assignment.id },
      })
      await f.m.serveSync(refused.id)
      expect(
        await db.previewSyncRequest.findUniqueOrThrow({ where: { id: refused.id } }),
      ).toMatchObject({ errorCode: 'files_refused', filesDigest: null })

      await db.turnAssignment.update({
        where: { id: d.assignment.id },
        data: { finishedAt: new Date(), outcome: 'completed' },
      })
      const late = await db.previewSyncRequest.create({
        data: { previewId: d.preview.id, assignmentId: d.assignment.id },
      })
      await f.m.serveSync(late.id)
      expect(
        await db.previewSyncRequest.findUniqueOrThrow({ where: { id: late.id } }),
      ).toMatchObject({ errorCode: 'no_turn' })
    })

    it("refuses a sync that holds the turn's own key", async () => {
      const f = manager({
        exportArchive: workingTreeArchive({
          'wp-content/themes/shop/header.php': `<?php // ${turnCredentials.mcpToken}`,
        }),
      })
      const d = await running(f)
      const request = await db.previewSyncRequest.create({
        data: { previewId: d.preview.id, assignmentId: d.assignment.id },
      })
      await f.m.serveSync(request.id)
      expect(
        await db.previewSyncRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ errorCode: 'files_refused', filesDigest: null })
    })

    it('starts the browser of the agent with a service ticket and stops it when idle', async () => {
      const f = manager()
      const d = await running(f)
      const request = await db.previewBrowserRequest.create({
        data: { previewId: d.preview.id, assignmentId: d.assignment.id },
      })
      expect(await f.m.serveBrowser(request.id)).toBe(true)
      expect(
        await db.previewBrowserRequest.findUniqueOrThrow({ where: { id: request.id } }),
      ).toMatchObject({ errorCode: null, stoppedAt: null })
      expect(
        (await db.previewBrowserRequest.findUniqueOrThrow({ where: { id: request.id } })).readyAt,
      ).not.toBeNull()
      expect(f.runtime.browsers).toEqual([
        { image: config.images.browser, hostname: d.preview.hostname },
      ])
      const secret = previewBrowserSecretSchema.parse(
        f.vault.kv.get(previewBrowserSecretPath(d.preview.id))?.data,
      )
      expect(secret).toMatchObject({
        requestId: request.id,
        wsEndpoint: 'ws://127.0.0.1:45555',
        wsPath: `/${'s'.repeat(43)}`,
      })
      const ticket = new URL(secret.enterUrl).searchParams.get('t')!
      expect(await db.previewTicket.findMany({ where: { previewId: d.preview.id } })).toMatchObject(
        [{ kind: 'browser', userId: null }],
      )
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)

      await db.previewBrowserRequest.update({
        where: { id: request.id },
        data: { requestedAt: new Date(Date.now() - 20 * 60_000) },
      })
      await f.m.sweep()
      expect(f.runtime.calls).toContain('stopBrowser')
      expect(
        (await db.previewBrowserRequest.findUniqueOrThrow({ where: { id: request.id } })).stoppedAt,
      ).not.toBeNull()
      expect(f.vault.kv.has(previewBrowserSecretPath(d.preview.id))).toBe(false)
    })

    it('never rebuilds a served preview under a pass', async () => {
      const f = manager()
      const d = await running(f)
      await db.previewEnvironment.update({ where: { id: d.preview.id }, data: { dirty: true } })
      const calls = f.runtime.calls.length
      await f.m.refresh(d.preview.id, { requested: true })
      expect(f.runtime.calls.length).toBe(calls)
    })
  })

  it('finishes in its sweep what jobs left: a lost build, lost containers, a closed dialog', async () => {
    const pending = await dialog()
    const f = manager()
    await databaseAccess(f, pending.site.id)
    await db.$executeRaw`UPDATE preview_environments SET updated_at = now() - interval '5 minutes'
      WHERE id = ${pending.preview.id}::uuid`
    // The sweep starts the build beside it and is done before the build is.
    await f.m.sweep()
    await f.m.idle()
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: pending.preview.id } }),
    ).toMatchObject({ status: 'ready', revision: 0 })

    // The daemon restarted: the containers are gone, their port may be another preview's.
    f.runtime.running.delete(pending.preview.id)
    const builds = f.runtime.calls.filter((call) => call === 'ensure').length
    await f.m.sweep()
    await f.m.idle()
    expect(f.runtime.calls.filter((call) => call === 'ensure').length).toBe(builds + 1)
    expect(f.runtime.writes.at(-1)).toMatchObject({ replace: true })

    await db.task.update({ where: { id: pending.task.id }, data: { status: 'cancelled' } })
    await db.$executeRaw`UPDATE preview_environments SET updated_at = now() - interval '5 minutes'
      WHERE id = ${pending.preview.id}::uuid`
    await f.m.sweep()
    await f.m.idle()
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: pending.preview.id } }),
    ).toMatchObject({ status: 'destroyed' })
  })

  it('moves the time to live of a preview on with its last view', async () => {
    const { site, preview } = await dialog()
    const f = manager()
    await databaseAccess(f, site.id)
    await f.m.refresh(preview.id, { requested: true })
    await db.previewEnvironment.update({
      where: { id: preview.id },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    })
    await db.previewTicket.create({
      data: {
        previewId: preview.id,
        kind: 'browser',
        tokenHash: hash('7'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await f.m.sweep()
    const row = await db.previewEnvironment.findUniqueOrThrow({ where: { id: preview.id } })
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000)
    expect(f.runtime.extended.get(preview.id)).toBe(row.expiresAt.getTime())
  })
})
