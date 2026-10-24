// The whole money path on built applications (docs/plan/37-billing-plan.md, «Проверочный
// стенд»): web and the `core` role of the orchestrator from their builds, a disposable
// PostgreSQL, Redis and OpenBao, the fake ЮKassa of this directory, and a synthetic WordPress on
// an SFTP server of the stand, which a customer's first site is added from. The scenarios
// (scenarios*.mjs) drive the product as a customer, as ЮKassa and as an operator: over HTTP,
// through the pay page and the control API of the fake, and with the operator's scripts. Time
// moves by editing dates in the stand's own database; the scheduler of core ticks every second.
//
//   pnpm verify:billing [-- --no-build] [--keep] [--only <scenario>[,<scenario>]]
//
//   --no-build  use the builds of the private copy; refused when the tree has changed since
//   --keep      leave the stand up after the scenarios, until Ctrl-C; then clean up as usual
//   --only      run the named scenarios alone (their ids are in stand.mjs)
//
// Never reads the repository .env, never builds inside the repository (another session may run
// `next dev` of apps/web there), never touches a container, a process or a database it did not
// start. A run that was killed outright is cleaned up by the next one, by its own record: the
// containers that carry its id, the processes it started that still run in its build copy.
// Synthetic data only; the secrets are random and live in memory and in the run directory,
// which is removed. The output names checks, never a secret.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { run } from '../db-verify/command.mjs'
import { startFakeYookassa } from './fake-yookassa.mjs'
import { kvVersion, openbaoReady, prepareSitesWriter } from './openbao.mjs'
import { runScenarios } from './scenarios.mjs'
import {
  BUILD_OUTPUT,
  BUILD_STAMP,
  BUILD_STEPS,
  CLEANUP_ORDER,
  COPY_MARKER,
  LETTER_MIRROR_SQL,
  LETTER_READER,
  OPENBAO_IMAGE,
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  RUN_RECORD,
  RUN_STAGING_PREFIX,
  SCENARIOS,
  SHOP_ID,
  SITE_FILES,
  SITE_ROOT,
  SITE_USER,
  STAND_LABEL,
  TICK_SECONDS,
  buildDirectory,
  buildEnvironment,
  buildStamp,
  containerName,
  copyablePath,
  coreEnvironment,
  databaseEnvironment,
  isRunDirectory,
  letterReaderEnvironment,
  lettersOf,
  logDirectory,
  manifestDuringCopy,
  operatorEnvironment,
  postgresContainerArgs,
  postgresEnvFile,
  publishedPort,
  readBuildStamp,
  readRunRecord,
  redisContainerArgs,
  redisEnvFile,
  runDirectoryName,
  runRecord,
  staleCopy,
  staleCopyAllowed,
  staleFiles,
  standOptions,
  sweepLine,
  sweepOf,
  treeEntry,
  vaultContainerArgs,
  vaultEnvFile,
  webEnvironment,
} from './stand.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const root = resolve(here, '../../..')
const runId = randomBytes(4).toString('hex')
const secrets = {
  postgres: randomBytes(24).toString('hex'),
  redis: randomBytes(24).toString('hex'),
  auth: randomBytes(36).toString('base64url'),
  metrics: randomBytes(24).toString('base64url'),
  shopKey: `test_${randomBytes(18).toString('base64url')}`,
  unused: randomBytes(18).toString('base64url'),
  vaultRoot: randomBytes(24).toString('hex'),
  sitePassword: randomBytes(18).toString('base64url'),
  // The secret id of web's AppRole: made by OpenBao once it runs (`prepareSitesWriter`).
  vaultSecretId: undefined,
}
const redact = (text) =>
  Object.values(secrets)
    .filter(Boolean)
    .reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text)

const controller = new AbortController()
const interrupt = () => controller.abort(new Error('The stand was interrupted'))
/**
 * The signals the stand cleans up after. SIGHUP too: a terminal or an SSH session that closes
 * must not leave the containers and web behind. (After SIGKILL nothing can run: the next run
 * sweeps — `sweepDeadRuns`.)
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
/** A terminal that is gone cannot be written to; the cleanup goes on without its lines. */
const outputGone = () => {}
/** Only what Docker, git, rsync and pnpm need of the caller's environment. */
const callerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => ['PATH', 'HOME'].includes(key) || key.startsWith('DOCKER_'),
  ),
)
const passed = (text) => console.log(`PASS ${text}`)
let stage = 'preflight'

/** A bounded child process; its output is captured, and a failure shows the end of it. */
function command(
  program,
  args,
  { cwd = root, env, input, cleanup = false, timeoutMs, ...rest } = {},
) {
  return run(program, args, {
    cwd,
    env: env ?? callerEnv,
    input,
    stage,
    timeoutMs: timeoutMs ?? 60_000,
    // The cleanup still runs after an interrupt.
    signal: cleanup ? undefined : controller.signal,
    redact,
    ...rest,
  })
}
const docker = (args, options) => command('docker', args, options)

async function availableLoopbackPort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )

// ─── The private copy and its builds ──────────────────────────────────────────

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** A signal to a process that may have ended a moment ago. */
const signalTo = (pid, signal) => {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

/**
 * One run at a time works with the copy: a second one would rebuild the files the first one is
 * running. The lock is a directory that holds the pid of its run. It is made aside and renamed
 * into place, so it never exists without its pid: a lock another run is just taking cannot be
 * mistaken for an abandoned one. A lock a killed run left behind names a process that is gone
 * and is taken over.
 */
export async function lockCopy(copy, { pid = process.pid, holderAlive = alive } = {}) {
  const lock = `${copy}.lock`
  await mkdir(dirname(copy), { recursive: true })
  const made = await mkdtemp(`${lock}-`)
  try {
    await writeFile(join(made, 'pid'), String(pid))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Fails while a lock is there: a directory that holds a file is never replaced.
        await rename(made, lock)
        return lock
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
      }
      const holder = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => ''))
      if (Number.isInteger(holder) && holder > 0 && holderAlive(holder))
        throw new Error(
          `Another run of the stand (pid ${holder}) is using the build copy; ` +
            'wait for it or give this run its own BILLING_VERIFY_BUILD_DIR',
        )
      await rm(lock, { recursive: true, force: true })
    }
    throw new Error('The lock of the build copy could not be taken')
  } catch (error) {
    await rm(made, { recursive: true, force: true })
    throw error
  }
}

/**
 * The tree as a copy is made of it: every tracked or untracked file that git does not ignore,
 * so neither `.env` nor a build of the repository is in it; and one entry per file — its path,
 * size and time of writing — by which a later run tells whether the tree is still this one.
 */
async function treeListing() {
  const listed = await command('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'])
  const tracked = listed.output.split('\0').filter(copyablePath)
  // A file deleted in the tree and not yet in the index is still listed.
  const present = []
  const entries = []
  for (const path of tracked) {
    const entry = await lstat(join(root, path)).catch(() => null)
    if (entry === null || entry.isDirectory()) continue
    present.push(path)
    entries.push(treeEntry(path, entry))
  }
  assert.ok(present.includes('pnpm-lock.yaml'), 'The listing of the tree has no lockfile')
  assert.ok(!present.includes('.env'), 'The repository .env must never reach the copy')
  return { present, entries }
}

const stampOf = (copy) => join(copy, COPY_MARKER, BUILD_STAMP)

/**
 * The files a build was made of as the copy holds them now, by the copy's own `lstat`: a file
 * that was edited in the copy — a product broken there on purpose, a hand that slipped — is
 * not the file the stamp names. A link carries no time of its own through rsync: its size is
 * what is compared.
 */
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

/**
 * Brings the copy to the state of the working tree. Files the tree has lost since the last
 * run are removed by the manifest of that run; while the copy is being written the manifest
 * names both what was there and what is coming, so a run that dies here hides nothing from the
 * next one. The stamp of the last build goes first: from here on the copy is not that build.
 */
async function syncCopy(copy) {
  const marker = join(copy, COPY_MARKER)
  if ((await exists(copy)) && !(await exists(marker))) {
    assert.equal(
      (await readdir(copy)).length,
      0,
      'The build directory holds files of someone else: give the stand a directory of its own',
    )
  }
  await mkdir(marker, { recursive: true })
  await rm(stampOf(copy), { force: true })
  const { present, entries } = await treeListing()
  const manifest = join(marker, 'manifest')
  const previous = (await readFile(manifest, 'utf8').catch(() => '')).split('\0').filter(Boolean)
  await writeFile(manifest, manifestDuringCopy(previous, present).join('\0'))
  for (const path of staleFiles(previous, present)) await rm(join(copy, path), { force: true })
  await command('rsync', ['-a', '--from0', '--files-from=-', `${root}/`, `${copy}/`], {
    input: present.join('\0'),
  })
  await writeFile(manifest, present.join('\0'))
  return entries
}

/**
 * Builds web and the orchestrator in the copy, or — with `--no-build` — makes sure the copy is
 * a finished build of the tree as it is now. Resolves to whether the run goes on a stale copy
 * that was let through (BILLING_VERIFY_STALE_COPY=allow).
 */
async function build(copy, options, allowStale) {
  const outputs = Object.entries(BUILD_OUTPUT).filter(([name]) => name !== 'webStaticServed')
  for (const tool of ['git', ...(options.build ? ['rsync', 'pnpm'] : [])])
    await command(tool, ['--version'])
  if (options.build) {
    stage = 'copying the tree'
    const entries = await syncCopy(copy)
    passed(
      `private copy of the working tree: ${entries.length} files, no .env, outside the repository`,
    )
    const env = buildEnvironment({ path: callerEnv.PATH, home: callerEnv.HOME })
    for (const step of BUILD_STEPS) {
      stage = `build: ${step.title}`
      const started = Date.now()
      await command('pnpm', step.args, {
        cwd: copy,
        env: { ...env, ...step.env },
        timeoutMs: 15 * 60_000,
      })
      passed(`build: ${step.title} (${Math.round((Date.now() - started) / 1000)} s)`)
    }
    // As the runtime stage of apps/web/Dockerfile: the standalone server serves its own static
    // files, so a page of the kept stand opens in a browser.
    await rm(join(copy, BUILD_OUTPUT.webStaticServed), { recursive: true, force: true })
    await cp(join(copy, BUILD_OUTPUT.webStatic), join(copy, BUILD_OUTPUT.webStaticServed), {
      recursive: true,
    })
    // After the last step, of the listing the copy was made from: a file that changed while
    // the builds ran makes the next --no-build ask for a build.
    await writeFile(stampOf(copy), buildStamp({ builtAt: new Date().toISOString(), entries }))
  }
  stage = 'checking the builds'
  for (const [name, path] of outputs)
    assert.ok(
      await exists(join(copy, path)),
      `The copy has no ${name} build (${path}): run the stand without --no-build`,
    )
  // The copy never holds the repository .env: git ignores it, and nothing else copies files.
  assert.ok(!(await exists(join(copy, '.env'))), 'The build copy holds a .env')
  if (options.build) return false
  const stamp = readBuildStamp(await readFile(stampOf(copy), 'utf8').catch(() => ''))
  const stale = staleCopy(
    stamp,
    (await treeListing()).entries,
    stamp === null ? [] : await copyListing(copy, stamp),
  )
  if (stale === null) {
    passed(
      `builds of the private copy reused (--no-build): built at ${stamp.builtAt} of the tree as it is now`,
    )
    return false
  }
  if (!allowStale)
    throw new Error(`--no-build is refused: ${stale}; run the stand without --no-build`)
  console.log(
    `WARNING BILLING_VERIFY_STALE_COPY=allow: THE COPY IS NOT THE TREE (${stale}). ` +
      'The scenarios of the tree run on whatever the copy holds: this run checks the stand ' +
      'itself against a product broken on purpose and proves nothing about the tree.',
  )
  return true
}

// ─── What a run that died left behind ─────────────────────────────────────────

/** The working directory of a process, resolved through symlinks; null when it cannot be read. */
async function workingDirectory(pid) {
  if (process.platform === 'linux') return readlink(`/proc/${pid}/cwd`).catch(() => null)
  const listed = await command('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    allowFailure: true,
    timeoutMs: 10_000,
  }).catch(() => null)
  const [, path] = /^n(.+)$/m.exec(listed?.output ?? '') ?? []
  return path ?? null
}

/**
 * Cleans up after runs of the stand that ended without cleaning up — killed with SIGKILL, or
 * the machine went down: for every run directory whose stand is gone, what `sweepOf` selects
 * by the record in it, and one line. Nothing is ever chosen by a name: another session's
 * `next dev` is called `next-server` like the web of the stand, and its containers are its own.
 */
async function sweepDeadRuns() {
  const tmp = tmpdir()
  for (const name of (await readdir(tmp)).filter(isRunDirectory).sort()) {
    const directory = join(tmp, name)
    const record = readRunRecord(
      name,
      await readFile(join(directory, RUN_RECORD), 'utf8').catch(() => ''),
    )
    if (record === null || record.run === runId || alive(record.pid)) continue
    const copy = await realpath(record.copy).catch(() => null)
    const cwds = new Map()
    for (const { pid } of record.services)
      if (alive(pid)) cwds.set(pid, await workingDirectory(pid))
    const labelled = await docker([
      ...['ps', '-a', '--filter', `label=${STAND_LABEL}=${record.run}`],
      ...['--format', `{{.Names}}\t{{.Label "${STAND_LABEL}"}}`],
    ])
    const containers = labelled.output
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .map(([container, run]) => ({ name: container, run }))
    const lock = `${record.copy}.lock`
    const lockPid = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => '')) || null
    const sweep = sweepOf(record, { self: runId, alive, cwds, copy, containers, lockPid })
    if (sweep === null) continue
    // As a deployment stops them; a process that does not leave in time is killed.
    for (const { pid } of sweep.processes) signalTo(pid, 'SIGTERM')
    const deadline = Date.now() + 10_000
    while (sweep.processes.some(({ pid }) => alive(pid)) && Date.now() < deadline)
      await sleep(100, undefined, { signal: controller.signal })
    for (const { pid } of sweep.processes) signalTo(pid, 'SIGKILL')
    for (const container of sweep.containers) await docker(['rm', '-fv', container])
    await rm(directory, { recursive: true, force: true })
    if (sweep.lock) await rm(lock, { recursive: true, force: true })
    console.log(sweepLine(sweep))
  }
}

// ─── Processes ────────────────────────────────────────────────────────────────

/**
 * A service of the stand: its output goes to a file of the run directory and stays in memory
 * for the scenarios (the letters core logs, the lines web writes about notifications).
 */
function startService(name, script, { cwd, env, logFile }) {
  const file = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
  const child = spawn(process.execPath, [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  const capture = (chunk) => {
    log += chunk.toString('utf8')
    file.write(chunk)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const exited = new Promise((done) => {
    child.once('error', () => done(null))
    child.once('close', (code) => done(code))
  })
  let stopping = false
  return {
    name,
    pid: child.pid,
    log: () => log,
    /** Where the log stands now: `logSince` of this mark is what the service says from here on. */
    mark: () => log.length,
    logSince: (mark) => log.slice(mark),
    exited,
    running: () => child.exitCode === null && child.signalCode === null,
    stopping: () => stopping,
    /** SIGTERM, as a deployment stops it; SIGKILL when it does not leave in time. */
    async stop() {
      stopping = true
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        // Cleared once the process has left: a timer that is still pending would hold the
        // stand itself up for the rest of its fifteen seconds.
        const overdue = setTimeout(() => child.kill('SIGKILL'), 15_000)
        await exited
        clearTimeout(overdue)
      }
      await new Promise((done) => file.end(done))
    },
  }
}

/** No more than this many lines of one service are printed after a failure. */
const REPORTED_LINES = 400

/**
 * What the services of the run said, once per run: since the scenario that failed began, or
 * their last 30 lines when the stand failed outside a scenario. The lines name synthetic
 * customers and one-time links of a database that is about to be removed, never a secret of
 * the stand. The whole logs are kept aside by the cleanup (`keepLogs`).
 */
function reportLogs(owned) {
  if (owned.reported) return
  owned.reported = true
  for (const service of owned.services ?? []) {
    const since = owned.scenario?.marks.get(service)
    const lines = (since === undefined ? service.log() : service.logSince(since)).split('\n')
    const shown = since === undefined ? lines.slice(-30) : lines.slice(-REPORTED_LINES)
    const what =
      since === undefined
        ? `last lines of ${service.name}`
        : `${service.name} since scenario ${owned.scenario.id} began` +
          (shown.length < lines.length
            ? ` (its last ${shown.length} lines of ${lines.length}; the rest is in the kept logs)`
            : '')
    console.error(`--- ${what}\n${redact(shown.join('\n'))}`)
  }
}

/**
 * Keeps the logs of a failed run, which is about to lose its run directory: web, core and the
 * second core, whole, with the secrets of the run blanked. Resolves to where they are.
 */
async function keepLogs(owned) {
  const from = join(owned.directory, 'logs')
  const names = (await readdir(from).catch(() => [])).sort()
  if (names.length === 0) return null
  const to = owned.logDirectory
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const name of names)
    await writeFile(join(to, name), redact(await readFile(join(from, name), 'utf8')), {
      mode: 0o600,
    })
  return to
}

/** Polls until `probe` answers something truthy; says what it waited for when it does not. */
async function until(what, probe, { timeoutMs = 60_000, service } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answer = await probe().catch(() => null)
    if (answer) return answer
    if (service && !service.running())
      throw new Error(`${service.name} exited while the stand waited for: ${what}`)
    if (Date.now() > deadline) throw new Error(`Waited ${timeoutMs / 1000} s for: ${what}`)
    await sleep(200, undefined, { signal: controller.signal })
  }
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

// ─── The run ──────────────────────────────────────────────────────────────────

async function main(options, owned) {
  // Preflight: a local Docker with the three pinned images; nothing is pulled.
  const context = await docker([
    'context',
    'inspect',
    '--format',
    '{{json .Endpoints.docker.Host}}',
  ])
  const endpoint = callerEnv.DOCKER_CONTEXT
    ? JSON.parse(context.output)
    : (callerEnv.DOCKER_HOST ?? JSON.parse(context.output))
  assert.match(
    endpoint,
    /^(unix|npipe):\/\//,
    'This stand needs a local Docker socket; remote Docker endpoints are refused',
  )
  for (const image of [POSTGRES_IMAGE, REDIS_IMAGE, OPENBAO_IMAGE])
    assert.equal(
      (await docker(['image', 'inspect', image, '--format', '{{.Id}}'], { allowFailure: true }))
        .code,
      0,
      `The pinned image ${image.split('@')[0]} is missing locally; the stand pulls nothing`,
    )

  const copy = buildDirectory(process.env, tmpdir(), root)
  // Where the logs go if the run fails: a wrong BILLING_VERIFY_LOG_DIR is refused here, not
  // in the middle of the cleanup.
  owned.logDirectory = logDirectory(process.env, tmpdir(), runId, root)
  const allowStale = staleCopyAllowed(process.env, options)
  // Before the lock is taken: a run that died is cleaned up whole, its lock with it.
  stage = 'sweeping after runs that died'
  await sweepDeadRuns()
  stage = 'locking the build copy'
  owned.lock = await lockCopy(copy)
  owned.staleCopy = await build(copy, options, allowStale)

  stage = 'preparing the run directory'
  // The record of the run: what the next run cleans up by if this one is killed outright.
  // The directory is made aside and renamed into place with the record in it, so a run
  // directory never exists without one. The record follows every process the run starts.
  owned.services = []
  const recorded = () =>
    runRecord({
      run: runId,
      pid: process.pid,
      copy,
      services: owned.services.filter(({ pid }) => pid !== undefined),
    })
  const staging = await mkdtemp(join(tmpdir(), RUN_STAGING_PREFIX))
  owned.directory = staging
  await chmod(staging, 0o700)
  await writeFile(join(staging, RUN_RECORD), recorded(), { mode: 0o600 })
  const directory = join(tmpdir(), runDirectoryName(runId))
  await rename(staging, directory)
  owned.directory = directory
  const start = async (name, script, options) => {
    const service = startService(name, script, options)
    owned.services.push(service)
    const record = join(directory, RUN_RECORD)
    await writeFile(`${record}.new`, recorded(), { mode: 0o600 })
    await rename(`${record}.new`, record)
    return service
  }
  for (const name of ['home', 'tmp', 'logs']) await mkdir(join(directory, name), { mode: 0o700 })
  await writeFile(join(directory, 'postgres.env'), postgresEnvFile(secrets.postgres), {
    mode: 0o600,
  })
  await writeFile(join(directory, 'redis.env'), redisEnvFile(secrets.redis), { mode: 0o600 })
  await writeFile(join(directory, 'vault.env'), vaultEnvFile(secrets.vaultRoot), { mode: 0o600 })

  stage = 'starting the disposable PostgreSQL, Redis and OpenBao'
  // Set before the run: Docker may create a container before its client reports a failure.
  owned.containers = true
  await docker(postgresContainerArgs({ run: runId, envFile: join(directory, 'postgres.env') }))
  await docker(redisContainerArgs({ run: runId, envFile: join(directory, 'redis.env') }))
  await docker(vaultContainerArgs({ run: runId, envFile: join(directory, 'vault.env') }))
  const postgres = containerName(runId, 'postgres')
  const redis = containerName(runId, 'redis')
  const vault = containerName(runId, 'vault')
  await until('PostgreSQL to accept connections', async () => {
    const probe = await docker(
      ['exec', postgres, 'pg_isready', '-h', '127.0.0.1', '-U', 'raditi', '-d', 'raditi'],
      { allowFailure: true },
    )
    return probe.code === 0
  })
  await until('Redis to answer', async () => {
    const probe = await docker(
      ['exec', redis, 'sh', '-c', 'redis-cli --no-auth-warning -a "$REDIS_PASSWORD" ping'],
      { allowFailure: true },
    )
    return probe.output === 'PONG'
  })
  const ports = {
    postgres: publishedPort((await docker(['port', postgres, '5432/tcp'])).output),
    redis: publishedPort((await docker(['port', redis, '6379/tcp'])).output),
    vault: publishedPort((await docker(['port', vault, '8200/tcp'])).output),
    web: await availableLoopbackPort(),
    core: await availableLoopbackPort(),
    secondCore: await availableLoopbackPort(),
  }
  const databaseUrl = `postgresql://raditi:${secrets.postgres}@127.0.0.1:${ports.postgres}/raditi`
  const redisUrl = `redis://default:${secrets.redis}@127.0.0.1:${ports.redis}`
  passed(
    `disposable PostgreSQL 17 on 127.0.0.1:${ports.postgres} and Redis 8 on 127.0.0.1:${ports.redis}`,
  )
  // The Vault of web: the mounts and policies of infra/vault, and web's AppRole with the policies
  // `sites-writer` and `workspace-provisioner`. The root token stays with the stand: it reads a
  // version, never a value.
  const vaultAddress = `http://127.0.0.1:${ports.vault}`
  await openbaoReady(vaultAddress, { signal: controller.signal })
  const sitesWriter = await prepareSitesWriter({ address: vaultAddress, token: secrets.vaultRoot })
  secrets.vaultSecretId = sitesWriter.secretId
  passed(
    `disposable OpenBao (dev mode) on ${vaultAddress}: kv/ and the policies of infra/vault; web logs in by the AppRole sites-writer`,
  )

  stage = 'migrations and seeds'
  const databaseEnv = databaseEnvironment({
    path: callerEnv.PATH,
    home: callerEnv.HOME,
    databaseUrl,
  })
  // prisma.config.ts says which database a command works on and where the address came from.
  const target = `[db] target raditi@127.0.0.1:${ports.postgres}/raditi: DATABASE_URL from the environment`
  for (const script of ['db:deploy', 'db:seed']) {
    const done = await command('pnpm', ['--filter', '@repo/db', script], {
      cwd: copy,
      env: databaseEnv,
      timeoutMs: 180_000,
    })
    assert.ok(done.output.includes(target), `${script} did not name the database of the stand`)
  }
  const { Pool } = createRequire(join(copy, BUILD_OUTPUT.database))('pg')
  const db = new Pool({ connectionString: databaseUrl, max: 6, connectionTimeoutMillis: 5_000 })
  // An idle client whose container is being removed must not take the process down.
  db.on('error', () => {})
  owned.db = db
  // The prices and the credits the scenarios count on (PRICE and CREDITS of scenario-kit.mjs):
  // a seed that sells other terms is told here, before any scenario pays for it.
  const { rows: plans } = await db.query(
    `SELECT slug, price::text AS price, COALESCE(credits_per_month, pack_credits) AS credits
     FROM plans WHERE is_active ORDER BY sort_order`,
  )
  assert.deepEqual(
    plans.filter(({ slug }) => ['start', 'business', 'pack'].includes(slug)),
    [
      { slug: 'start', price: '4900.00', credits: 300 },
      { slug: 'business', price: '12900.00', credits: 800 },
      { slug: 'pack', price: '1990.00', credits: 100 },
    ],
    'The seeds of the stand are not the tariffs the scenarios pay for',
  )
  // What every letter is made of is kept aside from here on: the product keeps none of it.
  for (const statement of LETTER_MIRROR_SQL) await db.query(statement)
  passed('all migrations applied and reference data seeded in the database of the stand')

  stage = 'starting the site, the fake ЮKassa, web and core'
  // The site customers add: the test SFTP server of @repo/site-connections, in this process.
  const { startTestSftpServer } = await import(
    new URL('../../../packages/site-connections/src/testing/sftp-server.ts', import.meta.url).href
  )
  const siteServer = await startTestSftpServer({
    files: SITE_FILES,
    users: [{ username: SITE_USER, password: secrets.sitePassword }],
  })
  owned.siteServer = siteServer
  passed(
    `a synthetic WordPress on SFTP at 127.0.0.1:${siteServer.port} (${SITE_ROOT}), host key ${siteServer.hostKey}`,
  )
  const fake = await startFakeYookassa({
    shopId: SHOP_ID,
    secretKey: secrets.shopKey,
    webhookUrl: `http://127.0.0.1:${ports.web}/api/webhooks/yookassa`,
  })
  owned.fake = fake
  const shared = {
    path: callerEnv.PATH,
    directory,
    ports,
    databaseUrl,
    redisUrl,
    fakeApiUrl: fake.apiUrl,
    secrets,
    vault: { address: vaultAddress, ...sitesWriter },
  }
  const webUrl = `http://127.0.0.1:${ports.web}`
  const web = await start('web', join(copy, BUILD_OUTPUT.web), {
    cwd: dirname(join(copy, BUILD_OUTPUT.web)),
    env: webEnvironment(shared),
    logFile: join(directory, 'logs/web.log'),
  })
  owned.web = web
  const startCore = (name, port) =>
    start(name, join(copy, BUILD_OUTPUT.core), {
      cwd: join(copy, 'apps/core'),
      env: coreEnvironment({ ...shared, port }),
      logFile: join(directory, `logs/${name}.log`),
    })
  const coreReady = async (service, port) => {
    await until(
      `${service.name} to schedule its renewal passes`,
      async () => /Renewal passes \(.+\) run every 1 s/.test(service.log()),
      { service },
    )
    // Billing needs PostgreSQL and Redis of core. S3 and Vault are throwaway addresses: the
    // report says they are away, and that is all core does about them here.
    const health = await until(
      `${service.name} to answer /health`,
      async () => {
        const { body } = await getJson(`http://127.0.0.1:${port}/health`, secrets.metrics)
        return body?.checks ? body : null
      },
      { service },
    )
    return health
  }
  const core = await startCore('core', ports.core)
  owned.core = core
  const webHealth = await until(
    'web to answer /api/health',
    async () => {
      const { body } = await getJson(`${webUrl}/api/health`, secrets.metrics)
      return body?.checks ? body : null
    },
    { service: web },
  )
  const coreHealth = await coreReady(core, ports.core)
  const down = (report) =>
    Object.entries(report.checks)
      .filter(([, state]) => state !== 'ok')
      .map(([name]) => name)
      .sort()
  assert.equal(webHealth.checks.database, 'ok', 'web does not reach the database of the stand')
  assert.equal(coreHealth.checks.database, 'ok', 'core does not reach the database of the stand')
  assert.equal(coreHealth.checks.redis, 'ok', 'core does not reach the Redis of the stand')
  passed(
    `web (next build, standalone) on ${webUrl}; not configured there, as meant: ${down(webHealth).join(', ')}`,
  )
  passed(
    `core (node dist/main.js) on 127.0.0.1:${ports.core}, a pass every second; away, as meant: ${down(coreHealth).join(', ')}`,
  )

  // The queue of the renewal passes: which passes core has finished, and when; and the one
  // thing a scenario may change there — the scheduler of a pass, taken away for a while.
  const { Queue } = createRequire(join(copy, 'apps/core/package.json'))('bullmq')
  const queue = new Queue('billing', { connection: { url: redisUrl, maxRetriesPerRequest: null } })
  queue.on('error', () => {})
  owned.queue = queue
  /** The schedulers that are taken away now, as core registered them: pass → scheduler. */
  const paused = new Map()
  const schedulers = {
    /**
     * Core stops running the pass: its scheduler is removed, and the jobs of the pass that
     * were queued or running by then have ended when this resolves. The other passes go on.
     */
    async pause(job) {
      const id = `billing.${job}`
      const scheduler = await queue.getJobScheduler(id)
      assert.equal(scheduler?.every, TICK_SECONDS * 1000, `core has no scheduler ${id}`)
      paused.set(job, scheduler)
      await queue.removeJobScheduler(id)
      await until(`the queued passes of ${job} to end`, async () =>
        (await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'paused'])).every(
          (queued) => queued?.name !== job,
        ),
      )
    },
    /** The scheduler is back exactly as core registered it; its first pass runs at once. */
    async resume(job) {
      const scheduler = paused.get(job)
      if (scheduler === undefined) return
      const id = `billing.${job}`
      await queue.upsertJobScheduler(
        id,
        { every: scheduler.every },
        { name: scheduler.name, data: scheduler.template?.data, opts: scheduler.template?.opts },
      )
      const registered = ({ name, every, template }) => ({ name, every, template })
      assert.deepEqual(
        registered((await queue.getJobScheduler(id)) ?? {}),
        registered(scheduler),
        `The scheduler ${id} is not back as core registered it`,
      )
      paused.delete(job)
    },
    /** Whatever a scenario left paused — it failed, or forgot — runs again. */
    async resumeAll() {
      for (const job of [...paused.keys()]) await schedulers.resume(job)
    },
  }

  /**
   * A node process of the private copy, run from apps/core with the environment it is
   * given and nothing else; `input` is written to its stdin. `{ code, stdout, stderr }`.
   */
  const inCopy = async (args, { env, input }) => {
    const child = spawn(process.execPath, args, {
      cwd: join(copy, 'apps/core'),
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const out = { stdout: '', stderr: '' }
    child.stdout.on('data', (chunk) => (out.stdout += chunk))
    child.stderr.on('data', (chunk) => (out.stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    const stop = () => child.kill('SIGKILL')
    controller.signal.addEventListener('abort', stop, { once: true })
    const closed = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', done)
    })
    if (input !== undefined) {
      // A child that died before it read: its exit code and stderr are what is reported.
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
    const code = await closed
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', stop)
    return { code, ...out }
  }

  const cores = [core]
  // The processes whose end ends the run: a scenario cannot go on without any of them.
  const watch = [web, core]
  const stand = {
    signal: controller.signal,
    webUrl,
    coreUrl: `http://127.0.0.1:${ports.core}`,
    fake,
    db,
    shop: { shopId: SHOP_ID, secretKey: secrets.shopKey },
    /**
     * The files of the site a customer adds, as the wizard asks for them, and how many times
     * anyone has tried to log in to that server so far.
     */
    site: {
      host: siteServer.host,
      port: siteServer.port,
      hostKey: siteServer.hostKey,
      username: SITE_USER,
      password: secrets.sitePassword,
      rootPath: SITE_ROOT,
      logins: () => siteServer.authAttempts.length,
    },
    /** The current version of a secret in the Vault of web, by its path; null for none. */
    vaultVersion: (path) => kvVersion({ address: vaultAddress, token: secrets.vaultRoot }, path),
    metricsToken: secrets.metrics,
    /** Every letter the mailers of the core processes logged so far, in the order of each log. */
    letters: () => cores.flatMap((service) => lettersOf(service.log())),
    webLog: () => web.log(),
    schedulers,
    /** A scenario begins: a failure reports what the services said from here on. */
    scenarioBegins({ id }) {
      owned.scenario = {
        id,
        marks: new Map(owned.services.map((service) => [service, service.mark()])),
      }
    },
    /**
     * How many passes of each kind the core processes have finished that started after
     * `since`: the jobs BullMQ keeps as completed, by their own clock.
     */
    async finishedPasses(since) {
      const counts = {}
      for (const job of await queue.getJobs(['completed'], 0, 399, false))
        if (job && job.processedOn > since && job.finishedOn)
          counts[job.name] = (counts[job.name] ?? 0) + 1
      return counts
    },
    /** An operator's command, run as its header says: from apps/core, explicit environment. */
    operator: (script, args) =>
      inCopy([`scripts/${script}.mjs`, ...args], { env: operatorEnvironment(shared) }),
    /**
     * A file an operator's command is given by its path — the rates of `billing:rates` —,
     * written into the directory of the run and removed with it.
     */
    async operatorFile(name, value) {
      const path = join(directory, 'tmp', name)
      await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
      return path
    },
    /**
     * Letters as their readers get them: `[{ type, payload }]` — rows of the mirror of the
     * outbox — go through the notifications catalogue, the mailer and the templates of the
     * copy (LETTER_READER); `[{ to, subject, text }]` comes back, in the same order.
     */
    async letterTexts(rows) {
      if (rows.length === 0) return []
      const read = await inCopy(['--input-type=module', '-e', LETTER_READER], {
        env: letterReaderEnvironment(shared),
        input: JSON.stringify(rows),
      })
      assert.equal(read.code, 0, `The reader of letters failed: ${read.stderr.slice(0, 2_000)}`)
      return JSON.parse(read.stdout)
    },
    /** A second core process on the same database and Redis, until `stop()`. */
    async secondCore() {
      const second = await startCore('core-2', ports.secondCore)
      owned.secondCore = second
      cores.push(second)
      // Watched while it runs: if it dies, the scenario fails at once, not at its deadline.
      watch.push(second)
      await coreReady(second, ports.secondCore)
      return {
        url: `http://127.0.0.1:${ports.secondCore}`,
        async stop() {
          await second.stop()
          watch.splice(watch.indexOf(second), 1)
          owned.secondCore = undefined
        },
      }
    },
  }

  stage = 'scenarios'
  const selected = SCENARIOS.filter(({ id }) => options.only === null || options.only.includes(id))
  let failure
  try {
    const result = await runScenarios(stand, selected, {
      alive() {
        const gone = watch.find((service) => !service.running() && !service.stopping())
        if (gone) throw new Error(`${gone.name} exited during the scenarios`)
      },
    })
    console.log(
      `PASS billing stand: ${result.scenarios} of ${SCENARIOS.length} scenarios, ${result.checks} checks, ` +
        `${Math.round(result.ms / 1000)} s`,
    )
  } catch (error) {
    failure = error
    if (!controller.signal.aborted) reportLogs(owned)
  }

  if (options.keep && !controller.signal.aborted) {
    console.log(
      [
        '',
        failure
          ? 'The stand stays up (--keep) as the failed scenario left it; core goes on ticking.'
          : 'The stand stays up (--keep).',
        'Everything is on loopback and belongs to this run:',
        `  web            ${webUrl}  (sign-up form, settings; letters are in the log of core)`,
        `  core           http://127.0.0.1:${ports.core}/health`,
        `  fake ЮKassa    ${fake.controlUrl}/state  and  ${fake.controlUrl}/requests`,
        `  site (SFTP)    127.0.0.1:${siteServer.port}, folder ${SITE_ROOT}, user ${SITE_USER}; host key ${siteServer.hostKey}`,
        `  database       docker exec -it ${postgres} psql -U raditi raditi`,
        `  logs           ${join(directory, 'logs')}`,
        `Stop it with Ctrl-C (or kill -TERM ${process.pid}): the containers, the processes and the`,
        'run directory are then removed as after any run.',
        '',
      ].join('\n'),
    )
    await new Promise((done) => controller.signal.addEventListener('abort', done, { once: true }))
  }
  if (failure) throw failure
}

/** Removes what the run owns, in CLEANUP_ORDER; a step that fails does not stop the others. */
async function cleanup(owned) {
  const container = async (service) => {
    if (!owned.containers) return
    const name = containerName(runId, service)
    const label = await docker(
      ['inspect', name, '--format', `{{index .Config.Labels "${STAND_LABEL}"}}`],
      { cleanup: true, allowFailure: true },
    )
    if (label.code !== 0) {
      assert.match(label.output, /No such (object|container)/, 'Could not inspect the container')
      return
    }
    // The name is random and the label names this run: never a container of another session.
    assert.equal(label.output, runId, 'The container does not carry the label of this run')
    await docker(['rm', '-fv', name], { cleanup: true })
  }
  const steps = {
    'second core': () => owned.secondCore?.stop(),
    core: () => owned.core?.stop(),
    web: () => owned.web?.stop(),
    fake: () => owned.fake?.close(),
    'site server': () => owned.siteServer?.close(),
    'database client': () => owned.db?.end(),
    'queue client': () => owned.queue?.close(),
    'vault container': () => container('vault'),
    'redis container': () => container('redis'),
    'postgres container': () => container('postgres'),
    'logs of a failed run': async () => {
      if (owned.keepLogs && owned.directory) owned.logs = await keepLogs(owned)
    },
    'run directory': () =>
      owned.directory ? rm(owned.directory, { recursive: true, force: true }) : undefined,
    'build lock': () => (owned.lock ? rm(owned.lock, { recursive: true, force: true }) : undefined),
  }
  assert.deepEqual(Object.keys(steps), [...CLEANUP_ORDER])
  const failed = []
  for (const name of CLEANUP_ORDER) {
    try {
      await steps[name]()
    } catch {
      failed.push(name)
    }
  }
  if (owned.containers) {
    const left = await docker(['ps', '-aq', '--filter', `label=${STAND_LABEL}=${runId}`], {
      cleanup: true,
      allowFailure: true,
    })
    if (left.code !== 0 || left.output !== '') failed.push('containers of the run')
  }
  for (const service of owned.services ?? [])
    if (service.running()) failed.push(`process ${service.name}`)
  return failed
}

export async function verifyBilling(argv) {
  const started = Date.now()
  // Kept until the cleanup has ended, not `once`: with no listener left a repeated signal would
  // end the process in the middle of the cleanup and leave containers behind.
  for (const signal of SIGNALS) process.on(signal, interrupt)
  process.stdout.on('error', outputGone)
  process.stderr.on('error', outputGone)
  const owned = {}
  let failed = false
  try {
    await main(standOptions(argv), owned)
  } catch (error) {
    failed = true
    // A failure that was reported before the stand was interrupted (--keep) stays the reason.
    const interrupted = controller.signal.aborted && !owned.reported
    if (!controller.signal.aborted) reportLogs(owned)
    // An interrupt explains itself; any other failure is read from the logs.
    owned.keepLogs = !interrupted
    console.error(
      `FAIL billing stand at ${stage}: ${interrupted ? 'interrupted' : redact(error?.message ?? 'unknown')}`,
    )
  } finally {
    stage = 'cleanup'
    const left = await cleanup(owned)
    if (left.length === 0) {
      if (owned.containers) passed('owned containers, processes and the run directory removed')
    } else {
      failed = true
      console.error(`FAIL cleanup of the billing stand: ${left.join(', ')}`)
    }
    for (const signal of SIGNALS) process.removeListener(signal, interrupt)
  }
  if (owned.logs) console.error(`LOGS of the failed run, whole (web, core): ${owned.logs}`)
  console.log(
    `${failed ? 'FAIL' : 'PASS'} pnpm verify:billing in ${Math.round((Date.now() - started) / 1000)} s` +
      (owned.staleCopy
        ? ' — ON A STALE COPY (BILLING_VERIFY_STALE_COPY=allow): no proof for the tree'
        : ''),
  )
  if (failed) throw new Error('Billing verification failed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyBilling(process.argv.slice(2)).catch(() => {
    process.exitCode = 1
  })
}
