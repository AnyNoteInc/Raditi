import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createPlaywrightBrowserFactory } from '@repo/browser-providers'
import { createPrismaClient, type PrismaClient } from '@repo/db'
import {
  previewAccessPath,
  previewBrowserSecretPath,
  previewBrowserSecretSchema,
  previewBrowserSocket,
  previewHostname,
  publishedContentHashMaterial,
  siteAccessPath,
  siteWorkspaceRules,
  type DbPlan,
  type SiteFacts,
  type GitProvider,
  type PreviewFilesInput,
  type PreviewRuntime,
  type PublishedContentState,
  type TurnPlan,
} from '@repo/domain'
import { createDockerPreviewRuntime } from '@repo/sandbox-providers'
import { wordpressAdapter, wordpressContentAdapter } from '@repo/site-adapters'
import {
  createMysqlDatabaseCatalog,
  createMysqlDatabaseCopier,
} from '@repo/site-connections/database-copy'
import { siteSource } from '@repo/site-connections'
import { databaseInspector } from '@repo/site-connections/databases'
import { createHostLookup } from '@repo/site-connections/hosting'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { previewContentGateway, previewRequest } from '@repo/site-content'

import type { PreviewsConfig } from '../config/config.ts'
import { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { sampleDriverId } from '../testing/ids.ts'
import { startPreviewApp, type PreviewApp } from '../testing/preview-app.ts'
import {
  MemoryStorage,
  MemoryVault,
  recordValues,
  workingTreeArchive,
} from '../testing/previews.ts'
import { PreviewManager } from './preview-manager.ts'
import { previewRecordOf } from './preview-record.ts'
import { createPreviewSiteSources } from './site-sources.ts'

// A preview end to end on this machine's Docker (docs/plan/53-chat-preview-release.md, R5c): a
// synthetic «production» — MariaDB 11.4.13 with a WordPress 7.1.2 database — a git repository
// with the full tree of the site, the real Docker runtime of previews (runc), the real copier,
// PostgreSQL. The preview is built, opened through its entry forwarder, rebuilt to a candidate
// with a database operation, synced from a turn, given a browser — which opens the preview through
// the gateway of the `preview` app (R6), its build started as a process of its own on
// PREVIEW_GATEWAY_PORT 18090 — and destroyed. Only synthetic data. Needs the images below, the
// site, tools and browser images of infra/preview (README), the image of the host rules
// (infra/sandbox/Dockerfile, `network-guard`, or SANDBOX_NETWORK_GUARD_IMAGE) and
// `pnpm --filter preview build`; runs with
// RADITI_PREVIEW_DOCKER_TESTS=1, RADITI_GATEWAY_DB_TESTS=1 and a disposable DATABASE_URL, with
// port 18090 free on loopback (Docker Desktop) or on the bridge of the host (Linux).

const siteFacts: SiteFacts = {
  stack: 'wordpress',
  url: 'https://shop.example.ru',
  docroot: '/',
  extras: {},
}
const databaseUrl = process.env.DATABASE_URL
const enabled =
  process.env.RADITI_PREVIEW_DOCKER_TESTS === '1' &&
  process.env.RADITI_GATEWAY_DB_TESTS === '1' &&
  Boolean(databaseUrl)
const run = promisify(execFile)
const docker = async (...args: string[]) =>
  (await run('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
const digest = async (tag: string) => {
  const digests = JSON.parse(
    await docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}'),
  ) as string[]
  const found = digests.find((value) => value.startsWith(`${tag.split(':')[0]}@`))
  if (!found) throw new Error(`No digest of ${tag}`)
  return found
}
const WEB = 'wordpress:7.1.2-php8.3-apache'
const DB = 'mariadb:11.4.13'
// The WP-CLI of «production»; a preview has its own in its container (docs/plan/58).
const CLI = 'wordpress:cli-php8.3'
const SITE = 'raditi-preview-site:8.3-local'
const GUARD = 'raditi-network-guard:local'
const TOOLS = 'raditi-preview-tools:local'
const BROWSER = 'raditi-preview-browser:local'
const suffix = randomBytes(4).toString('hex')
const prod = {
  network: `raditi-r5c-prod-${suffix}`,
  db: `raditi-r5c-prod-db-${suffix}`,
  volume: `raditi-r5c-prod-files-${suffix}`,
  password: randomBytes(18).toString('base64url'),
}
const siteUrl = `https://shop-${suffix}.example.ru`
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const stateHash = (state: Omit<PublishedContentState, 'stateHash'>) =>
  createHash('sha256').update(publishedContentHashMaterial(state)).digest('hex')

describe.skipIf(!enabled)('a preview on this machine’s Docker, end to end', () => {
  let db: PrismaClient
  let root = ''
  let config: PreviewsConfig
  let manager: PreviewManager
  let vault: MemoryVault
  let gateway: PreviewApp | undefined
  /** What each write of files asked: the docroot is written as a difference whenever it can. */
  const writes: Array<Omit<PreviewFilesInput, 'archive' | 'platform'> & { bytes: number }> = []
  let runtime: PreviewRuntime
  const recording = (docker_: PreviewRuntime): PreviewRuntime => ({
    ...docker_,
    writeFiles: (previewId, input, signal) => {
      const entry = { replace: input.replace, deletes: input.deletes, bytes: 0 }
      writes.push(entry)
      return docker_.writeFiles(
        previewId,
        {
          ...input,
          archive: (async function* () {
            for await (const chunk of input.archive) {
              entry.bytes += chunk.byteLength
              yield chunk
            }
          })(),
        },
        signal,
      )
    },
  })
  const ids = { workspace: '', site: '', task: '', preview: '', hostname: '', pageId: 0 }
  let mainSha = ''
  let candidateSha = ''
  let exported: Uint8Array = workingTreeArchive({})
  const newTitle = 'Новое название страницы'

  const wpProd = (...args: string[]) =>
    docker(
      'run',
      '--rm',
      '--network',
      prod.network,
      '--user',
      '33:33',
      '--volume',
      `${prod.volume}:/var/www/html`,
      CLI,
      'wp',
      ...args,
    )
  const git = async (cwd: string, ...args: string[]) =>
    (
      await run('git', args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.test',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.test',
        },
      })
    ).stdout.trim()
  const preview = () => db.previewEnvironment.findUniqueOrThrow({ where: { id: ids.preview } })
  const target = async () => {
    const row = await preview()
    return {
      upstream: { host: row.upstreamHost!, port: row.upstreamPort! },
      hostname: row.hostname,
    }
  }
  const page = async (path: string) => {
    const answer = await previewRequest(await target(), {
      method: 'GET',
      path,
      timeoutMs: 30_000,
      maxResponseBytes: 8 * 1024 * 1024,
    })
    return { status: answer.status, body: Buffer.from(answer.body).toString('utf8') }
  }
  const content = async () =>
    previewContentGateway({
      adapter: wordpressContentAdapter,
      previewId: ids.preview,
      origin: `http://${ids.hostname}:8090`,
      access: vault.kv.get(previewAccessPath(ids.preview, 'wp'))!.data,
      target: await target(),
    })

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    const firewallImage = process.env.SANDBOX_NETWORK_GUARD_IMAGE ?? (await digest(GUARD))
    config = {
      address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
      ttlHours: 72,
      idleMinutes: 30,
      executor: 'local',
      runtime: 'runc',
      siteImages: { '8.3': await digest(SITE) },
      images: {
        db: await digest(DB),
        forwarder: await digest(TOOLS),
        browser: await digest(BROWSER),
      },
      upstreamHost: '127.0.0.1',
      dnsServers: ['77.88.8.8', '77.88.8.1'],
      gatewayPort: 18090,
      refusedSubnets: [],
      docker: { socketPath: '/var/run/docker.sock', firewallImage },
    }
    runtime = recording(
      createDockerPreviewRuntime({
        runtime: 'runc',
        gatewayPort: 18090,
        firewallImage,
        dnsServers: [...config.dnsServers],
      }),
    )

    // «Production»: a WordPress database on a MariaDB published on loopback.
    await docker('network', 'create', prod.network)
    await docker('volume', 'create', prod.volume)
    await docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      prod.db,
      '--network',
      prod.network,
      '--network-alias',
      'db',
      '--tmpfs',
      '/var/lib/mysql',
      '--publish',
      '127.0.0.1::3306',
      '--env',
      'MARIADB_RANDOM_ROOT_PASSWORD=1',
      '--env',
      'MARIADB_DATABASE=shop',
      '--env',
      'MARIADB_USER=shop',
      '--env',
      `MARIADB_PASSWORD=${prod.password}`,
      DB,
    )
    await docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--volume',
      `${prod.volume}:/var/www/html`,
      '--entrypoint',
      'sh',
      WEB,
      '-c',
      'cp -a /usr/src/wordpress/. /var/www/html/ && chown -R 33:33 /var/www/html',
    )
    await wpProd(
      'config',
      'create',
      '--dbname=shop',
      '--dbuser=shop',
      `--dbpass=${prod.password}`,
      '--dbhost=db',
      '--dbprefix=shop_',
      '--dbcharset=utf8mb4',
      '--skip-check',
    )
    for (let attempt = 0; ; attempt += 1)
      try {
        await wpProd('db', 'check', '--quiet')
        break
      } catch (error) {
        if (attempt > 60) throw error
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    await wpProd(
      'core',
      'install',
      `--url=${siteUrl}`,
      '--title=Магазин игрушек',
      '--admin_user=owner',
      `--admin_password=${randomBytes(12).toString('hex')}`,
      '--admin_email=owner@example.invalid',
      '--skip-email',
    )
    ids.pageId = Number(
      await wpProd(
        'post',
        'create',
        '--post_type=page',
        '--post_status=publish',
        '--post_title=О магазине',
        `--post_content=<a href="${siteUrl}/contacts/">Контакты</a>`,
        '--porcelain',
      ),
    )
    const published = (await docker('port', prod.db, '3306/tcp')).split('\n')[0]!
    const port = published.slice(published.lastIndexOf(':') + 1)

    // The repository of the site: the full tree — core, themes, media — as plan 39 imports it.
    root = await mkdtemp(join(tmpdir(), 'raditi-r5c-e2e-'))
    const work = join(root, 'work')
    const remote = join(root, 'remote.git')
    await mkdir(work)
    await docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--volume',
      `${prod.volume}:/src:ro`,
      '--volume',
      `${work}:/out`,
      '--entrypoint',
      'sh',
      WEB,
      '-c',
      `cp -a /src/. /out/ && rm -f /out/wp-config.php && chown -R ${process.getuid!()}:${process.getgid!()} /out`,
    )
    // Production runs the platform's plugin: the repository holds a copy of it, which a preview
    // never takes — the platform writes its own over the tree.
    await mkdir(join(work, 'wp-content/mu-plugins'), { recursive: true })
    await writeFile(
      join(work, 'wp-content/mu-plugins/raditi-content.php'),
      '<?php // the plugin as production has it\n',
    )
    await git(root, 'init', '--bare', '--initial-branch=main', remote)
    await git(work, 'init', '--initial-branch=main')
    await git(work, 'add', '--force', '.')
    await git(work, 'commit', '-qm', 'site')
    mainSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', '-q', remote, 'HEAD:refs/heads/main')

    // The dialog in PostgreSQL, and the access of the site to its database in Vault.
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic preview end to end', dataClass: 'synthetic' },
    })
    const site = await db.site.create({
      data: { workspaceId: workspace.id, name: 'Магазин', url: siteUrl, stack: 'wordpress' },
    })
    const repo = { provider: 'gitea' as const, owner: 'sites', name: `site-${suffix}` }
    await db.gitRepository.create({
      data: { siteId: site.id, ...repo, url: `file://${remote}` },
    })
    await db.credentialRef.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        kind: 'db',
        vaultPath: siteAccessPath(site.id, 'db'),
      },
    })
    const task = await db.task.create({
      data: { workspaceId: workspace.id, siteId: site.id, status: 'awaiting_approval', turnNo: 1 },
    })
    const hostname = previewHostname({ siteAlias: site.alias, taskAlias: task.alias }, 'localhost')
    const row = await db.previewEnvironment.create({
      data: {
        siteId: site.id,
        taskId: task.id,
        status: 'pending',
        dbMode: 'copy',
        hostname,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    Object.assign(ids, {
      workspace: workspace.id,
      site: site.id,
      task: task.id,
      preview: row.id,
      hostname,
    })
    vault = new MemoryVault()
    await vault.kvWrite(siteAccessPath(site.id, 'db'), {
      v: '1',
      engine: 'mysql',
      host: '127.0.0.1',
      port,
      tls: 'plain',
      database: 'shop',
      username: 'shop',
      password: prod.password,
    })

    // A candidate of the agent: one more file of the theme on its branch.
    await writeFile(
      join(work, 'wp-content/themes/twentytwentyfive/raditi-check.php'),
      '<?php\nfunction raditi_check() { return 1; }\n',
    )
    await git(work, 'add', '.')
    await git(work, 'commit', '-qm', 'agent')
    candidateSha = await git(work, 'rev-parse', 'HEAD')
    await git(work, 'push', '-q', remote, `HEAD:refs/heads/agent/${task.id}`)

    const provider = {
      kind: 'gitea',
      getRepository: async () => ({
        ref: repo,
        cloneUrl: remote,
        defaultBranch: 'main',
        private: true,
      }),
      issueCredentials: async () => {
        throw new Error('Local tests must not request real credentials')
      },
    } as unknown as GitProvider
    const git_ = new GitWorkspaceService(provider, {
      transport: { kind: 'local-test', root },
      gitleaksBinary: '/usr/bin/false',
      mirrorDir: join(root, 'mirrors'),
    })
    const connections = { lookup: createHostLookup(), appEnv: 'test' as const }
    manager = new PreviewManager({
      db,
      config,
      runtime,
      copier: createMysqlDatabaseCopier(connections),
      catalog: createMysqlDatabaseCatalog(connections),
      // No file source in this site: the prefix comes from the catalog of production.
      sources: createPreviewSiteSources({
        db,
        secrets: vault,
        sources: siteSource,
        databases: databaseInspector,
        ...connections,
      }),
      git: git_,
      storage: new MemoryStorage(),
      secrets: vault,
      adapters: () => wordpressAdapter,
      contentAdapters: () => wordpressContentAdapter,
      // Production serves no HTTP here: nothing of the copy is known equal to it.
      production: () => Promise.reject(new Error('no production site in this test')),
      values: recordValues(async (_owner, objectRef) => {
        const state = {
          version: 1 as const,
          objectRef,
          kind: 'page' as const,
          title: newTitle,
          content: `<a href="${siteUrl}/contacts/">Контакты</a>`,
          excerpt: '',
        }
        return { ...state, stateHash: stateHash(state) }
      }),
      executor: {
        exportWorkingTree: async () => ({ archive: exported, deletes: [] }),
      },
      credentials: {
        recover: async () => ({
          llmApiKey: 'synthetic-turn-key-0123456789abcdef',
          mcpToken: 'synthetic-mcp-token-fedcba9876543210',
        }),
      },
    })

    // Where the relay of the browser reaches this machine: `host-gateway` of the daemon. On Linux
    // that is the bridge of this host (docker0), where the gateway must listen — on every address,
    // as the network guard of the tests lets a server name no other; Docker Desktop's is another
    // machine, which passes the connection on to this one's loopback.
    const hostGateway = (
      await docker(
        'run',
        '--rm',
        '--add-host=raditi-host:host-gateway',
        '--entrypoint',
        'getent',
        BROWSER,
        'ahostsv4',
        'raditi-host',
      )
    ).split(/\s+/)[0]!
    expect(hostGateway).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    const local = Object.values(networkInterfaces())
      .flat()
      .some((address) => address?.address === hostGateway)
    // The gateway of previews (the `preview` app), where the relay of the agent's browser goes:
    // the relays of its default PREVIEW_BROWSER_RELAYS outside production include the bridges.
    gateway = await startPreviewApp({
      databaseUrl: databaseUrl ?? '',
      address: config.address,
      port: 18090,
      host: local ? '0.0.0.0' : '127.0.0.1',
      appUrl: 'http://localhost:3000',
      sessionSecret: randomBytes(32).toString('base64url'),
    })
  }, 600_000)

  afterAll(async () => {
    // Every step runs even when one throws: stop() of the preview app throws when its network
    // guard refused something or it did not end by SIGTERM, and the containers, the rows and the
    // directory of the suite must not stay behind. The errors fail the run once all have run.
    const errors: unknown[] = []
    const step = async (cleanUp: () => unknown) => {
      try {
        await cleanUp()
      } catch (error) {
        errors.push(error)
      }
    }
    await step(() => gateway?.stop())
    if (ids.preview) await runtime.destroy(ids.preview).catch(() => {})
    await docker('rm', '--force', prod.db).catch(() => {})
    await docker('volume', 'rm', '--force', prod.volume).catch(() => {})
    await docker('network', 'rm', prod.network).catch(() => {})
    if (ids.workspace)
      await step(async () => {
        const of = { task: { workspaceId: ids.workspace } }
        await db.outboxEvent.deleteMany({
          where: { dedupeKey: { startsWith: `preview.sync:${ids.preview}:` } },
        })
        await db.previewEnvironment.deleteMany({ where: of })
        await db.turnAssignment.deleteMany({ where: of })
        await db.task.deleteMany({ where: { workspaceId: ids.workspace } })
        await db.gitRepository.deleteMany({ where: { siteId: ids.site } })
        await db.credentialRef.deleteMany({ where: { siteId: ids.site } })
        await db.site.deleteMany({ where: { workspaceId: ids.workspace } })
        await db.workspace.deleteMany({ where: { id: ids.workspace } })
      })
    await step(() => db?.$disconnect())
    if (root) await step(() => rm(root, { recursive: true, force: true }))
    if (errors.length > 1) throw new AggregateError(errors, 'The cleanup of the suite failed')
    if (errors.length === 1) throw errors[0]
  }, 120_000)

  it('builds the preview from the copy of production and the tree of main', async () => {
    expect(await manager.refresh(ids.preview, { requested: true })).toBe(true)
    const row = await preview()
    expect(row).toMatchObject({ status: 'ready', revision: 0, filesSha: mainSha, errorCode: null })
    // The prefix and the encoding of the copy, as the catalog of production says them.
    expect(previewRecordOf(row.runtime).database).toEqual({
      tablePrefix: 'shop_',
      charset: 'utf8mb4',
      collation: expect.stringMatching(/^utf8mb4_/),
    })
    // Through the entry forwarder with the preview as the Host: the site answers as itself.
    const home = await page('/')
    expect(home.status).toBe(200)
    expect(home.body).toContain('Магазин игрушек')
    expect(home.body).toContain(`http://${ids.hostname}:8090`)
    expect(home.body).not.toContain(siteUrl)
    // Another Host on the same port never reaches PHP (R5a: 421).
    const other = await previewRequest(
      {
        upstream: { host: row.upstreamHost!, port: row.upstreamPort! },
        hostname: 'site-aaaa-chat-bbbb.localhost',
      },
      { method: 'GET', path: '/', timeoutMs: 10_000, maxResponseBytes: 1024 },
    )
    expect(other.status).toBe(421)
    // The account of the platform reads the copy; production could not be asked: none editable.
    const state = await (await content()).read(`page:${ids.pageId}`)
    expect(state.title).toBe('О магазине')
    expect(
      (await db.previewSeedMismatch.findMany({ where: { previewId: ids.preview } })).map(
        (mismatch) => mismatch.objectRef,
      ),
    ).toContain(`page:${ids.pageId}`)
  }, 600_000)

  it('rebuilds to a candidate: its files, its database operation and its checks', async () => {
    const before = await (await content()).read(`page:${ids.pageId}`)
    const after = { ...before, title: newTitle }
    const { stateHash: _old, ...material } = after
    const value = {
      key: `tasks/${ids.task}/db/x/after.json`,
      sha256: 'f'.repeat(64),
      sizeBytes: 10,
    }
    const plan = [
      {
        kind: 'content_update',
        objectRef: `page:${ids.pageId}`,
        fields: ['title'],
        beforeHash: before.stateHash,
        afterHash: stateHash(material),
        before: value,
        after: value,
      },
    ] as DbPlan
    const candidate = await db.taskCandidate.create({
      data: {
        taskId: ids.task,
        revision: 1,
        turnNo: 1,
        baseSha: mainSha,
        baseTree: 'b'.repeat(40),
        headSha: candidateSha,
        files: [
          {
            path: 'wp-content/themes/twentytwentyfive/raditi-check.php',
            change: 'added',
            sizeBytes: 40,
            executable: false,
          },
        ],
        dbPlan: plan as object,
        dbPlanSha256: 'd'.repeat(64),
        proposedBump: 'minor',
        proposedVersion: 'v0.1.0',
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
    await manager.refresh(ids.preview, { requested: true })
    expect(await preview()).toMatchObject({
      status: 'ready',
      revision: 1,
      candidateId: candidate.id,
      filesSha: candidateSha,
    })
    expect((await (await content()).read(`page:${ids.pageId}`)).title).toBe(newTitle)
    const checks = await db.candidateCheck.findMany({ where: { candidateId: candidate.id } })
    expect(checks.map((check) => [check.kind, check.status]).sort()).toEqual([
      ['php_lint', 'passed'],
      ['preview_smoke', 'passed'],
    ])
  }, 600_000)

  it('writes the working tree of a running turn over its files', async () => {
    await db.task.update({ where: { id: ids.task }, data: { status: 'running', turnNo: 2 } })
    const plan: TurnPlan = {
      sandbox: {
        image,
        labels: {
          workspaceId: ids.workspace,
          siteId: ids.site,
          taskId: ids.task,
          sessionId: 'session1',
          turn: 2,
        },
        runtime: 'runc',
        resources: { cpu: 1, memoryMiB: 256, pids: 64 },
        user: { uid: 10001, gid: 10001 },
        env: {},
        secrets: [],
        network: { mode: 'none' },
        hardTimeoutMs: 600_000,
      },
      context: {
        taskId: ids.task,
        sessionId: 'session1',
        turn: 2,
        llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
        mcp: { url: 'http://mcp.invalid/mcp' },
        instructions: 'Synthetic',
      },
      input: { prompt: 'Synthetic', attachments: [] },
      driverId: sampleDriverId,
      driverVersion: '1.0.0',
      workspace: {
        repo: { provider: 'gitea', owner: 'sites', name: `site-${suffix}` },
        branch: `agent/${ids.task}`,
        expectedBaseSha: candidateSha,
        sandboxBaseSha: 'e'.repeat(40),
        ...siteWorkspaceRules(wordpressAdapter, siteFacts),
      },
      committedAt: '2026-10-17T00:00:00.000Z',
    }
    const assignment = await db.turnAssignment.create({
      data: {
        taskId: ids.task,
        siteId: ids.site,
        sessionId: 'session1',
        turnNo: 2,
        executor: 'local',
        plan: plan as object,
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 600_000),
        containerId: `container-${randomUUID()}`,
      },
    })
    exported = workingTreeArchive({
      'wp-content/mu-plugins/raditi-e2e.php':
        '<?php add_action("wp_footer", function () { echo "raditi-e2e-marker"; });\n',
    })
    const request = await db.previewSyncRequest.create({
      data: { previewId: ids.preview, assignmentId: assignment.id },
    })
    const before = writes.length
    expect(await manager.serveSync(request.id)).toBe(true)
    expect(
      await db.previewSyncRequest.findUniqueOrThrow({ where: { id: request.id } }),
    ).toMatchObject({ errorCode: null })
    expect((await page('/')).body).toContain('raditi-e2e-marker')
    // The preview already held the turn's base: nothing of the tree was exported again — an
    // empty archive under the platform's files — and then the one file of the agent.
    expect(writes.slice(before)).toEqual([
      { replace: false, deletes: [], bytes: 1024 },
      { replace: false, deletes: [], bytes: expect.any(Number) },
    ])
    expect(writes.at(-1)!.bytes).toBeLessThan(4096)

    // The browser of the agent for the same turn, stopped once idle.
    const asked = await db.previewBrowserRequest.create({
      data: { previewId: ids.preview, assignmentId: assignment.id },
    })
    expect(await manager.serveBrowser(asked.id)).toBe(true)
    const ready = await db.previewBrowserRequest.findUniqueOrThrow({ where: { id: asked.id } })
    expect(ready.errorCode).toBeNull()
    expect(ready.readyAt).not.toBeNull()
    const secret = previewBrowserSecretSchema.parse(
      vault.kv.get(previewBrowserSecretPath(ids.preview))?.data,
    )
    expect(secret.requestId).toBe(asked.id)
    // The agent's browser enters with its ticket through the relay and the gateway, and sees
    // the preview as synced.
    const origin = `http://${ids.hostname}:8090`
    const browser = await createPlaywrightBrowserFactory().connect({
      endpoint: { wsEndpoint: previewBrowserSocket(secret) },
      origin,
      enterUrl: secret.enterUrl,
      denyRequest: (request) => wordpressAdapter.browserRequestDenied(request),
    })
    try {
      const location = await browser.navigate({ path: '/' })
      expect(location).toMatchObject({ path: '/', status: 200 })
      const snapshot = await browser.snapshot({})
      expect(snapshot.text).toContain('raditi-e2e-marker')
      expect(snapshot.title).toContain('Магазин игрушек')
    } finally {
      await browser.close()
    }
    // Idle: no request and no use of its session of the gateway for 20 minutes.
    await db.previewBrowserRequest.update({
      where: { id: asked.id },
      data: { requestedAt: new Date(Date.now() - 20 * 60_000) },
    })
    await db.$executeRaw`UPDATE preview_sessions
      SET created_at = now() - interval '20 minutes', checked_at = now() - interval '20 minutes'
      WHERE preview_id = ${ids.preview}::uuid AND kind = 'browser'`
    await manager.sweep()
    await manager.idle()
    expect(
      (await db.previewBrowserRequest.findUniqueOrThrow({ where: { id: asked.id } })).stoppedAt,
    ).not.toBeNull()
    await db.turnAssignment.update({
      where: { id: assignment.id },
      data: { finishedAt: new Date(), outcome: 'completed' },
    })
  }, 600_000)

  it('destroys the preview with its dialog', async () => {
    await db.task.update({ where: { id: ids.task }, data: { status: 'done' } })
    await manager.refresh(ids.preview, { requested: true })
    expect(await preview()).toMatchObject({
      status: 'destroyed',
      upstreamHost: null,
      accessEpoch: 1,
    })
    expect(await runtime.list()).not.toContain(ids.preview)
    expect(vault.kv.has(previewAccessPath(ids.preview, 'wp'))).toBe(false)
  }, 300_000)
})
