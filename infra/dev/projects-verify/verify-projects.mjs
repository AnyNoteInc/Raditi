// Projects end to end on this machine (docs/plan/84-projects.md, §6, slice 84.23): a project with
// its files, instructions and memory in the instructions of a turn, /workspace/project, an own
// GitLab server by token and gitlab.com by OAuth with PKCE, a repository attached and fetched by
// core's git worker, a turn that changes it and publishes only to the mirror, the cards that send
// the branch, open the merge request, let a change of the build settings go, merge and deploy —
// and the agent that can do none of it itself. The real apps core (with its git worker), llm, mcp
// and web; the real OpenCode CLI in its sandbox on a scripted synthetic Z.ai; a fake GitLab REST
// with real git smart HTTP (fake-gitlab.mjs). Disposable services only; never the repository
// .env, the dev infrastructure, a real model, a real GitLab or a real key. Scenarios —
// scenarios.mjs.
//
//   pnpm verify:projects [-- --no-build] [--keep] [--only E,F]
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { lockCopy } from '../billing-verify/verify-billing.mjs'
import { buildCopy, buildImages, copyDirectory } from '../browser-task-verify/build.mjs'
import { startModel } from '../browser-task-verify/model.mjs'
import {
  callerEnv,
  createRuntime,
  exchange,
  freeLoopbackPort,
  startProcess,
} from '../browser-task-verify/runtime.mjs'
import {
  createCertificates,
  startOpenbao,
  startPostgres,
  startRedis,
  startS3,
} from '../browser-task-verify/services.mjs'
import {
  OPENBAO_IMAGE,
  POSTGRES_IMAGE,
  PULLED_TAGS,
  REDIS_IMAGE,
  S3_IMAGE,
  summaryTable,
} from '../browser-task-verify/stand.mjs'
import { startFakeGithub } from './fake-github.mjs'
import { startFakeGitlab } from './fake-gitlab.mjs'
import { PROGRAMS } from './programs.mjs'
import { runScenarios } from './scenarios.mjs'
import {
  FAKE_HOSTS,
  PROJECTS_BUILD,
  forwarderArgs,
  gitWorkerEnvironment,
  projectAppEnvironment,
  projectWebEnvironment,
  scenariosToRun,
  standNames,
  standOptions,
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
  for (const image of [POSTGRES_IMAGE, REDIS_IMAGE, S3_IMAGE, OPENBAO_IMAGE])
    if ((await rt.docker(['image', 'inspect', image], { allowFailure: true })).code !== 0)
      throw new Error(
        `The pinned image ${image} is missing locally; pull it first (docker pull ${PULLED_TAGS[image] ?? image})`,
      )
  for (const tool of ['git', 'rsync', 'openssl', 'pnpm']) await rt.run(tool, ['--version'])
  await rt.run('gitleaks', ['version'])
  // 443 of loopback is the forwarder's: another stand or server there would take its requests.
  const busy = await exchange('https://127.0.0.1:443/', { timeoutMs: 2000 }).then(
    () => true,
    (error) => error?.code !== 'ECONNREFUSED',
  )
  if (busy)
    throw new Error('Something answers on 127.0.0.1:443: the forwarder of the fake needs it')
  return endpoint.slice('unix://'.length)
}

async function copyModules(copy) {
  const load = (path) => import(pathToFileURL(join(copy, path)).href)
  return {
    db: await load('packages/db/src/index.ts'),
    billing: await load('packages/billing/src/index.ts'),
    domain: await load('packages/domain/src/index.ts'),
    ids: await load('packages/db/src/uuidv7.ts'),
    storage: await load('packages/storage/src/index.ts'),
  }
}

async function main(options, owned) {
  const socket = await preflight()
  const copy = copyDirectory(root, PROJECTS_BUILD)
  owned.lock = await lockCopy(copy)
  const built = await buildCopy(rt, copy, options, PROJECTS_BUILD)
  const images = await buildImages(rt, copy, options, built, PROJECTS_BUILD)
  assert.ok(
    await readFile(join(copy, 'apps/core/dist/git-worker/main.js')).then(
      () => true,
      () => false,
    ),
    'The build of core has no git worker (dist/git-worker/main.js)',
  )

  owned.directory = await mkdtemp(join(tmpdir(), `raditi-projects-verify-run-${names.run}-`))
  const directory = owned.directory
  await chmod(directory, 0o700)
  for (const sub of ['home', 'tmp', 'logs']) await mkdir(join(directory, sub), { mode: 0o700 })
  // The socket of the git worker lies in the volume of the mirrors: a path under $TMPDIR of macOS
  // is longer than the 104 bytes of a Unix socket's address.
  owned.mirrors = await mkdtemp('/tmp/raditi-pv-')
  await chmod(owned.mirrors, 0o700)
  owned.containers = true

  rt.setStage('certificates')
  const certificates = await createCertificates(rt, directory, {
    names: FAKE_HOSTS,
    subject: 'raditi-projects-verify CA',
  })

  rt.setStage('PostgreSQL, Redis, S3 and OpenBao')
  const postgres = await startPostgres(rt, names, directory)
  const redis = await startRedis(rt, names, directory)
  rt.setStage('ports')
  const ports = {}
  for (const name of [
    'vault',
    's3',
    'web',
    'core',
    'mcp',
    'llm',
    'pages',
    'zai',
    'gitlab',
    'github',
  ])
    ports[name] = await freeLoopbackPort()
  rt.setStage('PostgreSQL, Redis, S3 and OpenBao')
  const s3 = await startS3(rt, names, directory, ports.s3)
  const vault = await startOpenbao(rt, names, ports.vault)
  console.log(
    'PASS disposable PostgreSQL 17, Redis 8, SeaweedFS with the buckets of the platform and OpenBao with its mounts, policies and AppRoles (core with core-git)',
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

  rt.setStage('the synthetic Z.ai and the fake GitLab')
  const model = await startModel({
    key: certificates.key,
    cert: certificates.cert,
    port: ports.zai,
    logFile: join(directory, 'logs', 'model.log'),
    programs: PROGRAMS,
  })
  owned.model = model
  const oauth = {
    clientId: rt.secret(`stand-app-${randomBytes(8).toString('hex')}`),
    secret: rt.secret(randomBytes(24).toString('base64url')),
  }
  // Raditi's GitHub App of the stand: its key (RS256) in a file of the run, as core reads it
  // (GITHUB_APP_PRIVATE_KEY_FILE); the fake knows only the public half.
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = appKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  rt.secret(pem.split('\n').slice(1, -2).join(''))
  const keyFile = join(directory, 'github-app.pem')
  await writeFile(keyFile, pem, { mode: 0o600 })
  const githubApp = {
    id: String(400_000 + Math.floor(Math.random() * 100_000)),
    slug: 'raditi-stand',
    clientId: rt.secret(`Iv23stand${randomBytes(6).toString('hex')}`),
    clientSecret: rt.secret(randomBytes(20).toString('hex')),
    webhookSecret: rt.secret(randomBytes(24).toString('base64url')),
    publicKey: appKeys.publicKey,
  }
  const github = await startFakeGithub({
    key: certificates.key,
    cert: certificates.cert,
    port: ports.github,
    app: githubApp,
    callbackUrl: `http://127.0.0.1:${ports.web}/api/git/github/callback`,
    logFile: join(directory, 'logs', 'github.log'),
  })
  owned.github = github
  const gitlab = await startFakeGitlab({
    key: certificates.key,
    cert: certificates.cert,
    port: ports.gitlab,
    oauth,
    logFile: join(directory, 'logs', 'gitlab.log'),
    // git of github.com comes on 443 through the same forwarder.
    delegate: { host: 'github.com', handle: github.handle },
  })
  owned.gitlab = gitlab
  await rt.docker(forwarderArgs({ names, image: images.gateway, fakePort: ports.gitlab }))
  await rt.until('the forwarder of 443 reaches the fake GitLab', async () => {
    const answer = await exchange('https://127.0.0.1:443/api/v4/user', {
      headers: { host: 'gitlab.localhost' },
      ca: certificates.ca,
      timeoutMs: 3000,
    }).catch(() => null)
    return answer?.status === 401
  })
  console.log(
    'PASS the fake GitLab on the stand port (127.0.0.1 and ::1) and on 443 of loopback through the forwarder, TLS of the stand CA',
  )
  console.log(
    'PASS the fake GitHub on its own port (API, installation and sign-in pages), its git on 443 of loopback for github.com; the key of the App only in a file of the run',
  )

  const secrets = {
    metrics: rt.secret(randomBytes(24).toString('hex')),
    auth: rt.secret(randomBytes(36).toString('base64url')),
    workerToken: rt.secret(randomBytes(36).toString('base64url')),
    pagesCookie: rt.secret(randomBytes(36).toString('base64url')),
    pagesSigning: rt.secret(randomBytes(36).toString('base64url')),
    confirm: rt.secret(randomBytes(36).toString('base64url')),
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
    socket,
    images,
    git: {
      mirrorDir: owned.mirrors,
      fakePort: ports.gitlab,
      oauth,
      confirmSecret: secrets.confirm,
      github: {
        origin: github.origin,
        appId: githubApp.id,
        keyFile,
        slug: githubApp.slug,
        clientId: githubApp.clientId,
        clientSecret: githubApp.clientSecret,
        webhookSecret: githubApp.webhookSecret,
      },
    },
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
    if (health)
      await rt.until(
        `${name} answers ${health}`,
        async () => (await exchange(health)).status === 200,
        { timeoutMs: 120_000, service },
      )
    return service
  }
  const app = (name) => join(copy, 'apps', name)
  const processes = {}
  processes.gitWorker = await start(
    'git-worker',
    ['dist/git-worker/main.js'],
    app('core'),
    gitWorkerEnvironment(context),
    null,
  )
  await rt.until(
    'the git worker listens on its socket',
    async () => (await readdir(context.git.mirrorDir)).includes('worker.sock'),
    { timeoutMs: 30_000, service: processes.gitWorker },
  )
  processes.llm = await start(
    'llm',
    ['dist/main.js'],
    app('llm'),
    projectAppEnvironment('llm', context),
    `http://127.0.0.1:${ports.llm}/health`,
  )
  processes.mcp = await start(
    'mcp',
    ['dist/main.js'],
    app('mcp'),
    projectAppEnvironment('mcp', context),
    `http://127.0.0.1:${ports.mcp}/health`,
  )
  processes.core = await start(
    'core',
    ['dist/main.js'],
    app('core'),
    projectAppEnvironment('core', context),
    `http://127.0.0.1:${ports.core}/health`,
  )
  processes.web = await start(
    'web',
    ['server.js'],
    join(copy, 'apps/web/.next/standalone/apps/web'),
    projectWebEnvironment(context),
    `http://127.0.0.1:${ports.web}/api/health`,
  )
  console.log(
    'PASS the git worker, llm, mcp and core of their builds and web of `next build`, each its own process; core and web with the fake of gitlab.com (RADITI_FAKE_GITLAB_COM_URL) and GIT_ALLOW_LOOPBACK',
  )

  // A core started again — after SIGKILL or a stop — with the same environment: its log is
  // core-<n>.log, and the scenarios go on with it (E kills it before a publication, M restarts it
  // for the purge of the trash, which runs at the start of a core).
  let coreStarts = 1
  const restartCore = async ({ kill = false, killed = () => {} } = {}) => {
    const old = processes.core
    if (kill) {
      process.kill(old.pid, 'SIGKILL')
      await old.exited
      killed()
    } else await old.stop()
    coreStarts += 1
    processes.core = await start(
      `core-${coreStarts}`,
      ['dist/main.js'],
      app('core'),
      projectAppEnvironment('core', context),
      `http://127.0.0.1:${ports.core}/health`,
    )
  }

  await runScenarios({
    restartCore,
    rt,
    db,
    modules,
    names,
    ports,
    model,
    gitlab,
    github,
    githubApp,
    vault,
    processes,
    certificates,
    copy,
    directory,
    s3,
    secrets,
    context,
    webUrl: `http://127.0.0.1:${ports.web}`,
    scenarios: scenariosToRun(options.only),
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
  for (const repo of await db.projectRepository.findMany().catch(() => []))
    console.error(`--- repository ${rt.redact(JSON.stringify(repo)).slice(0, 600)}`)
  for (const action of await db.repoAction.findMany().catch(() => []))
    console.error(`--- action ${rt.redact(JSON.stringify(action)).slice(0, 600)}`)
  const current = owned.model?.current()
  if (current)
    console.error(
      `--- model program ${current.name}: finished=${current.finished} broken=${current.broken} facts=${rt.redact(JSON.stringify(current.facts)).slice(0, 1200)}`,
    )
  for (const move of (owned.model?.moves ?? []).slice(-10))
    console.error(`--- move ${JSON.stringify(move)}`)
  for (const entry of (owned.gitlab?.requests ?? []).slice(-15))
    console.error(`--- gitlab ${JSON.stringify({ ...entry, body: undefined })}`)
  for (const entry of (owned.github?.requests ?? []).slice(-15))
    console.error(`--- github ${JSON.stringify(entry)}`)
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

const lines = (output) =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/**
 * Everything of the run: the processes, the model and the fake, then every container, network and
 * volume — the stand's by its label, the sandboxes of the turns by the id of each chat — and the
 * check that nothing is left. What the platform should have removed itself is named apart.
 */
async function cleanup(owned) {
  const quiet = { allowFailure: true, cleanup: true }
  const filters = [`label=${names.label}`]
  for (const scope of owned.chats)
    for (const label of ['io.raditi.sandbox.siteId', 'io.raditi.gateway.siteId'])
      filters.push(`label=${label}=${scope}`)
  const ofPlatform = (filter) => filter !== filters[0]
  const platformLeft = []
  if (owned.checkPlatformLeft)
    for (const filter of filters.filter(ofPlatform))
      for (const kind of [
        ['ps', '-aq'],
        ['network', 'ls', '-q'],
      ])
        for (const id of lines((await rt.docker([...kind, '--filter', filter], quiet)).output)) {
          // What it is, for the line of the failure: its name, its labels of the platform, its state.
          const what = (
            await rt.docker(
              [
                kind[0] === 'ps' ? 'inspect' : 'network',
                ...(kind[0] === 'ps' ? [] : ['inspect']),
                '--format',
                kind[0] === 'ps'
                  ? '{{.Name}} {{.State.Status}} {{.Created}} {{json .Config.Labels}}'
                  : '{{.Name}} {{.Created}}',
                id,
              ],
              quiet,
            )
          ).output.trim()
          platformLeft.push(`${kind[0]} ${id} ${what.slice(0, 600)}`)
        }
  for (const service of [...(owned.processes ?? [])].reverse()) await service.stop().catch(() => {})
  await owned.model?.close().catch(() => {})
  await owned.gitlab?.close().catch(() => {})
  await owned.github?.close().catch(() => {})
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
  const base = process.env.PROJECTS_VERIFY_LOG_DIR || tmpdir()
  const to = join(base, `raditi-projects-verify-logs-${names.run}`)
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const file of files)
    await writeFile(join(to, file), rt.redact(await readFile(join(from, file), 'utf8')), {
      mode: 0o600,
    })
  return to
}

export async function verifyProjects(argv) {
  const started = Date.now()
  for (const signal of SIGNALS) process.on(signal, interrupt)
  const owned = { chats: [] }
  let failed = false
  try {
    const options = standOptions(argv)
    owned.keep = options.keep
    await main(options, owned)
  } catch (error) {
    failed = true
    console.error(
      `FAIL projects stand at ${rt.stage}: ${rt.redact(error?.stack ?? error?.message ?? String(error)).slice(0, 4000)}`,
    )
    for (const service of owned.processes ?? []) {
      const tail = service.log().split('\n').slice(-30).join('\n')
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
      console.error(`FAIL cleanup of the projects stand: ${left.join(', ')}`)
    }
    if (!failed && platformLeft.length > 0) {
      failed = true
      console.error(
        `FAIL the stand had to remove what core owns and left behind: ${platformLeft.join(', ')}`,
      )
    }
    if (owned.directory) {
      if (failed) {
        const logs = await keepLogs(owned).catch(() => null)
        if (logs) console.error(`LOGS of the failed run (redacted): ${logs}`)
      }
      await rm(owned.directory, { recursive: true, force: true }).catch(() => {})
    }
    if (owned.mirrors) await rm(owned.mirrors, { recursive: true, force: true }).catch(() => {})
    if (owned.lock) await rm(owned.lock, { recursive: true, force: true }).catch(() => {})
    for (const signal of SIGNALS) process.removeListener(signal, interrupt)
  }
  if (rt.rows.length > 0) console.log(summaryTable(rt.rows))
  const checks = rt.rows.reduce((sum, row) => sum + row.checks, 0)
  console.log(
    `${failed ? 'FAIL' : 'PASS'} pnpm verify:projects in ${Math.round((Date.now() - started) / 1000)} s (${checks} checks in scenarios)`,
  )
  if (failed) throw new Error('Projects verification failed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyProjects(process.argv.slice(2)).catch(() => {
    process.exitCode = 1
  })
}
