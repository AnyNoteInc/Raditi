// A task in the cloud browser end to end on this machine (docs/plan/57-browser-tasks.md, §5): a site
// added without access to its files, a task with two images and a PDF, the agent in the site's
// own admin pages through the `web` tools, the client signing in in the same browser — over the
// stream of the gateway and in the cabinet —, the post published once and checked on the site.
// The real apps core (without git), llm, mcp, preview (the stream gateway), browser (the worker)
// and web, the real OpenCode CLI in its sandbox on a scripted synthetic Z.ai, real Chromium in its
// containers, a synthetic WordPress 7.x. Disposable services only; never the repository .env,
// the dev infrastructure, a real model or a real key. The scenarios are in scenarios.mjs.
//
//   pnpm verify:browser-task [-- --no-build] [--keep] [--web-dev] [--only A,F]
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { lockCopy } from '../billing-verify/verify-billing.mjs'
import {
  callerEnv,
  createRuntime,
  exchange,
  freeLoopbackPort,
  startProcess,
} from '../release-verify/runtime.mjs'
import {
  createCertificates,
  startOpenbao,
  startPostgres,
  startRedis,
  startS3,
} from '../release-verify/services.mjs'
import {
  OPENBAO_IMAGE,
  POSTGRES_IMAGE,
  PULLED_TAGS,
  REDIS_IMAGE,
  S3_IMAGE,
} from '../release-verify/stand.mjs'
import { buildCopy, buildImages, copyDirectory } from './build.mjs'
import { startModel } from './model.mjs'
import { runScenarios } from './scenarios.mjs'
import { installSite, startSite } from './site.mjs'
import {
  CORE_WITHOUT,
  MARIADB_IMAGE,
  WORDPRESS_IMAGE,
  WPCLI_IMAGE,
  appEnvironment,
  scenariosToRun,
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

/** The modules of the copy the stand calls itself: Prisma, billing, the domain, snapshots. */
async function copyModules(copy) {
  const load = (path) => import(pathToFileURL(join(copy, path)).href)
  return {
    db: await load('packages/db/src/index.ts'),
    billing: await load('packages/billing/src/index.ts'),
    domain: await load('packages/domain/src/index.ts'),
    snapshots: await load('packages/snapshots/src/index.ts'),
    ids: await load('packages/db/src/uuidv7.ts'),
  }
}

async function main(options, owned) {
  const socket = await preflight()
  const copy = copyDirectory(root)
  owned.lock = await lockCopy(copy)
  const built = await buildCopy(rt, copy, options)
  const images = await buildImages(rt, copy, options, built)

  owned.directory = await mkdtemp(join(tmpdir(), `raditi-browser-task-verify-run-${names.run}-`))
  const directory = owned.directory
  await chmod(directory, 0o700)
  for (const sub of ['home', 'tmp', 'logs']) await mkdir(join(directory, sub), { mode: 0o700 })
  owned.containers = true

  rt.setStage('certificates')
  const certificates = await createCertificates(rt, directory)

  rt.setStage('PostgreSQL, Redis, S3 and OpenBao')
  // PostgreSQL and Redis take ports Docker picks: they are bound before the stand picks its own.
  const postgres = await startPostgres(rt, names, directory)
  const redis = await startRedis(rt, names, directory)
  rt.setStage('ports')
  const ports = {}
  for (const name of [
    'vault',
    's3',
    'site',
    'web',
    'core',
    'mcp',
    'llm',
    'preview',
    'stream',
    'browser',
    'zai',
  ])
    ports[name] = await freeLoopbackPort()
  rt.setStage('PostgreSQL, Redis, S3 and OpenBao')
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

  rt.setStage('the synthetic site')
  const site = await startSite(rt, names, { directory, port: ports.site })
  const installed = await installSite(rt, site)
  console.log(
    `PASS synthetic site: WordPress ${installed.version} with MariaDB at ${site.origin} (published on a loopback port), an editor and a contributor of the run, the stand's must-use plugins ${installed.plugins.join(', ')}`,
  )

  rt.setStage('the synthetic Z.ai')
  const model = await startModel({
    key: certificates.key,
    cert: certificates.cert,
    port: ports.zai,
    logFile: join(directory, 'logs', 'model.log'),
  })
  owned.model = model

  const secrets = {
    metrics: rt.secret(randomBytes(24).toString('hex')),
    auth: rt.secret(randomBytes(36).toString('base64url')),
    previewSession: rt.secret(randomBytes(36).toString('base64url')),
    workerToken: rt.secret(randomBytes(36).toString('base64url')),
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
    siteTarget: site.target,
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
      {
        timeoutMs: name === 'web' && options.webDev ? 300_000 : 120_000,
        service,
      },
    )
    return service
  }
  const app = (name) => join(copy, 'apps', name)
  const processes = {}
  const coreEnv = appEnvironment('core', context)
  for (const name of CORE_WITHOUT) assert.equal(coreEnv[name], undefined, `core is given ${name}`)
  processes.llm = await start(
    'llm',
    ['dist/main.js'],
    app('llm'),
    appEnvironment('llm', context),
    `http://127.0.0.1:${ports.llm}/health`,
  )
  processes.browser = await start(
    'browser',
    ['dist/main.js'],
    app('browser'),
    appEnvironment('browser', context),
    `http://127.0.0.1:${ports.browser}/health`,
  )
  processes.mcp = await start(
    'mcp',
    ['dist/main.js'],
    app('mcp'),
    appEnvironment('mcp', context),
    `http://127.0.0.1:${ports.mcp}/health`,
  )
  processes.preview = await start(
    'preview',
    ['dist/main.js'],
    app('preview'),
    appEnvironment('preview', context),
    `http://127.0.0.1:${ports.preview}/__raditi/health`,
  )
  processes.core = await start(
    'core',
    ['dist/main.js'],
    app('core'),
    coreEnv,
    `http://127.0.0.1:${ports.core}/health`,
  )
  // `next dev` keeps its cache and lock in the copy: a run that was killed leaves them stale.
  if (options.webDev) await rm(join(copy, 'apps/web/.next/dev'), { recursive: true, force: true })
  processes.web = options.webDev
    ? await start(
        'web',
        [
          join(copy, 'apps/web/node_modules/next/dist/bin/next'),
          'dev',
          '--port',
          String(ports.web),
          '--hostname',
          '127.0.0.1',
        ],
        app('web'),
        webEnvironment(context, { dev: true }),
        `http://127.0.0.1:${ports.web}/api/health`,
      )
    : await start(
        'web',
        ['server.js'],
        join(copy, 'apps/web/.next/standalone/apps/web'),
        webEnvironment(context),
        `http://127.0.0.1:${ports.web}/api/health`,
      )
  console.log(
    `PASS the apps llm, browser, mcp, preview and core of their builds and web of ${options.webDev ? '`next dev` of the copy' : '`next build`'}, each its own process; core without ${CORE_WITHOUT.join(', ')}`,
  )

  await runScenarios({
    rt,
    db,
    modules,
    names,
    ports,
    site,
    model,
    vault,
    processes,
    certificates,
    copy,
    directory,
    s3,
    secrets,
    context,
    webUrl: `http://127.0.0.1:${ports.web}`,
    streamUrl: `ws://127.0.0.1:${ports.stream}/v1/browser/stream`,
    workerUrl: `http://127.0.0.1:${ports.browser}`,
    scenarios: scenariosToRun(options.only),
    webDev: options.webDev,
    streamOnly: options.streamOnly,
    owned,
  })
  if (options.keep) {
    console.log(`KEEP the stand is up: web http://127.0.0.1:${ports.web}; Ctrl-C cleans it up`)
    await keptUntilInterrupted()
  }
}

async function keptUntilInterrupted() {
  const hold = setInterval(() => {}, 60_000)
  try {
    await new Promise((done) => rt.signal.addEventListener('abort', done, { once: true }))
  } finally {
    clearInterval(hold)
  }
}

/** What the database says of the tasks of a failed run: ids, statuses and codes only. */
async function diagnose(owned) {
  const db = owned.db
  const tasks = await db.task.findMany({ orderBy: { createdAt: 'asc' } })
  for (const task of tasks) {
    console.error(
      `--- task ${task.id} ${task.status} waiting=${task.waiting} turn=${task.turnNo} attempt=${task.attempt}`,
    )
    const sessions = await db.browserSession.findMany({ where: { taskId: task.id } })
    for (const session of sessions)
      console.error(
        `    session ${session.id} ${session.status} controller=${session.controller} epoch=${session.controlEpoch} help=${session.helpReason} close=${session.closeReason} error=${session.errorCode}`,
      )
    const turns = await db.taskTurn.findMany({
      where: { taskId: task.id },
      orderBy: { turnNo: 'asc' },
    })
    for (const turn of turns)
      console.error(
        `    turn ${turn.turnNo} ${turn.status} failure=${rt.redact(turn.failureReason ?? '').slice(0, 300)}`,
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
  const current = owned.model?.current()
  if (current)
    console.error(
      `--- model program ${current.name}: finished=${current.finished} broken=${current.broken} facts=${rt.redact(JSON.stringify(current.facts)).slice(0, 800)}`,
    )
  for (const move of (owned.model?.moves ?? []).slice(-20))
    console.error(`--- move ${JSON.stringify(move)}`)
  // What the tools of the platform answered the agent last, as the CLI carried it; the whole
  // answers (observations) go to model-answers.txt of the logs kept.
  const last = owned.model?.requests.at(-1)
  if (last) {
    const messages = JSON.parse(last).messages ?? []
    const answers = messages.filter((message) => message?.role === 'tool').slice(-8)
    for (const message of answers.slice(-2))
      console.error(`--- tool answer: ${rt.redact(JSON.stringify(message.content)).slice(0, 1200)}`)
    if (owned.directory)
      await writeFile(
        join(owned.directory, 'logs', 'model-answers.txt'),
        answers
          .map((message) =>
            rt.redact(
              typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content),
            ),
          )
          .join('\n\n=====\n\n'),
        { mode: 0o600 },
      )
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

const lines = (output) =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * Everything of the run: the processes of the platform (the worker closes its sessions as it
 * stops), the synthetic Z.ai, then every container, network and volume — the stand's by its label,
 * the sandboxes of the turns by the site of the run, the browser sessions by the label of the
 * worker — and the check that nothing is left. What the platform should have removed itself is
 * named apart: a passed run must have none of it.
 */
async function cleanup(owned) {
  const quiet = { allowFailure: true, cleanup: true }
  // What core and the worker leave of the run before they stop: they must leave nothing.
  const filters = [`label=${names.label}`]
  if (owned.siteId)
    for (const label of [
      'io.raditi.sandbox.siteId',
      'io.raditi.gateway.siteId',
      'io.raditi.browser.site',
    ])
      filters.push(`label=${label}=${owned.siteId}`)
  const ofPlatform = (filter) => filter !== filters[0]
  const platformLeft = []
  if (owned.checkPlatformLeft)
    for (const filter of filters.filter(ofPlatform))
      for (const kind of [
        ['ps', '-aq'],
        ['network', 'ls', '-q'],
      ])
        platformLeft.push(
          ...lines((await rt.docker([...kind, '--filter', filter], quiet)).output).map(
            (id) => `${kind[0]} ${id}`,
          ),
        )
  for (const service of [...(owned.processes ?? [])].reverse()) await service.stop().catch(() => {})
  await owned.model?.close().catch(() => {})
  await owned.db?.$disconnect().catch(() => {})
  if (!owned.containers) return { left: [], platformLeft }
  const volumes = new Set()
  const mounts = '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}'
  for (const filter of filters)
    for (const id of lines((await rt.docker(['ps', '-aq', '--filter', filter], quiet)).output)) {
      for (const volume of lines(
        (await rt.docker(['inspect', '--format', mounts, id], quiet)).output,
      ))
        volumes.add(volume)
      await rt.docker(['rm', '-f', '-v', id], quiet)
    }
  for (const filter of filters) {
    for (const volume of lines(
      (await rt.docker(['volume', 'ls', '-q', '--filter', filter], quiet)).output,
    ))
      volumes.add(volume)
    for (const network of lines(
      (await rt.docker(['network', 'ls', '-q', '--filter', filter], quiet)).output,
    ))
      await rt.docker(['network', 'rm', network], quiet)
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
  return { left, platformLeft }
}

async function keepLogs(owned) {
  const from = join(owned.directory, 'logs')
  const files = await readdir(from).catch(() => [])
  if (files.length === 0) return null
  const base = process.env.BROWSER_TASK_VERIFY_LOG_DIR || tmpdir()
  const to = join(base, `raditi-browser-task-verify-logs-${names.run}`)
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const file of files)
    await writeFile(join(to, file), rt.redact(await readFile(join(from, file), 'utf8')), {
      mode: 0o600,
    })
  return to
}

export async function verifyBrowserTask(argv) {
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
      `FAIL browser-task stand at ${rt.stage}: ${rt.redact(error?.stack ?? error?.message ?? String(error)).slice(0, 4000)}`,
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
    const { left, platformLeft } = await cleanup(owned).catch((error) => ({
      left: [`cleanup error: ${error.message}`],
      platformLeft: [],
    }))
    if (left.length === 0) {
      if (owned.containers)
        console.log(
          'PASS owned processes, containers, networks and volumes removed; nothing of the run is left',
        )
    } else {
      failed = true
      console.error(`FAIL cleanup of the browser-task stand: ${left.join(', ')}`)
    }
    if (!failed && platformLeft.length > 0) {
      failed = true
      console.error(
        `FAIL the stand had to remove what core and the worker own and left behind: ${platformLeft.join(', ')}`,
      )
    }
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
  const checks = rt.rows.reduce((sum, row) => sum + row.checks, 0)
  console.log(
    `${failed ? 'FAIL' : 'PASS'} pnpm verify:browser-task in ${Math.round((Date.now() - started) / 1000)} s (${checks} checks in scenarios)`,
  )
  if (failed) throw new Error('Browser-task verification failed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyBrowserTask(process.argv.slice(2)).catch(() => {
    process.exitCode = 1
  })
}
