// The stand of the site stacks (docs/plan/62-site-stacks.md, Т66, §5.5; docs/plan/62-slices/e3.md,
// Э3.10–Э3.12): a real release of each CMS of STACK_STANDS installed on a synthetic production — the image
// `site` of its PHP, its database inside — behind an SFTP hosting, and the real platform around it:
// web, core, llm, mcp and preview of the builds of a private copy of this tree, Gitea with its
// runner, OpenBao, PostgreSQL, Redis, S3 and the real OpenCode CLI on a scripted synthetic Z.ai. The
// groups of scenarios run per build (stand.mjs, `groupsOf`). Disposable services only; never the
// repository .env, the dev infrastructure, a real model, a real site or a real key. The services of
// the release stand are taken as they are: no file of infra/dev/release-verify is changed.
//
//   pnpm verify:stack [-- --stack=joomla] [--build=joomla-5.4.10]... [--group=import]...
//                        [--no-build] [--keep] [--runtime=runsc]
//
// It runs on Docker Desktop, on Linux and inside a VM whose `host-gateway` is another machine
// (Colima; `bash infra/dev/stack-verify/colima-m7.sh`): what the host is, `hostOf` reads (Э3.16).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
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
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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
  keptFolder,
  manifestDuringCopy,
  outside,
  readBuildStamp,
  staleCopy,
  staleDirectories,
  staleFiles,
  treeDigest,
  treeEntry,
} from '../billing-verify/stand.mjs'
import { lockCopy } from '../billing-verify/verify-billing.mjs'
import { bridgeGatewayAddress } from '../../../apps/core/scripts/verify-agent-content-role.mjs'
import { siteImageBuildArgs } from '../preview-verify/verify-site-images.mjs'
import { startFakeModel } from '../release-verify/fake-model.mjs'
import {
  callerEnv,
  createRuntime,
  exchange,
  freeLoopbackPort,
  startProcess,
} from '../release-verify/runtime.mjs'
import {
  createCertificates,
  startGitea,
  startMirror,
  startOpenbao,
  startPostgres,
  startRedis,
  startRunner,
  startS3,
} from '../release-verify/services.mjs'
import {
  grantTariff,
  signUpOwner,
  storeOwnerToken,
  switchOnModel,
} from '../release-verify/setup.mjs'
import {
  GITEA_IMAGE,
  HOSTING_IMAGE,
  MARIADB_IMAGE,
  OPENBAO_IMAGE,
  POSTGRES_IMAGE,
  PULLED_TAGS,
  REDIS_IMAGE,
  RUNNER_IMAGE,
  S3_IMAGE,
  localDigestReference,
  summaryTable,
  webEnvironment,
} from '../release-verify/stand.mjs'
import { GITLEAKS_VERSION } from '../site-import-verify/stand.mjs'
import { fetchCmsArchive } from './fetch-cms.mjs'
import { runImportGroup } from './scenarios-import.mjs'
import { parseRuntimes, runPreviewGroup } from './scenarios-preview.mjs'
import { runReleaseGroup } from './scenarios-release.mjs'
import { addProvisioner, startBuildHosting, startProduction, startRelays } from './services.mjs'
import { STACK_STANDS } from './stacks.mjs'
import {
  STACK_BUILT_IMAGES,
  buildNames,
  groupRowProblems,
  hostGatewayOf,
  hostOf,
  hostRelays,
  siteImageTag,
  stackCoreEnvironment,
  stackNames,
  stackRoleEnvironment,
  standOptions,
} from './stand.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const root = resolve(here, '../../..')
const rt = createRuntime({ root })
const names = stackNames(randomBytes(4).toString('hex'))
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
const interrupt = () => rt.controller.abort(new Error('The stand was interrupted'))
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )
const SITE_BASES = JSON.parse(
  await readFile(join(root, 'infra/preview/site-bases.json'), 'utf8'),
).versions

// ─── The private copy and the images ──────────────────────────────────────────

/** Where web and the apps are built: outside the repository, kept between runs. */
function copyDirectory() {
  const given = process.env.STACK_VERIFY_BUILD_DIR
  const directory = resolve(given ? given : join(tmpdir(), 'raditi-stack-verify-build'))
  if (!outside(root, directory))
    throw new Error('STACK_VERIFY_BUILD_DIR must be outside the repository')
  return directory
}

/** Where the archives of the CMS are: RADITI_CMS_DIR, or a folder of the temporary directory. */
function cmsDirectory() {
  const given = process.env.RADITI_CMS_DIR
  if (given && !isAbsolute(given)) throw new Error('RADITI_CMS_DIR is an absolute path')
  const directory = resolve(given ? given : join(tmpdir(), 'raditi-cms'))
  if (!outside(root, directory)) throw new Error('RADITI_CMS_DIR must be outside the repository')
  return directory
}

async function treeListing() {
  const listed = await rt.run('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'])
  const present = []
  const entries = []
  // The stand itself is no part of what the copy builds: editing it keeps the builds.
  const own = (path) => path.startsWith('infra/dev/stack-verify/')
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
const imagesStampOf = (copy) => join(copy, COPY_MARKER, 'stack-verify-images.json')

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
    const stale = staleFiles(previous, present)
    for (const path of stale) await rm(join(copy, path), { force: true })
    for (const folder of staleDirectories(stale, present))
      await rmdir(join(copy, folder)).catch(keptFolder)
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
    rt.setStage('build: the llm, mcp and preview apps')
    const appsStarted = Date.now()
    await rt.run('pnpm', ['--filter', 'llm', '--filter', 'mcp', '--filter', 'preview', 'build'], {
      cwd: copy,
      env,
      timeoutMs: 20 * 60_000,
    })
    console.log(
      `PASS build: the llm, mcp and preview apps (${Math.round((Date.now() - appsStarted) / 1000)} s)`,
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

/** The image `site` of each PHP version of the chosen builds, as `pnpm verify:site-images` builds it. */
function siteImagesOf(runs) {
  const versions = [...new Set(runs.map(({ build }) => build.php))]
  return versions.map((php) => {
    const row = SITE_BASES.find((base) => base.php === php)
    if (!row) throw new Error(`No row of infra/preview/site-bases.json for PHP ${php}`)
    return {
      name: `site-${php}`,
      php,
      tag: siteImageTag(php),
      file: 'infra/preview/Dockerfile',
      target: 'site',
      context: 'infra/preview',
      buildArgs: siteImageBuildArgs(row),
      base: row.image,
    }
  })
}

/** The images of this tree under the stand's own names, by the digests the configuration takes. */
async function buildImages(copy, options, entries) {
  const digest = treeDigest(entries)
  const sites = siteImagesOf(options.runs)
  const all = [
    ...Object.entries(STACK_BUILT_IMAGES).map(([name, image]) => ({ name, ...image })),
    ...sites,
  ]
  if (options.build)
    for (const image of all) {
      rt.setStage(`docker build ${image.name}`)
      const started = Date.now()
      const context = join(root, image.context ?? '.')
      await rt.docker(
        [
          'build',
          '-f',
          join(root, image.file),
          '--target',
          image.target,
          ...(image.buildArgs ?? []),
          '-t',
          image.tag,
          context,
        ],
        { timeoutMs: 40 * 60_000 },
      )
      console.log(
        `PASS image ${image.tag} built from the tree (${Math.round((Date.now() - started) / 1000)} s)`,
      )
    }
  const images = {}
  for (const image of all) {
    const inspected = await rt.docker(
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', image.tag],
      { allowFailure: true },
    )
    if (inspected.code !== 0)
      throw new Error(`The image ${image.tag} is missing: run without --no-build`)
    images[image.name] = localDigestReference(image.tag, inspected.output)
  }
  if (options.build) await writeFile(imagesStampOf(copy), JSON.stringify({ digest, images }))
  else {
    const stamp = JSON.parse(await readFile(imagesStampOf(copy), 'utf8').catch(() => '{}'))
    const kept = Object.fromEntries(Object.keys(images).map((name) => [name, stamp.images?.[name]]))
    if (stamp.digest !== digest || JSON.stringify(kept) !== JSON.stringify(images))
      throw new Error('--no-build is refused: the images were not built of the tree as it is now')
    console.log('PASS images of the tree reused (--no-build): built of the tree as it is now')
  }
  const siteImages = Object.fromEntries(sites.map((site) => [site.php, images[site.name]]))
  return { images, siteImages }
}

// ─── The run ──────────────────────────────────────────────────────────────────

/** Gitleaks of the version the product scans with: P2_GITLEAKS_BINARY or PATH. */
async function gitleaksBinary() {
  const given = process.env.P2_GITLEAKS_BINARY?.trim()
  const found = given
    ? given
    : (await rt.run('sh', ['-c', 'command -v gitleaks'], { allowFailure: true })).output.trim()
  if (!found || !isAbsolute(found))
    throw new Error(
      `Gitleaks ${GITLEAKS_VERSION} is needed: set P2_GITLEAKS_BINARY or put gitleaks on PATH`,
    )
  const version = await rt.run(found, ['version'], { allowFailure: true })
  if (version.output.trim() !== GITLEAKS_VERSION)
    throw new Error(`Use Gitleaks ${GITLEAKS_VERSION}; ${found} is another version`)
  return found
}

/** A browser of Playwright of this tree is installed: the groups with a browser need it. */
function browserInstalled(engine) {
  const require = createRequire(join(root, 'packages/browser-providers/package.json'))
  const playwright = require('playwright-core')
  const path = playwright[engine].executablePath()
  if (!path || !existsSync(path))
    throw new Error(
      `No ${engine} of Playwright: pnpm --filter e2e exec playwright install ${engine}`,
    )
}

async function preflight(options) {
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
  // The production and the hosting of a build name no runtime (productionArgs): they run under the
  // daemon's default, which must be runc whatever --runtime says.
  const defaultRuntime = (
    await rt.docker(['info', '--format', '{{.DefaultRuntime}}'])
  ).output.trim()
  if (defaultRuntime !== 'runc')
    throw new Error(
      `The default runtime of this daemon is ${defaultRuntime}: the production and the hosting of the stand run under runc only; set the default back to runc`,
    )
  // The runtime reaches the turns and previews of core (stackRoleEnvironment): a daemon without it
  // would fail the first turn, so it is asked here.
  if (options.runtime === 'runsc') {
    const runtimes = await rt.docker(['info', '--format', '{{json .Runtimes}}'])
    if (!Object.hasOwn(JSON.parse(runtimes.output || '{}'), 'runsc'))
      throw new Error(
        '--runtime=runsc needs a daemon with gVisor: Linux or a VM (bash infra/dev/stack-verify/colima-m7.sh), never Docker Desktop',
      )
  }
  const pinned = [
    POSTGRES_IMAGE,
    REDIS_IMAGE,
    S3_IMAGE,
    OPENBAO_IMAGE,
    GITEA_IMAGE,
    RUNNER_IMAGE,
    HOSTING_IMAGE,
    MARIADB_IMAGE,
    ...siteImagesOf(options.runs).map((site) => site.base),
  ]
  for (const image of pinned)
    if ((await rt.docker(['image', 'inspect', image], { allowFailure: true })).code !== 0)
      throw new Error(
        `The pinned image ${image} is missing locally; pull it first (docker pull ${PULLED_TAGS[image] ?? image})`,
      )
  // OpenSSL 3 of Linux knows `version` only; LibreSSL of macOS takes both.
  for (const [tool, flag] of [
    ['git', '--version'],
    ['rsync', '--version'],
    ['openssl', 'version'],
    ['pnpm', '--version'],
  ])
    await rt.run(tool, [flag])
  const gitleaks = await gitleaksBinary()
  browserInstalled('chromium')
  if (options.runs.some(({ groups }) => groups.includes('preview'))) browserInstalled('webkit')
  const host = await hostOfDaemon(info.output.trim())
  console.log(
    `PASS host of the daemon: ${host.kind} (${info.output.trim()}); ${host.mirror ? 'the loopback mirror for the deploy jobs' : `relays of llm, mcp and preview on ${host.relay}, containers go to ${host.upstream}`}`,
  )
  return { socket: endpoint.slice('unix://'.length), gitleaks, host }
}

/**
 * What the host is for containers (stand.mjs, `hostOf`): the gateway of the default bridge and what
 * `host-gateway` resolves to in a probe container (the pinned MariaDB image, no network but the
 * default bridge).
 */
async function hostOfDaemon(operatingSystem) {
  const bridge = await rt.docker([
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ])
  const probe = await rt.docker([
    ...['run', '--rm', '--pull', 'never', '--label', names.label, '--network', 'bridge'],
    ...['--add-host', 'host.docker.internal:host-gateway', '--entrypoint', 'getent'],
    MARIADB_IMAGE,
    ...['ahostsv4', 'host.docker.internal'],
  ])
  return hostOf({
    operatingSystem,
    bridgeGateway: bridgeGatewayAddress(bridge.output),
    hostGateway: hostGatewayOf(probe.output),
  })
}

/** The modules of the copy the stand calls itself: Prisma and billing. */
async function copyModules(copy) {
  const load = (path) => import(pathToFileURL(join(copy, path)).href)
  return {
    db: await load('packages/db/src/index.ts'),
    billing: await load('packages/billing/src/index.ts'),
  }
}

async function main(options, owned) {
  const { socket, gitleaks, host } = await preflight(options)
  if (options.unwritten.length > 0)
    console.log(
      `NOTE the groups ${options.unwritten.join(', ')} are not written yet and do not run (docs/plan/62-site-stacks.md, Э8, Э11)`,
    )

  // The trees of the chosen builds: downloaded once and checked by their sums, never run here.
  rt.setStage('the archives of the CMS')
  const cms = cmsDirectory()
  const trees = {}
  for (const { build } of options.runs)
    trees[build.archive] = await fetchCmsArchive(build.archive, { directory: cms })
  console.log(
    `PASS archives of ${options.runs.map(({ build }) => build.archive).join(', ')} in ${cms}, each by the sum of its row`,
  )

  const copy = copyDirectory()
  owned.lock = await lockCopy(copy)
  const entries = await buildCopy(copy, options)
  const { images, siteImages } = await buildImages(copy, options, entries)

  owned.directory = await mkdtemp(join(tmpdir(), `raditi-stack-verify-run-${names.run}-`))
  const directory = owned.directory
  await chmod(directory, 0o700)
  for (const sub of ['home', 'tmp', 'logs', 'mirrors', 'builds'])
    await mkdir(join(directory, sub), { mode: 0o700 })
  owned.containers = true
  owned.dockerBefore = await dockerResources()

  rt.setStage('ports')
  const ports = {}
  for (const name of [
    'gitea',
    'vault',
    's3',
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
  console.log('PASS migrations and seeds of the tree on the stand database')

  rt.setStage('Gitea, the provisioner, the mirror and the deploy runner')
  const gitea = await startGitea(rt, names, { port: ports.gitea, certificates, directory })
  const provisionerToken = await addProvisioner(rt, gitea)
  await storeOwnerToken(vault, gitea.tokens.owner)
  // Docker Desktop only: on Linux the jobs on the network of the host see its loopback (hostOf).
  if (host.mirror) await startMirror(rt, names, { image: images.core, ports: [ports.releaseApi] })
  const runner = await startRunner(rt, names, {
    gitea,
    ports,
    deployImage: images.core,
    certificates,
    directory,
  })
  owned.runnerUuid = runner.uuid
  console.log(
    'PASS Gitea 1.27.3 over HTTPS with the bot, the release account, the provisioner of repositories and gitea/runner 4.0.0 with the core image of this tree as `deploy`',
  )

  // A production and its hosting per build, each installed by its stack before any process of the
  // platform runs: the address of a site answers when its project is created.
  const runs = []
  for (const run of options.runs) {
    const stand = STACK_STANDS[run.stack]
    const build = run.build
    rt.setStage(`the production of ${build.archive}`)
    const started = Date.now()
    const own = buildNames(names, build.archive)
    const production = await startProduction(rt, own, {
      image: siteImages[build.php],
      treeFolder: trees[build.archive],
      port: await freeLoopbackPort(),
      directory,
    })
    await stand.install(production, build)
    const home = await exchange(`${production.origin}/`, { signal: rt.signal })
    assert.equal(home.status, 200, `The production of ${build.archive} answered ${home.status}`)
    const hosting = {
      ...(await startBuildHosting(rt, own, { production, port: await freeLoopbackPort() })),
      names: own,
    }
    rt.secret(hosting.access.password)
    // The stand's own containers stay on runc whatever --runtime says (Э3.16): read from Docker.
    const ownRuntimes = await rt.docker([
      'inspect',
      '--format',
      '{{.Name}} {{.HostConfig.Runtime}}',
      own.containers.prod,
      own.containers.hosting,
    ])
    const productionRuntimes = parseRuntimes(ownRuntimes.output)
    assert.deepEqual(
      Object.values(productionRuntimes),
      ['runc', 'runc'],
      `The production and the hosting of ${build.archive} must run under runc: ${JSON.stringify(productionRuntimes)}`,
    )
    runs.push({
      ...run,
      stand,
      production,
      hosting,
      siteUrl: production.origin,
      // The tree of the archive, read only: R1 finds there the files the record edits.
      tree: trees[build.archive],
    })
    console.log(
      `PASS production of ${build.archive}: ${stand.stack} ${build.version} on PHP ${build.php} installed at ${production.origin}, its database inside, an SFTP hosting over its document root; both under runc by docker inspect (${Math.round((Date.now() - started) / 1000)} s)`,
    )
  }

  rt.setStage('the synthetic Z.ai')
  owned.model = await startFakeModel({
    key: certificates.key,
    cert: certificates.cert,
    port: ports.zai,
  })

  const secrets = {
    metrics: rt.secret(randomBytes(24).toString('hex')),
    auth: rt.secret(randomBytes(36).toString('base64url')),
    previewSession: rt.secret(randomBytes(36).toString('base64url')),
    botToken: gitea.tokens.bot,
    provisionerToken,
  }
  const context = {
    run: names.run,
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
    // The runtime of the run: P4 compares what Docker ran the turn and the preview under with it.
    runtime: options.runtime,
    socket,
    images,
    siteImages,
    gitleaks,
    runtime: options.runtime,
    host,
  }

  rt.setStage('the relays of the host')
  const relays = hostRelays(host, ports)
  if (relays.length > 0) {
    owned.relays = await startRelays(relays)
    console.log(
      `PASS relays of the stand: ${relays.map(({ role, listen, port, to }) => `${role} ${listen}:${port} → ${to}:${port}`).join(', ')}`,
    )
  }

  rt.setStage('the platform processes')
  owned.processes = []
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
      { timeoutMs: 120_000, service },
    )
    return service
  }
  const processes = {}
  for (const role of ['llm', 'mcp', 'preview'])
    processes[role] = await start(
      role,
      ['dist/main.js'],
      join(copy, `apps/${role}`),
      stackRoleEnvironment(role, context),
      role === 'preview'
        ? `http://127.0.0.1:${ports.preview}/__raditi/health`
        : `http://127.0.0.1:${ports[role]}/health`,
    )
  processes.core = await start(
    'core',
    ['dist/main.js'],
    join(copy, 'apps/core'),
    stackCoreEnvironment(context),
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

  rt.setStage('the owner, the workspace and the model')
  const webUrl = `http://127.0.0.1:${ports.web}`
  const owner = await signUpOwner(rt, { webUrl, db })
  const workspace = await db.$transaction((tx) =>
    modules.billing.ensurePersonalWorkspaceWithGift(tx, { userId: owner.id, appEnv: 'test' }),
  )
  assert.equal(
    (await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).dataClass,
    'synthetic',
  )
  await grantTariff(
    { db, billing: modules.billing },
    { workspaceId: workspace.id, userId: owner.id },
  )
  await switchOnModel(rt, { db, copy, context, vault, directory })
  console.log(
    'PASS the owner signed up through web; the personal workspace of class synthetic with the tariff «Агентство»; the synthetic account and its profiles switched on with their rates',
  )

  const ctx = {
    db,
    gitea,
    names,
    owner,
    webUrl,
    processes,
    directory,
    ports,
    model: owned.model,
    siteImages,
    certificates,
    caFile: certificates.caFile,
    // The runtime of the run: P4 compares what Docker ran the turn and the preview under with it.
    runtime: options.runtime,
    // What the group `release` reads beside the product: the backups in S3, the wrappings in
    // OpenBao, the S3 client of the copy.
    vault,
    s3,
    copy,
    siteIds: [],
  }
  owned.siteIds = ctx.siteIds
  const importing = runs.filter((run) => run.groups.includes('import'))
  if (importing.length > 0) await runImportGroup(rt, ctx, importing)
  // On the sites `import` made: the group never runs without it (GROUP_NEEDS).
  const previewing = runs.filter((run) => run.groups.includes('preview'))
  // A failed P5 does not stop `release` (runPreviewGroup): the run fails on it below.
  const failedFrames = previewing.length > 0 ? await runPreviewGroup(rt, ctx, previewing) : []
  // On the sites of `import`, once `preview` closed its dialogs: never without both (GROUP_NEEDS).
  const releasing = runs.filter((run) => run.groups.includes('release'))
  if (releasing.length > 0) await runReleaseGroup(rt, ctx, releasing)
  // Every group a build was to run left its rows: a group that silently did not run fails here.
  const missing = groupRowProblems(runs, rt.rows)
  if (missing.length > 0) throw new Error(`The table lacks groups: ${missing.join('; ')}`)
  console.log(
    `PASS each build has the rows of each of its groups: ${runs.map(({ build, groups }) => `${build.archive} ${groups.join('+')}`).join(', ')}`,
  )
  if (failedFrames.length > 0)
    throw new Error(
      `The rows of the sign-in in the cabinet's frame failed: ${failedFrames.join(', ')}; the groups after them ran`,
    )

  if (options.keep) {
    console.log(`KEEP the stand is up: web ${webUrl}; Ctrl-C cleans it up`)
    await keptUntilInterrupted()
  }
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

/** What the database says of the imports of a failed run: ids, statuses and codes only. */
async function diagnose(owned) {
  for (const siteId of owned.siteIds ?? []) {
    const stage = await owned.db.siteProvisioningStage.findFirst({ where: { siteId } })
    const site = await owned.db.site.findUnique({ where: { id: siteId } })
    console.error(
      `--- site ${siteId} ${site?.status} stage=${stage?.status} step=${stage?.step} error=${stage?.errorCode} summary=${JSON.stringify(stage?.summary ?? null)} facts=${rt.redact(JSON.stringify(site?.stackFacts ?? null))}`,
    )
  }
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

/** What appeared during the run with no label at all and is still there. */
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
 * Everything of the run, as the release stand does it: the processes of the platform, the synthetic
 * Z.ai, the deploy runner, then every container, network and volume of the run — the stand's by its
 * label, the turn sandboxes, their gateways and the previews by the labels of the sites of the run,
 * the job volumes by the uuid of the runner — and at the end the check that nothing is left.
 */
async function cleanup(owned) {
  const quiet = { allowFailure: true, cleanup: true }
  for (const service of [...(owned.processes ?? [])].reverse()) await service.stop().catch(() => {})
  await owned.model?.close().catch(() => {})
  await owned.relays?.close().catch(() => {})
  await owned.db?.$disconnect().catch(() => {})
  if (!owned.containers) return { left: [], coreOwned: [] }
  await rt.docker(['rm', '-f', '-v', names.containers.runner], quiet)
  const filters = [`label=${names.label}`]
  for (const siteId of owned.siteIds ?? [])
    for (const prefix of [
      'io.raditi.sandbox.siteId',
      'io.raditi.gateway.siteId',
      'io.raditi.preview.site',
    ])
      filters.push(`label=${prefix}=${siteId}`)
  const volumes = new Set()
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
  const to = join(tmpdir(), `raditi-stack-verify-logs-${names.run}`)
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const file of files)
    await writeFile(join(to, file), rt.redact(await readFile(join(from, file), 'utf8')), {
      mode: 0o600,
    })
  return to
}

export async function verifyStack(argv) {
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
      `FAIL stack stand at ${rt.stage}: ${rt.redact(error?.stack ?? error?.message ?? String(error)).slice(0, 4000)}`,
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
      console.error(`FAIL cleanup of the stack stand: ${left.join(', ')}`)
    }
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
    `${failed ? 'FAIL' : 'PASS'} pnpm verify:stack in ${Math.round((Date.now() - started) / 1000)} s`,
  )
  if (failed) throw new Error('Stack verification failed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyStack(process.argv.slice(2)).catch(() => {
    process.exitCode = 1
  })
}
