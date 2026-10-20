// The whole request of the owner on this machine (docs/plan/53-chat-preview-release.md, R12):
// a dialog in the chat changes a synthetic production site in its preview, the preview shows
// it, `/release` publishes it — tag, Gitea Actions, `deploy-step`, SFTP, the plugin, the check,
// the rollback — with the real apps core, llm, mcp, preview, web, the real OpenCode CLI in its
// sandbox on a scripted synthetic Z.ai, a real Gitea with its runner, OpenBao, PostgreSQL,
// Redis, S3 and WordPress. Disposable services only; never the repository .env, the dev
// infrastructure, a real model or a real key. The scenarios are in scenarios.mjs.
//
//   pnpm verify:release [-- --no-build] [--keep]
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BUILD_OUTPUT,
  BUILD_STAMP,
  BUILD_STEPS,
  COPY_MARKER,
  buildEnvironment,
  buildStamp,
  copyablePath,
  manifestDuringCopy,
  outside,
  readBuildStamp,
  staleCopy,
  staleFiles,
  treeDigest,
  treeEntry,
} from '../billing-verify/stand.mjs'
import { lockCopy } from '../billing-verify/verify-billing.mjs'
import { startFakeModel } from './fake-model.mjs'
import { callerEnv, createRuntime, exchange, freeLoopbackPort, startProcess } from './runtime.mjs'
import { runScenarios } from './scenarios.mjs'
import {
  connectSite,
  grantTariff,
  importRepository,
  installProductionSite,
  signUpOwner,
  storeOwnerToken,
  switchOnModel,
} from './setup.mjs'
import {
  createCertificates,
  startGitea,
  startHosting,
  startMirror,
  startOpenbao,
  startPostgres,
  startRedis,
  startRunner,
  startS3,
  startSite,
} from './services.mjs'
import {
  BUILT_IMAGES,
  GITEA_IMAGE,
  HOSTING_IMAGE,
  MARIADB_IMAGE,
  OPENBAO_IMAGE,
  POSTGRES_IMAGE,
  PULLED_TAGS,
  REDIS_IMAGE,
  RUNNER_IMAGE,
  S3_IMAGE,
  WORDPRESS_IMAGE,
  WPCLI_IMAGE,
  localDigestReference,
  roleEnvironment,
  standNames,
  standOptions,
  summaryTable,
  webEnvironment,
} from './stand.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const root = resolve(here, '../../..')
const rt = createRuntime({ root })
const names = standNames(randomBytes(4).toString('hex'))
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
const interrupt = () => rt.controller.abort(new Error('The stand was interrupted'))
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )

// ─── The private copy and the images ──────────────────────────────────────────

/** Where web and the apps are built: outside the repository, kept between runs. */
function copyDirectory() {
  const given = process.env.RELEASE_VERIFY_BUILD_DIR
  const directory = resolve(given ? given : join(tmpdir(), 'raditi-release-verify-build'))
  if (!outside(root, directory))
    throw new Error('RELEASE_VERIFY_BUILD_DIR must be outside the repository')
  return directory
}

async function treeListing() {
  const listed = await rt.run('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'])
  const present = []
  const entries = []
  // The stand itself is no part of what the copy builds: editing it keeps the builds.
  const own = (path) => path.startsWith('infra/dev/release-verify/')
  for (const path of listed.output.split('\0').filter((path) => copyablePath(path) && !own(path))) {
    const entry = await lstat(join(root, path)).catch(() => null)
    if (entry === null || entry.isDirectory()) continue
    present.push(path)
    entries.push(treeEntry(path, entry))
  }
  assert.ok(present.includes('pnpm-lock.yaml'), 'The listing of the tree has no lockfile')
  assert.ok(!present.includes('.env'), 'The repository .env must never reach the copy')
  return { present, entries }
}

async function copyListing(copy, stamp) {
  const entries = []
  for (const built of stamp.entries) {
    const [path, size] = built.split('\0')
    const held = await lstat(join(copy, path)).catch(() => null)
    if (held === null || held.isDirectory()) continue
    entries.push(
      held.isSymbolicLink() && String(held.size) === size ? built : treeEntry(path, held),
    )
  }
  return entries
}

const stampOf = (copy) => join(copy, COPY_MARKER, BUILD_STAMP)
const imagesStampOf = (copy) => join(copy, COPY_MARKER, 'release-verify-images.json')

/** The copy of the tree and its builds (the steps of verify:billing), or the check of an old one. */
async function buildCopy(copy, options) {
  if (options.build) {
    rt.setStage('copying the tree')
    const marker = join(copy, COPY_MARKER)
    if ((await exists(copy)) && !(await exists(marker)))
      assert.equal(
        (await readdir(copy)).length,
        0,
        'The build directory holds files of someone else',
      )
    await mkdir(marker, { recursive: true })
    await rm(stampOf(copy), { force: true })
    const { present, entries } = await treeListing()
    const manifest = join(marker, 'manifest')
    const previous = (await readFile(manifest, 'utf8').catch(() => '')).split('\0').filter(Boolean)
    await writeFile(manifest, manifestDuringCopy(previous, present).join('\0'))
    for (const path of staleFiles(previous, present)) await rm(join(copy, path), { force: true })
    await rt.run('rsync', ['-a', '--from0', '--files-from=-', `${root}/`, `${copy}/`], {
      input: present.join('\0'),
      timeoutMs: 600_000,
    })
    await writeFile(manifest, present.join('\0'))
    console.log(
      `PASS private copy of the working tree: ${entries.length} files, no .env, outside the repository`,
    )
    const env = buildEnvironment({ path: callerEnv.PATH, home: callerEnv.HOME })
    for (const step of BUILD_STEPS) {
      rt.setStage(`build: ${step.title}`)
      const started = Date.now()
      await rt.run('pnpm', step.args, {
        cwd: copy,
        env: { ...env, ...step.env },
        timeoutMs: 20 * 60_000,
      })
      console.log(`PASS build: ${step.title} (${Math.round((Date.now() - started) / 1000)} s)`)
    }
    // The llm, mcp and preview roles are apps of their own (docs/plan/55-split-orchestrator.md).
    rt.setStage('build: the llm, mcp and preview apps')
    const llmStarted = Date.now()
    await rt.run('pnpm', ['--filter', 'llm', '--filter', 'mcp', '--filter', 'preview', 'build'], {
      cwd: copy,
      env,
      timeoutMs: 20 * 60_000,
    })
    console.log(
      `PASS build: the llm, mcp and preview apps (${Math.round((Date.now() - llmStarted) / 1000)} s)`,
    )
    await rm(join(copy, BUILD_OUTPUT.webStaticServed), { recursive: true, force: true })
    await cp(join(copy, BUILD_OUTPUT.webStatic), join(copy, BUILD_OUTPUT.webStaticServed), {
      recursive: true,
    })
    await writeFile(stampOf(copy), buildStamp({ builtAt: new Date().toISOString(), entries }))
    return entries
  }
  rt.setStage('checking the builds of the copy')
  for (const path of [
    ...Object.values(BUILD_OUTPUT),
    'apps/llm/dist/main.js',
    'apps/mcp/dist/main.js',
    'apps/preview/dist/main.js',
  ])
    assert.ok(
      await exists(join(copy, path)),
      `The copy has no build ${path}: run without --no-build`,
    )
  const stamp = readBuildStamp(await readFile(stampOf(copy), 'utf8').catch(() => ''))
  const { entries } = await treeListing()
  const stale = staleCopy(stamp, entries, stamp === null ? [] : await copyListing(copy, stamp))
  if (stale !== null) throw new Error(`--no-build is refused: ${stale}`)
  console.log(
    `PASS builds of the private copy reused (--no-build): built at ${stamp.builtAt} of the tree as it is now`,
  )
  return entries
}

/** The images of this tree under the stand's own names, by the digests the configuration takes. */
async function buildImages(copy, options, entries) {
  const digest = treeDigest(entries)
  if (options.build) {
    for (const [name, image] of Object.entries(BUILT_IMAGES)) {
      rt.setStage(`docker build ${name}`)
      const started = Date.now()
      const context = join(root, image.context ?? '.')
      await rt.docker(
        ['build', '-f', join(root, image.file), '--target', image.target, '-t', image.tag, context],
        {
          timeoutMs: 40 * 60_000,
        },
      )
      console.log(
        `PASS image ${image.tag} built from the tree (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }
  }
  const images = {}
  for (const [name, image] of Object.entries(BUILT_IMAGES)) {
    const inspected = await rt.docker(
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', image.tag],
      {
        allowFailure: true,
      },
    )
    if (inspected.code !== 0)
      throw new Error(`The image ${image.tag} is missing: run without --no-build`)
    images[name] = localDigestReference(image.tag, inspected.output)
  }
  if (options.build) await writeFile(imagesStampOf(copy), JSON.stringify({ digest, images }))
  else {
    const stamp = JSON.parse(await readFile(imagesStampOf(copy), 'utf8').catch(() => '{}'))
    if (stamp.digest !== digest || JSON.stringify(stamp.images) !== JSON.stringify(images))
      throw new Error('--no-build is refused: the images were not built of the tree as it is now')
    console.log('PASS images of the tree reused (--no-build): built of the tree as it is now')
  }
  return images
}

// ─── The run ──────────────────────────────────────────────────────────────────

async function preflight() {
  rt.setStage('preflight')
  const context = await rt.docker([
    'context',
    'inspect',
    '--format',
    '{{json .Endpoints.docker.Host}}',
  ])
  const endpoint = callerEnv.DOCKER_HOST ?? JSON.parse(context.output)
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://'))
    throw new Error('This stand needs a local Docker socket; remote Docker endpoints are refused')
  const info = await rt.docker(['info', '--format', '{{.OperatingSystem}}'])
  if (!/Docker Desktop/.test(info.output))
    throw new Error('This stand runs on Docker Desktop (macOS): see README, «Что не проверено»')
  for (const image of [
    POSTGRES_IMAGE,
    REDIS_IMAGE,
    S3_IMAGE,
    OPENBAO_IMAGE,
    GITEA_IMAGE,
    RUNNER_IMAGE,
    HOSTING_IMAGE,
    WORDPRESS_IMAGE,
    MARIADB_IMAGE,
    WPCLI_IMAGE,
  ])
    if ((await rt.docker(['image', 'inspect', image], { allowFailure: true })).code !== 0)
      throw new Error(
        `The pinned image ${image} is missing locally; pull it first (docker pull ${PULLED_TAGS[image] ?? image})`,
      )
  for (const tool of ['git', 'rsync', 'openssl', 'pnpm']) await rt.run(tool, ['--version'])
  return endpoint.slice('unix://'.length)
}

/** The modules of the copy the stand calls itself: Prisma, billing and the domain. */
async function copyModules(copy) {
  const load = (path) => import(pathToFileURL(join(copy, path)).href)
  return {
    db: await load('packages/db/src/index.ts'),
    adapters: await load('packages/site-adapters/src/index.ts'),
    billing: await load('packages/billing/src/index.ts'),
    domain: await load('packages/domain/src/index.ts'),
  }
}

async function main(options, owned) {
  const socket = await preflight()
  const copy = copyDirectory()
  owned.lock = await lockCopy(copy)
  const entries = await buildCopy(copy, options)
  const images = await buildImages(copy, options, entries)

  owned.directory = await mkdtemp(join(tmpdir(), `raditi-release-verify-run-${names.run}-`))
  const directory = owned.directory
  await chmod(directory, 0o700)
  for (const sub of ['home', 'tmp', 'logs', 'mirrors'])
    await mkdir(join(directory, sub), { mode: 0o700 })
  owned.containers = true
  owned.dockerBefore = await dockerResources()

  rt.setStage('ports')
  const ports = {}
  for (const name of [
    'gitea',
    'vault',
    's3',
    'site',
    'ssh',
    'web',
    'core',
    'mcp',
    'llm',
    'preview',
    'releaseApi',
    'zai',
  ])
    ports[name] = await freeLoopbackPort()

  rt.setStage('certificates')
  const certificates = await createCertificates(rt, directory)

  rt.setStage('PostgreSQL, Redis, S3 and OpenBao')
  const postgres = await startPostgres(rt, names, directory)
  const redis = await startRedis(rt, names, directory)
  const s3 = await startS3(rt, names, directory, ports.s3)
  const vault = await startOpenbao(rt, names, ports.vault)
  console.log(
    'PASS disposable PostgreSQL 17, Redis 8, SeaweedFS with the buckets of the platform and OpenBao with its mounts, policies and AppRoles',
  )

  rt.setStage('migrations and seeds')
  const dbEnv = { PATH: callerEnv.PATH, HOME: callerEnv.HOME, CI: '1', DATABASE_URL: postgres.url }
  const deployed = await rt.run('pnpm', ['--filter', '@repo/db', 'db:deploy'], {
    cwd: copy,
    env: dbEnv,
    timeoutMs: 300_000,
  })
  assert.ok(
    deployed.output.includes(
      `[db] target raditi@127.0.0.1:${postgres.port}/raditi: DATABASE_URL from the environment`,
    ),
    'prisma migrate deploy did not name the stand database as its target',
  )
  await rt.run('pnpm', ['--filter', '@repo/db', 'db:seed'], {
    cwd: copy,
    env: dbEnv,
    timeoutMs: 300_000,
  })
  const modules = await copyModules(copy)
  const db = modules.db.createPrismaClient({ databaseUrl: postgres.url, log: [] })
  owned.db = db
  console.log(
    'PASS migrations and seeds of the tree on the stand database (target printed as the environment)',
  )

  rt.setStage('Gitea, the mirror and the deploy runner')
  const gitea = await startGitea(rt, names, { port: ports.gitea, certificates, directory })
  await storeOwnerToken(vault, gitea.tokens.owner)
  await startMirror(rt, names, {
    image: images.core,
    // A port a container publishes is on the loopback of the Docker VM already; the processes
    // of the platform listen on the Mac.
    ports: [ports.releaseApi],
  })
  const runner = await startRunner(rt, names, {
    gitea,
    ports,
    deployImage: images.core,
    certificates,
    directory,
  })
  owned.runnerUuid = runner.uuid
  console.log(
    'PASS Gitea 1.27.3 over HTTPS with WORKFLOW_DIRS, platform/ci as the source of scoped workflows, the bot, the release account and its token in Vault; gitea/runner 4.0.0 with the core image of this tree as `deploy`',
  )

  rt.setStage('the production site')
  const siteUrl = `http://localhost:${ports.site}`
  const site = await startSite(rt, names, { directory, sitePort: ports.site, sshPort: ports.ssh })
  const content = await installProductionSite(rt, site, { siteUrl })
  const hosting = await startHosting(rt, names, { directory, port: ports.ssh })
  console.log(
    'PASS production site: WordPress 7.1.2 with MariaDB, the theme of the stand, «Контакты» and a post, the plugin «Радити», an SFTP hosting over its document root',
  )

  rt.setStage('the synthetic Z.ai')
  const model = await startFakeModel({
    key: certificates.key,
    cert: certificates.cert,
    port: ports.zai,
  })
  owned.model = model

  const secrets = {
    metrics: rt.secret(randomBytes(24).toString('hex')),
    auth: rt.secret(randomBytes(36).toString('base64url')),
    previewSession: rt.secret(randomBytes(36).toString('base64url')),
    botToken: gitea.tokens.bot,
  }
  const context = {
    path: callerEnv.PATH,
    directory,
    ports,
    databaseUrl: postgres.url,
    redisUrl: redis.url,
    vault: { address: vault.address },
    roles: vault.roles,
    s3,
    secrets,
    caFile: certificates.caFile,
    socket,
    images,
  }

  rt.setStage('the platform processes')
  owned.processes = []
  const coreApp = join(copy, 'apps/core')
  const llmApp = join(copy, 'apps/llm')
  const mcpApp = join(copy, 'apps/mcp')
  const previewApp = join(copy, 'apps/preview')
  const start = async (name, args, cwd, env, health) => {
    const service = startProcess(rt, name, args, {
      cwd,
      env,
      logFile: join(directory, 'logs', `${name}.log`),
    })
    owned.processes.push(service)
    await rt.until(
      `${name} answers ${health}`,
      async () => (await exchange(health)).status === 200,
      {
        timeoutMs: 120_000,
        service,
      },
    )
    return service
  }
  const processes = {}
  processes.llm = await start(
    'llm',
    ['dist/main.js'],
    llmApp,
    roleEnvironment('llm', context),
    `http://127.0.0.1:${ports.llm}/health`,
  )
  processes.mcp = await start(
    'mcp',
    ['dist/main.js'],
    mcpApp,
    roleEnvironment('mcp', context),
    `http://127.0.0.1:${ports.mcp}/health`,
  )
  processes.preview = await start(
    'preview',
    ['dist/main.js'],
    previewApp,
    roleEnvironment('preview', context),
    `http://127.0.0.1:${ports.preview}/__raditi/health`,
  )
  processes.core = await start(
    'core',
    ['dist/main.js'],
    coreApp,
    roleEnvironment('core', context),
    `http://127.0.0.1:${ports.core}/health`,
  )
  processes.web = await start(
    'web',
    ['server.js'],
    join(copy, 'apps/web/.next/standalone/apps/web'),
    webEnvironment(context),
    `http://127.0.0.1:${ports.web}/api/health`,
  )
  console.log(
    'PASS the apps llm, mcp, preview and core of their builds and web of `next build`, each its own process with its own AppRole',
  )

  rt.setStage('the owner, the workspace and the site')
  const webUrl = `http://127.0.0.1:${ports.web}`
  const owner = await signUpOwner(rt, { webUrl, db })
  const siteId = await createSiteRows({ db, billing: modules.billing }, owner, siteUrl)
  const siteRow = await db.site.findUniqueOrThrow({
    where: { id: siteId },
    include: { workspace: true },
  })
  assert.equal(siteRow.workspace.dataClass, 'synthetic')
  const repoName = `site-${siteId}`
  const repo = await importRepository(rt, { gitea, site, repoName, directory, certificates })
  await connectSite(rt, {
    db,
    dbModule: modules.db,
    domain: modules.domain,
    contentAccessSchema: modules.adapters.getSiteContentAdapter('wordpress').accessSchema,
    vault,
    site,
    siteId,
    workspaceId: siteRow.workspaceId,
    siteUrl,
    hosting,
    applicationPassword: content.applicationPassword,
    repo: { name: repoName, sha: repo.sha },
    gitea,
  })
  await grantTariff(
    { db, billing: modules.billing },
    { workspaceId: siteRow.workspaceId, userId: owner.id },
  )
  await switchOnModel(rt, { db, copy, context, vault, directory })
  owned.siteId = siteId
  console.log(
    `PASS the owner signed up through web; workspace of class synthetic, site ${siteId} active with its accesses in OpenBao, its repository (${repo.files} files with the core and media, tag v0.0.0) and the tariff «Агентство»; the synthetic account imported by the operator command, the standard and the heavy profile switched on with their rates`,
  )

  await runScenarios({
    rt,
    db,
    modules,
    names,
    ports,
    owner,
    gitea,
    site,
    siteUrl,
    siteId,
    workspaceId: siteRow.workspaceId,
    repo: { name: repoName, importSha: repo.sha },
    content,
    model,
    vault,
    processes,
    certificates,
    webUrl,
    images,
    copy,
    directory,
    s3,
    runnerUuid: runner.uuid,
  })
  if (options.keep) {
    console.log(`KEEP the stand is up: web ${webUrl}; Ctrl-C cleans it up`)
    await keptUntilInterrupted()
  }
}

const TEXT_SITE = 'Цветочная лавка'

/**
 * The site of the owner as the stand writes it itself (CLAUDE.md, «Как писать код»: a test that
 * needs a site makes it through `project.create` with fakes or writes the rows): the personal
 * workspace through the product's own `ensurePersonalWorkspaceWithGift`, with the gift of the
 * registration, and the site `onboarding`. The wizard of plan 39 is not walked here — its stand is
 * `verify:site-import` — and no code_import stage is written: a site without one lives as it did
 * before the wizard. Its accesses, the rows of the wizard beside them and the repository of the
 * import follow (`importRepository`, `connectSite`).
 */
async function createSiteRows({ db, billing }, owner, siteUrl) {
  const workspace = await db.$transaction((tx) =>
    billing.ensurePersonalWorkspaceWithGift(tx, { userId: owner.id, appEnv: 'test' }),
  )
  const site = await db.site.create({
    data: {
      workspaceId: workspace.id,
      name: TEXT_SITE,
      url: siteUrl,
      stack: 'wordpress',
      status: 'onboarding',
    },
    select: { id: true },
  })
  return site.id
}

/**
 * Waits for a signal. A timer holds the event loop: a signal listener alone does not, and a
 * stand kept before any process of its own started would end with its containers left behind.
 */
async function keptUntilInterrupted() {
  const hold = setInterval(() => {}, 60_000)
  try {
    await new Promise((done) => rt.signal.addEventListener('abort', done, { once: true }))
  } finally {
    clearInterval(hold)
  }
}

/** What the database says of the dialogs of a failed run: ids, statuses and codes only. */
async function diagnose(owned) {
  const db = owned.db
  if (!owned.siteId) return
  const tasks = await db.task.findMany({
    where: { siteId: owned.siteId },
    orderBy: { createdAt: 'asc' },
  })
  for (const task of tasks) {
    console.error(
      `--- task ${task.id} ${task.status} waiting=${task.waiting} turn=${task.turnNo} attempt=${task.attempt}`,
    )
    const preview = await db.previewEnvironment.findUnique({ where: { taskId: task.id } })
    if (preview)
      console.error(
        `    preview ${preview.status} revision=${preview.revision} dirty=${preview.dirty} error=${preview.errorCode} unavailable=${preview.unavailableReason}`,
      )
    const events = await db.taskEvent.findMany({
      where: { taskId: task.id },
      orderBy: { id: 'asc' },
    })
    for (const event of events.slice(-25))
      console.error(
        `    ${event.id} ${event.type} ${rt.redact(JSON.stringify(event.payload)).slice(0, 400)}`,
      )
  }
  // What the tools of the platform answered the agent, as the next request of the CLI carried it.
  for (const request of owned.model?.state.requests ?? []) {
    const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
    const last = messages.at(-1)
    if (last?.role === 'tool')
      console.error(`--- tool answer: ${rt.redact(JSON.stringify(last.content)).slice(0, 600)}`)
  }
  const releases = await db.siteRelease.findMany({ where: { siteId: owned.siteId } })
  for (const release of releases)
    console.error(
      `--- release ${release.id} ${release.version} ${release.status} step=${release.step} error=${release.errorCode}`,
    )
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/** Every container, network and volume of the daemon, with whether it carries any label. */
async function dockerResources() {
  const quiet = { allowFailure: true, cleanup: true }
  const all = new Map()
  for (const [kind, args] of [
    ['container', ['ps', '-a', '--format', '{{.ID}}\t{{.Labels}}']],
    ['network', ['network', 'ls', '--format', '{{.ID}}\t{{.Labels}}']],
    ['volume', ['volume', 'ls', '--format', '{{.Name}}\t{{.Labels}}']],
  ])
    for (const line of lines((await rt.docker(args, quiet)).output)) {
      const [id, labels = ''] = line.split('\t')
      all.set(`${kind} ${id}`, labels.trim() !== '')
    }
  return all
}

/**
 * What appeared during the run with no label at all and is still there: nothing of the stand
 * or of core is unlabelled, so this is another session's work or a helper nothing labels.
 */
async function unlabelledSince(before) {
  const now = await dockerResources()
  return [...now].filter(([key, labelled]) => !before.has(key) && !labelled).map(([key]) => key)
}

const lines = (output) =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * Everything of the run, in this order: the processes of the platform, the synthetic Z.ai,
 * the deploy runner (after it nothing makes a job container), then every container, network and
 * volume of the run — the stand's by its label, the turn sandboxes, their gateways and the
 * previews by the labels of the site of the run, the job volumes by the uuid of the runner —
 * and at the end the check that nothing is left.
 */
async function cleanup(owned) {
  const quiet = { allowFailure: true, cleanup: true }
  for (const service of [...(owned.processes ?? [])].reverse()) await service.stop().catch(() => {})
  await owned.model?.close().catch(() => {})
  await owned.db?.$disconnect().catch(() => {})
  if (!owned.containers) return { left: [], coreOwned: [] }
  await rt.docker(['rm', '-f', '-v', names.containers.runner], quiet)
  const filters = [`label=${names.label}`]
  if (owned.siteId)
    for (const prefix of [
      'io.raditi.sandbox.siteId',
      'io.raditi.gateway.siteId',
      'io.raditi.preview.site',
    ])
      filters.push(`label=${prefix}=${owned.siteId}`)
  const volumes = new Set()
  /** What core owns and should have removed itself: the labels of the site, not of the stand. */
  const coreOwned = []
  const ofCore = (filter) => filter !== filters[0]
  const mounts = '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}'
  for (const filter of filters)
    for (const id of lines((await rt.docker(['ps', '-aq', '--filter', filter], quiet)).output)) {
      if (ofCore(filter)) coreOwned.push(`container ${id}`)
      for (const volume of lines(
        (await rt.docker(['inspect', '--format', mounts, id], quiet)).output,
      ))
        volumes.add(volume)
      await rt.docker(['rm', '-f', '-v', id], quiet)
    }
  if (owned.runnerUuid)
    for (const volume of lines(
      (
        await rt.docker(
          ['volume', 'ls', '-q', '--filter', `label=com.gitea.runner.uuid=${owned.runnerUuid}`],
          quiet,
        )
      ).output,
    ))
      volumes.add(volume)
  for (const filter of filters) {
    for (const volume of lines(
      (await rt.docker(['volume', 'ls', '-q', '--filter', filter], quiet)).output,
    )) {
      if (ofCore(filter)) coreOwned.push(`volume ${volume}`)
      volumes.add(volume)
    }
    for (const network of lines(
      (await rt.docker(['network', 'ls', '-q', '--filter', filter], quiet)).output,
    )) {
      if (ofCore(filter)) coreOwned.push(`network ${network}`)
      await rt.docker(['network', 'rm', network], quiet)
    }
  }
  for (const volume of volumes) await rt.docker(['volume', 'rm', '-f', volume], quiet)
  const left = []
  for (const filter of filters)
    for (const kind of [
      ['ps', '-aq'],
      ['volume', 'ls', '-q'],
      ['network', 'ls', '-q'],
    ])
      left.push(
        ...lines((await rt.docker([...kind, '--filter', filter], quiet)).output).map(
          (id) => `${kind[0]} ${id}`,
        ),
      )
  for (const volume of volumes)
    if ((await rt.docker(['volume', 'inspect', volume], quiet)).code === 0)
      left.push(`volume ${volume}`)
  return { left, coreOwned }
}

async function keepLogs(owned) {
  const from = join(owned.directory, 'logs')
  const files = await readdir(from).catch(() => [])
  if (files.length === 0) return null
  const to = join(tmpdir(), `raditi-release-verify-logs-${names.run}`)
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const file of files)
    await writeFile(join(to, file), rt.redact(await readFile(join(from, file), 'utf8')), {
      mode: 0o600,
    })
  return to
}

export async function verifyRelease(argv) {
  const started = Date.now()
  for (const signal of SIGNALS) process.on(signal, interrupt)
  const owned = {}
  let failed = false
  try {
    const options = standOptions(argv)
    owned.keep = options.keep
    await main(options, owned)
  } catch (error) {
    failed = true
    console.error(
      `FAIL release stand at ${rt.stage}: ${rt.redact(error?.stack ?? error?.message ?? String(error)).slice(0, 4000)}`,
    )
    for (const service of owned.processes ?? []) {
      const tail = service.log().split('\n').slice(-40).join('\n')
      console.error(`--- last lines of ${service.name}\n${rt.redact(tail)}`)
    }
    if (owned.db) await diagnose(owned).catch(() => {})
    if (owned.keep && !rt.signal.aborted) {
      console.log('KEEP the failed stand is up for inspection; Ctrl-C cleans it up')
      await keptUntilInterrupted()
    }
  } finally {
    rt.setStage('cleanup')
    const { left, coreOwned } = await cleanup(owned).catch((error) => ({
      left: [`cleanup error: ${error.message}`],
      coreOwned: [],
    }))
    if (left.length === 0) {
      if (owned.containers)
        console.log(
          'PASS owned processes, containers, networks and volumes removed; nothing of the run is left',
        )
    } else {
      failed = true
      console.error(`FAIL cleanup of the release stand: ${left.join(', ')}`)
    }
    // A passed run has nothing of core left by then (S7): removing it here would hide a leak.
    if (!failed && coreOwned.length > 0) {
      failed = true
      console.error(
        `FAIL the stand had to remove what core owns and left behind: ${coreOwned.join(', ')}`,
      )
    }
    const appeared = owned.dockerBefore
      ? await unlabelledSince(owned.dockerBefore).catch(() => [])
      : []
    if (appeared.length > 0)
      console.log(
        `NOTE ${appeared.length} Docker resources without any label appeared during the run and are still there (another session's, or a helper nothing labels): ${appeared.join(', ')}`,
      )
    if (owned.directory) {
      if (failed) {
        const logs = await keepLogs(owned).catch(() => null)
        if (logs) console.error(`LOGS of the failed run (redacted): ${logs}`)
      }
      await rm(owned.directory, { recursive: true, force: true }).catch(() => {})
    }
    if (owned.lock) await rm(owned.lock, { recursive: true, force: true }).catch(() => {})
    for (const signal of SIGNALS) process.removeListener(signal, interrupt)
  }
  if (rt.rows.length > 0) console.log(summaryTable(rt.rows))
  console.log(
    `${failed ? 'FAIL' : 'PASS'} pnpm verify:release in ${Math.round((Date.now() - started) / 1000)} s`,
  )
  if (failed) throw new Error('Release verification failed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyRelease(process.argv.slice(2)).catch(() => {
    process.exitCode = 1
  })
}
