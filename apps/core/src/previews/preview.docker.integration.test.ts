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
  previewEnterUrl,
  previewHostname,
  publishedContentHashMaterial,
  siteAccessPath,
  siteWorkspaceRules,
  type DbPlan,
  type SiteFacts,
  type GitProvider,
  type PreviewFilesInput,
  type PreviewRuntime,
  type PreviewUpstream,
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
import { openCabinetFrame } from '../testing/preview-frame.ts'
import {
  MemoryStorage,
  MemoryVault,
  recordValues,
  workingTreeArchive,
} from '../testing/previews.ts'
import { checkRequest, phpMessageIn } from './preview-checks.ts'
import { PreviewManager } from './preview-manager.ts'
import { previewRecordOf } from './preview-record.ts'
import { createPreviewSiteSources } from './site-sources.ts'

// A preview end to end on this machine's Docker (docs/plan/53-chat-preview-release.md, R5c): a
// synthetic «production» — MariaDB 11.4.13 with a WordPress 7.1.2 database — a git repository
// with the full tree of the site, the real Docker runtime of previews (PREVIEW_RUNTIME, runc by
// default), the real copier, PostgreSQL. The preview is built, opened through its entry forwarder,
// rebuilt to a candidate with a database operation, synced from a turn, given a browser — which
// opens the preview through the gateway of the `preview` app (R6), its build started as a process
// of its own on PREVIEW_GATEWAY_PORT 18090 — and destroyed. In between, the owner signs in to
// WordPress inside the cabinet's frame (docs/plan/62-site-stacks.md, Т35, M2k): a Chromium of
// playwright-core holds the preview in an iframe of a page on the gateway's APP_URL, port 18091.
// Only synthetic data. Needs the images below, the site, tools and browser images of
// infra/preview (README), the image of the host rules (infra/sandbox/Dockerfile, `network-guard`,
// or SANDBOX_NETWORK_GUARD_IMAGE), `pnpm --filter preview build` and the Chromium of
// playwright-core (`pnpm --filter e2e exec playwright install chromium`); runs with
// RADITI_PREVIEW_DOCKER_TESTS=1, RADITI_GATEWAY_DB_TESTS=1 and a disposable DATABASE_URL, with
// port 18090 free on loopback (Docker Desktop) or on the bridge of the host (Linux) and port 18091
// free on loopback.

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
/** As the suite of the runtime reads it: stands under gVisor set PREVIEW_RUNTIME=runsc. */
const runtimeKind = process.env.PREVIEW_RUNTIME === 'runsc' ? 'runsc' : 'runc'
const dockerSocket = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
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
  /** Where each preview the runtime started answers, for a request of its own of a test. */
  const targets = new Map<string, { upstream: PreviewUpstream; hostname: string }>()
  /** What a test asks of a preview a build is about to stop (Т33: a dead base is stopped). */
  let beforeStop:
    ((target: { upstream: PreviewUpstream; hostname: string }) => Promise<void>) | null = null
  const recording = (docker_: PreviewRuntime): PreviewRuntime => ({
    ...docker_,
    ensure: async (spec, secrets, signal) => {
      const upstream = await docker_.ensure(spec, secrets, signal)
      targets.set(spec.previewId, { upstream, hostname: spec.hostname })
      return upstream
    },
    stop: async (previewId) => {
      const target = targets.get(previewId)
      if (beforeStop && target) await beforeStop(target)
      return docker_.stop(previewId)
    },
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
  const ids = {
    workspace: '',
    site: '',
    task: '',
    preview: '',
    hostname: '',
    pageId: 0,
    user: '',
  }
  let mainSha = ''
  let candidateSha = ''
  /** The working copy and the remote of the site's repository. */
  let work = ''
  let remote = ''
  let exported: Uint8Array = workingTreeArchive({})
  /** The previews of the dialogs of the scenarios of `ready` below. */
  const scenarioPreviews: string[] = []
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
  const gitWith = async (extra: Record<string, string>, cwd: string, ...args: string[]) =>
    (
      await run('git', args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...extra,
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
  const git = (cwd: string, ...args: string[]) => gitWith({}, cwd, ...args)
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
      runtime: runtimeKind,
      siteImages: { '8.3': await digest(SITE) },
      images: {
        db: await digest(DB),
        forwarder: await digest(TOOLS),
        browser: await digest(BROWSER),
      },
      upstreamHost: '127.0.0.1',
      dnsServers: ['77.88.8.8', '77.88.8.1'],
      gatewayPort: 18090,
      relayGatewayHost: 'host.docker.internal',
      refusedSubnets: [],
      docker: { socketPath: dockerSocket, firewallImage },
    }
    runtime = recording(
      createDockerPreviewRuntime({
        runtime: runtimeKind,
        socketPath: dockerSocket,
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
    work = join(root, 'work')
    remote = join(root, 'remote.git')
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
      appEnv: 'test',
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
      appUrl: 'http://localhost:18091',
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
    for (const previewId of scenarioPreviews) await runtime.destroy(previewId).catch(() => {})
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
        if (ids.user) await db.user.deleteMany({ where: { id: ids.user } })
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
    // The home page answered as WordPress: the header of the generated wp-config.php (Т33).
    expect(previewRecordOf(row.runtime)).toMatchObject({
      passport: { boot: 'not_compared', differences: [] },
      baseBoot: 'alive',
    })
    // The account of the platform reads the copy; production could not be asked: none editable.
    const state = await (await content()).read(`page:${ids.pageId}`)
    expect(state.title).toBe('О магазине')
    expect(
      (await db.previewSeedMismatch.findMany({ where: { previewId: ids.preview } })).map(
        (mismatch) => mismatch.objectRef,
      ),
    ).toContain(`page:${ids.pageId}`)
  }, 600_000)

  it('signs the owner in to WordPress inside the cabinet’s frame', async () => {
    // The owner: a member of the workspace — the gateway lets only a member's ticket in.
    const user = await db.user.create({
      data: { name: 'Fixture', email: `frame-${suffix}@example.test` },
    })
    ids.user = user.id
    await db.member.create({ data: { workspaceId: ids.workspace, userId: user.id } })
    // A one-time ticket of the cabinet, as preview.ticket writes it; the gateway keeps the hash.
    const ticketFor = async () => {
      const ticket = randomBytes(32).toString('base64url')
      await db.previewTicket.create({
        data: {
          previewId: ids.preview,
          kind: 'user',
          userId: user.id,
          tokenHash: createHash('sha256').update(ticket).digest('hex'),
          expiresAt: new Date(Date.now() + 60_000),
        },
      })
      return ticket
    }
    // The account of the platform signs in with a synthetic password of this run: the copy keeps
    // a random hash of it.
    const password = randomBytes(18).toString('base64url')
    const updated = await runtime.exec(ids.preview, {
      argv: [
        'wp',
        '--skip-plugins',
        '--skip-themes',
        'user',
        'update',
        'raditi-platform',
        `--user_pass=${password}`,
        '--skip-email',
      ],
      timeoutMs: 60_000,
    })
    expect(updated.code, Buffer.from(updated.stderr).toString('utf8')).toBe(0)

    const origin = `http://${ids.hostname}:8090`
    const cabinet = await openCabinetFrame({
      appOrigin: 'http://localhost:18091',
      enterUrl: previewEnterUrl(origin, await ticketFor(), '/wp-login.php'),
      gatewayPort: 18090,
    })
    try {
      const { frame } = cabinet
      await frame.locator('#user_login').waitFor({ state: 'visible', timeout: 60_000 })
      const inFrame = await (await frame.owner().elementHandle())!.contentFrame()
      // The control that the frame is cross-site: a cookie with no attributes does not live in
      // it, and lives in a tab of the same preview. A same-site stand fails here, not silently.
      expect(await cabinet.keepsPlainCookie(inFrame!)).toBe(false)
      const tab = await cabinet.tab(previewEnterUrl(origin, await ticketFor(), '/'))
      expect(new URL(tab.url()).origin).toBe(origin)
      expect(await cabinet.keepsPlainCookie(tab)).toBe(true)
      await tab.close()

      await frame.locator('#user_login').fill('raditi-platform')
      await frame.locator('#user_pass').fill(password)
      await frame.locator('#wp-submit').click()
      await frame
        .locator('#wpadminbar, #login_error')
        .first()
        .waitFor({ state: 'attached', timeout: 60_000 })
      // The refusal WordPress writes when its test cookie was lost: the frame dropped it.
      const refusal = frame.locator('#login_error')
      if ((await refusal.count()) > 0)
        expect(await refusal.innerText()).not.toContain('Cookies are blocked')
      await frame.locator('#wpadminbar').waitFor({ state: 'visible', timeout: 60_000 })
      expect(new URL(inFrame!.url()).pathname).toBe('/wp-admin/')

      // Names only, never values: which cookies the frame and the tab keep, and under what key.
      const cookies = await cabinet.page.context().cookies(origin)
      console.log(
        `NOTE cookies of the preview: ${cookies
          .map((cookie) =>
            cookie.partitionKey === undefined
              ? cookie.name
              : `${cookie.name} (partitioned by ${cookie.partitionKey})`,
          )
          .sort()
          .join(', ')}`,
      )
    } finally {
      await cabinet.close()
    }
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
        runtime: runtimeKind,
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

  // How a WordPress preview tells a live page from a dead one (docs/plan/62-site-stacks.md, Т33;
  // docs/plan/62-slices/e1.md, Э1.6): the header of its wp-config.php, and the mark of a fatal error
  // of PHP with the key of the check. Each scenario is a dialog of its own on the site, its base a
  // commit of `main` with some files over the tree of `mainSha`; production runs a classic theme of
  // the tests, which every such tree holds, and a post that quotes a whole message of PHP.
  describe('the home page of WordPress before ready (Э1.6)', () => {
    const theme = 'wp-content/themes/raditi-classic'
    // The mu-plugin raditi-preview.php holds the whole page until the end; a theme that sends its
    // head early — as plugins of page speed do — has the page on its way before a later error.
    const header =
      '<!doctype html>\n<html><head><?php wp_head(); ?></head><body>\n' +
      '<?php while (ob_get_level() > 0) { ob_end_flush(); } flush(); ?>\n'
    const classic: Record<string, string> = {
      [`${theme}/style.css`]: '/*\nTheme Name: Raditi classic\n*/\n',
      [`${theme}/header.php`]: header,
      [`${theme}/index.php`]:
        "<?php get_header(); ?>\n<main><?php while (have_posts()) { the_post(); the_title('<h2>', '</h2>'); the_content(); } ?></main>\n<?php get_footer();\n",
      [`${theme}/footer.php`]: '<?php wp_footer(); ?>\n</body></html>\n',
    }
    const quote = '<pre>\nFatal error: Uncaught Error in /var/www/html/x.php on line 3</pre>'
    /** What a check — a request with a key of its own — and a visitor got of a dying base. */
    let asked: Array<{
      key: string
      check: { status: number; headers: Record<string, unknown>; body: string }
      visitor: { status: number; body: string }
      /** Requests whose key is not one of a check: they get no mark, nor their value echoed. */
      forged: Array<{ key: string; body: string }>
    }> = []
    let mainTip = ''

    /** A commit of `files` over the tree of `mainSha`, after `parent`, pushed to `ref`. */
    const commitOver = async (files: Record<string, string>, parent: string, ref: string) => {
      const env = { GIT_INDEX_FILE: join(root, `index-${randomBytes(4).toString('hex')}`) }
      await gitWith(env, work, 'read-tree', mainSha)
      for (const [path, text] of Object.entries(files)) {
        const file = join(root, 'blob')
        await writeFile(file, text)
        const blob = await gitWith(env, work, 'hash-object', '-w', file)
        await gitWith(env, work, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`)
      }
      const tree = await gitWith(env, work, 'write-tree')
      const commit = await gitWith(env, work, 'commit-tree', tree, '-p', parent, '-m', 'scenario')
      await git(work, 'push', '-q', remote, `${commit}:${ref}`)
      return commit
    }
    /** A new dialog whose base is `main` with `files`, built once. */
    const dialogOn = async (files: Record<string, string>) => {
      mainTip = await commitOver({ ...classic, ...files }, mainTip, 'refs/heads/main')
      const site = await db.site.findUniqueOrThrow({ where: { id: ids.site } })
      const task = await db.task.create({
        data: {
          workspaceId: ids.workspace,
          siteId: ids.site,
          status: 'awaiting_approval',
          turnNo: 1,
        },
      })
      const row = await db.previewEnvironment.create({
        data: {
          siteId: ids.site,
          taskId: task.id,
          status: 'pending',
          dbMode: 'copy',
          hostname: previewHostname({ siteAlias: site.alias, taskAlias: task.alias }, 'localhost'),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      scenarioPreviews.push(row.id)
      asked = []
      await manager.refresh(row.id, { requested: true })
      return { taskId: task.id, previewId: row.id }
    }
    const rowOf = (previewId: string) =>
      db.previewEnvironment.findUniqueOrThrow({ where: { id: previewId } })
    const homeOf = async (previewId: string) => {
      const row = await rowOf(previewId)
      const answer = await previewRequest(
        { upstream: { host: row.upstreamHost!, port: row.upstreamPort! }, hostname: row.hostname },
        { method: 'GET', path: '/', timeoutMs: 30_000, maxResponseBytes: 8 * 1024 * 1024 },
      )
      return {
        status: answer.status,
        headers: answer.headers,
        body: Buffer.from(answer.body).toString('utf8'),
      }
    }

    beforeAll(async () => {
      mainTip = (await git(work, 'ls-remote', remote, 'refs/heads/main')).split(/\s+/)[0]!
      await wpProd('option', 'update', 'template', 'raditi-classic')
      await wpProd('option', 'update', 'stylesheet', 'raditi-classic')
      await wpProd(
        'post',
        'create',
        '--post_type=post',
        '--post_status=publish',
        '--post_title=Что значит ошибка',
        `--post_content=${quote}`,
      )
      // What a check and a visitor get of a base the build then stops as dead.
      beforeStop = async (target) => {
        const request = checkRequest()
        const check = await previewRequest(target, { ...request, path: '/' })
        const visitor = await previewRequest(target, {
          method: 'GET',
          path: '/',
          timeoutMs: 30_000,
          maxResponseBytes: 8 * 1024 * 1024,
        })
        const forged: Array<{ key: string; body: string }> = []
        for (const key of ['zz--><b>raditi-forged</b>', 'a'.repeat(31), 'b'.repeat(33)]) {
          const answer = await previewRequest(target, {
            ...request,
            headers: { ...request.headers, 'x-raditi-check': key },
            path: '/',
          })
          forged.push({ key, body: Buffer.from(answer.body).toString('utf8') })
        }
        asked.push({
          forged,
          key: request.headers['x-raditi-check'],
          check: {
            status: check.status,
            headers: check.headers,
            body: Buffer.from(check.body).toString('utf8'),
          },
          visitor: { status: visitor.status, body: Buffer.from(visitor.body).toString('utf8') },
        })
      }
    }, 300_000)
    afterAll(() => {
      beforeStop = null
    })

    it('a base that answers 200 without the mark is boot_failed', async () => {
      // A dead site answers 200 too: nothing of WordPress, nor of its configuration, ran.
      const { previewId } = await dialogOn({ 'index.php': '<?php exit(0);\n' })
      expect(await rowOf(previewId)).toMatchObject({
        status: 'unavailable',
        unavailableReason: 'boot_failed',
      })
      expect(asked).toHaveLength(1)
      expect(asked[0]!.check.status).toBe(200)
      expect(asked[0]!.check.headers['x-raditi-preview']).toBeUndefined()
      expect(previewRecordOf((await rowOf(previewId)).runtime).baseBoot).toBe('dead')
    }, 600_000)

    it('a static home page with the words of a fatal error and the header is ready', async () => {
      const { previewId } = await dialogOn({
        'index.php':
          "<?php require __DIR__ . '/wp-load.php'; ?>\n<!doctype html>\n<html><body><h1>Магазин</h1>\n" +
          '<p>Fatal error: Allowed memory size of 134217728 bytes exhausted</p>\n</body></html>\n',
      })
      expect(await rowOf(previewId)).toMatchObject({ status: 'ready' })
      const home = await homeOf(previewId)
      expect(home.headers['x-raditi-preview']).toBe('1')
      expect(home.body).toContain('Fatal error: Allowed memory size')
    }, 600_000)

    it('a home page where a post quotes a whole message of PHP at a line start is ready', async () => {
      const { previewId } = await dialogOn({})
      expect(await rowOf(previewId)).toMatchObject({ status: 'ready' })
      expect(previewRecordOf((await rowOf(previewId)).runtime).passport).toMatchObject({
        boot: 'not_compared',
      })
      // The quote is one a reading of the text alone takes for PHP's own message.
      const home = await homeOf(previewId)
      expect(home.body).toContain('\nFatal error: Uncaught Error in /var/www/html/x.php on line 3')
      expect(phpMessageIn(home.body)).toBe(true)
    }, 600_000)

    it('a theme that dies before its first output answers 500 without the message: boot_failed', async () => {
      const { previewId } = await dialogOn({
        [`${theme}/index.php`]: '<?php raditi_missing_function();\n',
      })
      expect(await rowOf(previewId)).toMatchObject({
        status: 'unavailable',
        unavailableReason: 'boot_failed',
      })
      expect(asked).toHaveLength(1)
      expect(asked[0]!.check.status).toBe(500)
      expect(asked[0]!.check.body).not.toContain('raditi_missing_function')
      expect(phpMessageIn(asked[0]!.check.body)).toBe(false)
    }, 600_000)

    describe('a fatal error after the page went out, with display_errors switched back on', () => {
      const broken = {
        'wp-content/mu-plugins/raditi-test-display.php': "<?php ini_set('display_errors', '1');\n",
        [`${theme}/footer.php`]: '<?php raditi_missing_function(); ?>\n</body></html>\n',
      }

      it('is marked with the key of the check alone, and the base is boot_failed', async () => {
        const { previewId } = await dialogOn(broken)
        expect(await rowOf(previewId)).toMatchObject({
          status: 'unavailable',
          unavailableReason: 'boot_failed',
        })
        expect(asked).toHaveLength(1)
        const [{ key, check, visitor }] = asked as [(typeof asked)[number]]
        // 200 with the message of PHP and the header: only the mark tells the page is dead.
        expect(check.status).toBe(200)
        expect(check.headers['x-raditi-preview']).toBe('1')
        expect(phpMessageIn(check.body)).toBe(true)
        expect(check.body).toContain(`raditi-fatal:${key}`)
        // A visitor of the preview asks without a key: no mark for it.
        expect(visitor.body).toContain('raditi_missing_function')
        expect(visitor.body).not.toContain('raditi-fatal:')
        // A key of another form is no key: nothing of it comes back into the page.
        const { forged } = asked[0]!
        expect(forged).toHaveLength(3)
        for (const answer of forged) {
          expect(answer.body).toContain('raditi_missing_function')
          expect(answer.body).not.toContain('raditi-fatal:')
          expect(answer.body).not.toContain(answer.key)
        }
      }, 600_000)

      it('fails the smoke check of a candidate with it on a live base, which keeps its preview', async () => {
        const { taskId, previewId } = await dialogOn({})
        expect(await rowOf(previewId)).toMatchObject({ status: 'ready', revision: 0 })
        const head = await commitOver(
          { ...classic, ...broken },
          mainTip,
          `refs/heads/agent/${taskId}`,
        )
        const candidate = await db.taskCandidate.create({
          data: {
            taskId,
            revision: 1,
            turnNo: 1,
            baseSha: mainTip,
            baseTree: 'b'.repeat(40),
            headSha: head,
            files: Object.entries(broken).map(([path, text]) => ({
              path,
              change: path.endsWith('footer.php') ? 'modified' : 'added',
              sizeBytes: Buffer.byteLength(text),
              executable: false,
            })),
            dbPlan: [],
            dbPlanSha256: 'd'.repeat(64),
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
        await manager.refresh(previewId, { requested: true })
        expect(await rowOf(previewId)).toMatchObject({
          status: 'ready',
          revision: 1,
          candidateId: candidate.id,
          filesSha: head,
        })
        const checks = await db.candidateCheck.findMany({ where: { candidateId: candidate.id } })
        expect(checks.map((check) => [check.kind, check.status]).sort()).toEqual([
          ['php_lint', 'passed'],
          ['preview_smoke', 'failed'],
        ])
        expect(previewRecordOf((await rowOf(previewId)).runtime).passport).toMatchObject({
          boot: 'suspect',
        })
      }, 600_000)
    })
  })
})
