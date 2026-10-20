// Pure parts of the billing stand (verify-billing.mjs): what its containers, its builds and its
// processes are given, how a build copy is told from the tree it was made of, what a run leaves
// on record and what of a dead run is swept, the list of scenarios, the order of the cleanup,
// and the small readers the scenarios share. Nothing here touches Docker, the network or a file.
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The PostgreSQL and Redis of infra/app and of the other stands, by digest. Never pulled. */
export const POSTGRES_IMAGE =
  'postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
export const REDIS_IMAGE =
  'redis:8.10.2-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0'
/** OpenBao of infra/dev, infra/vault and the other stands, by digest: the Vault web writes to. */
export const OPENBAO_IMAGE =
  'ghcr.io/openbao/openbao:2.7.0@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315'

/** Every container of a run carries `io.raditi.billing-verify=<run>`. */
export const STAND_LABEL = 'io.raditi.billing-verify'
const RUN = /^[0-9a-f]{8}$/
const SERVICES = ['postgres', 'redis', 'vault']

/** The scheduler of core runs every pass this often: the lower bound of BILLING_TICK_SECONDS. */
export const TICK_SECONDS = 1
/** The defaults of the product, set explicitly: the scenarios count days by them. */
export const RENEWAL_NOTICE_DAYS = 3
export const PAST_DUE_DAYS = 7
/** The shop of the fake: digits only, as ЮKassa numbers its shops. No real shop exists. */
export const SHOP_ID = '100500'

/**
 * The site every customer of the stand adds: a synthetic WordPress on the stand's own SFTP server
 * (the test server of @repo/site-connections, in the process of the stand, on loopback), in this
 * folder and behind a password of the run. It holds what the check of «Доступ к файлам» reads —
 * the two markers of the platform and a small file — and nothing of anyone.
 */
export const SITE_ROOT = '/var/www/kofeynya'
export const SITE_USER = 'kofeynya'
export const SITE_FILES = Object.freeze({
  [`${SITE_ROOT}/index.php`]:
    "<?php\n// A synthetic WordPress of the billing stand.\nrequire __DIR__ . '/wp-blog-header.php';\n",
  [`${SITE_ROOT}/wp-includes/version.php`]: "<?php\n$wp_version = '6.8.3';\n",
  [`${SITE_ROOT}/wp-content/index.php`]: '<?php\n// Silence is golden.\n',
})

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * `--no-build` reuses the builds of the private copy, which must have been made of the tree as
 * it is now; `--keep` leaves the stand up after the scenarios until it is interrupted;
 * `--only a,b` runs the named scenarios alone. Nothing names a database, a shop or an address:
 * the stand never works on anything it did not start itself.
 */
export function standOptions(argv) {
  const options = { build: true, keep: false, only: null }
  const args = argv.filter((arg) => arg !== '--')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-build') options.build = false
    else if (arg === '--keep') options.keep = true
    else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? args[(index += 1)] : arg.slice('--only='.length)
      const ids = (value ?? '').split(',').filter(Boolean)
      const unknown = ids.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id))
      if (ids.length === 0 || unknown.length > 0)
        throw new Error(
          `--only takes scenario ids separated by commas: ${SCENARIOS.map(({ id }) => id).join(', ')}`,
        )
      options.only = ids
    } else
      throw new Error(
        'This stand accepts --no-build, --keep and --only <scenarios>; it takes no database, shop or address',
      )
  }
  return options
}

// ─── Containers ───────────────────────────────────────────────────────────────

/** `raditi-billing-verify-<run>-<service>`: no other session on the machine owns such a name. */
export function containerName(run, service) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id')
  if (!SERVICES.includes(service)) throw new Error('Unknown service of the stand')
  return `raditi-billing-verify-${run}-${service}`
}

const containerArgs = (run, service) => [
  ...['run', '-d', '--pull=never', '--name', containerName(run, service)],
  ...['--label', `${STAND_LABEL}=${run}`],
]

function envFileOf(envFile) {
  if (typeof envFile !== 'string' || !isAbsolute(envFile))
    throw new Error('The env file of a container is an absolute path')
  return envFile
}

/**
 * `docker run` of the stand's PostgreSQL: data in memory, a random port on loopback, the one
 * application user of the platform (`raditi`, owner of the database). The password comes from
 * an env file of the run directory: it is never an argument of a process.
 */
export function postgresContainerArgs({ run, envFile }) {
  return [
    ...containerArgs(run, 'postgres'),
    ...['--tmpfs', '/var/lib/postgresql/data:rw'],
    ...['-p', '127.0.0.1::5432', '--env-file', envFileOf(envFile)],
    POSTGRES_IMAGE,
  ]
}

/** What the env file of the PostgreSQL container holds. */
export const postgresEnvFile = (password) =>
  `POSTGRES_USER=raditi\nPOSTGRES_DB=raditi\nPOSTGRES_PASSWORD=${password}\n`

/**
 * `docker run` of the stand's Redis for BullMQ: nothing on disk, keys never evicted (as in
 * infra/dev and infra/app), a random port on loopback. The password is read from the
 * environment of the container by its shell.
 */
export function redisContainerArgs({ run, envFile }) {
  return [
    ...containerArgs(run, 'redis'),
    ...['-p', '127.0.0.1::6379', '--env-file', envFileOf(envFile)],
    REDIS_IMAGE,
    ...['sh', '-c'],
    'exec redis-server --save "" --appendonly no --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"',
  ]
}

export const redisEnvFile = (password) => `REDIS_PASSWORD=${password}\n`

/**
 * `docker run` of the stand's OpenBao, the Vault web writes the access of a new site to: dev
 * mode, data in memory, a random port on loopback. The root token comes from an env file of the
 * run, as the passwords above.
 */
export function vaultContainerArgs({ run, envFile }) {
  return [
    ...containerArgs(run, 'vault'),
    ...['-p', '127.0.0.1::8200', '--env-file', envFileOf(envFile)],
    OPENBAO_IMAGE,
  ]
}

/** What the env file of the OpenBao container holds: the root token and the listener of dev mode. */
export const vaultEnvFile = (rootToken) =>
  `BAO_DEV_ROOT_TOKEN_ID=${rootToken}\nBAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200\n`

/** The loopback port Docker published, from the output of `docker port`. */
export function publishedPort(output) {
  const [, port] = /^127\.0\.0\.1:(\d+)$/.exec(output.trim()) ?? []
  if (!port) throw new Error('The container is not published on loopback only')
  return Number(port)
}

// ─── The private copy and its builds ──────────────────────────────────────────

/**
 * The directory that marks a directory as a build copy of this stand; it holds the manifest of
 * the copy and the stamp of its last finished build.
 */
export const COPY_MARKER = '.raditi-billing-verify'
/** The stamp of a finished build, inside COPY_MARKER: when, and of which tree. */
export const BUILD_STAMP = 'built'

/** Whether `directory` is neither `root` nor anywhere below it. */
export function outside(root, directory) {
  const path = relative(root, directory)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

/** A directory the stand writes to: an absolute path outside the repository. */
function ownDirectory(name, given, root) {
  if (!isAbsolute(given)) throw new Error(`${name} must be an absolute path`)
  // No trailing separator: the lock of the copy lies beside the directory, not in it.
  const directory = resolve(given)
  // `next build` under the tree would be watched by another session's `next dev`, and the
  // next listing of the tree would hold the copy itself.
  if (!outside(root, directory)) throw new Error(`${name} must be outside the repository`)
  return directory
}

/**
 * Where web and core are built: a copy of the tree outside the repository, kept between runs
 * so `--no-build` can use it. BILLING_VERIFY_BUILD_DIR moves it (an absolute path that is not
 * inside the repository).
 */
export function buildDirectory(env, tmp, root) {
  const given = env.BILLING_VERIFY_BUILD_DIR
  return ownDirectory(
    'BILLING_VERIFY_BUILD_DIR',
    given === undefined || given === '' ? join(tmp, 'raditi-billing-verify-build') : given,
    root,
  )
}

/**
 * Where the logs of web and core go when a run has failed: the run directory is removed, the
 * logs are what explains the failure. BILLING_VERIFY_LOG_DIR moves them (CI uploads that
 * directory).
 */
export function logDirectory(env, tmp, run, root) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id')
  const given = env.BILLING_VERIFY_LOG_DIR
  return ownDirectory(
    'BILLING_VERIFY_LOG_DIR',
    given === undefined || given === '' ? join(tmp, `raditi-billing-verify-logs-${run}`) : given,
    root,
  )
}

/**
 * BILLING_VERIFY_STALE_COPY=allow lets `--no-build` run on a copy that is not the tree. For
 * mutation checks of the stand itself, where the copy is broken on purpose: such a run proves
 * nothing about the tree. Any other value is refused, and so is the variable without
 * `--no-build`: a run that builds brings the copy to the tree anyway.
 */
export function staleCopyAllowed(env, options) {
  const given = env.BILLING_VERIFY_STALE_COPY
  if (given === undefined || given === '') return false
  if (given !== 'allow')
    throw new Error('BILLING_VERIFY_STALE_COPY takes one value, `allow`, or is left unset')
  if (options.build)
    throw new Error(
      'BILLING_VERIFY_STALE_COPY=allow goes with --no-build only: a run that builds copies the tree first',
    )
  return true
}

/** A path of `git ls-files`: relative, inside the tree, nothing of git or of the copy itself. */
export function copyablePath(path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return false
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  return parts[0] !== '.git' && parts[0] !== COPY_MARKER
}

/**
 * Files the previous copy of the tree held and the tree no longer has: a page or a module that
 * was deleted must not stay in the copy and be built. Build output and dependencies are not in
 * any manifest, so they are never listed here.
 */
export function staleFiles(previous, current) {
  const kept = new Set(current)
  return previous.filter((path) => copyablePath(path) && !kept.has(path))
}

/**
 * What the manifest holds while the tree is being copied: everything the copy held before and
 * everything this run may put there. A run that dies in the middle then leaves a manifest that
 * names every file it copied, and the next run removes what the tree has lost since.
 */
export const manifestDuringCopy = (previous, current) => [
  ...new Set([...previous.filter(copyablePath), ...current]),
]

/** One file of the tree as a build knows it: its path, its size and when it was written. */
export const treeEntry = (path, { size, mtimeMs }) => `${path}\0${size}\0${mtimeMs}`

/** sha256 over the sorted entries of a tree: two listings with one digest are one tree. */
export function treeDigest(entries) {
  return createHash('sha256')
    .update([...entries].sort().join('\n'))
    .digest('hex')
}

/** The text of the stamp a finished build leaves: the moment, and the tree it was made of. */
export function buildStamp({ builtAt, entries }) {
  const sorted = [...entries].sort()
  return `${JSON.stringify({ builtAt, digest: treeDigest(sorted), entries: sorted })}\n`
}

/** A stamp as `buildStamp` wrote it; null for anything else — no stamp, a torn or edited one. */
export function readBuildStamp(text) {
  let stamp
  try {
    stamp = JSON.parse(text)
  } catch {
    return null
  }
  const { builtAt, digest, entries } = stamp ?? {}
  if (
    typeof builtAt !== 'string' ||
    Number.isNaN(Date.parse(builtAt)) ||
    !Array.isArray(entries) ||
    !entries.every((entry) => typeof entry === 'string') ||
    digest !== treeDigest(entries)
  )
    return null
  return { builtAt, digest, entries }
}

/** The files that are in one listing and not, or not the same, in the other; sorted. */
export function treeChanges(built, current) {
  const pathOf = (entry) => entry.slice(0, entry.indexOf('\0'))
  const before = new Set(built)
  const after = new Set(current)
  const changed = new Set()
  for (const entry of built) if (!after.has(entry)) changed.add(pathOf(entry))
  for (const entry of current) if (!before.has(entry)) changed.add(pathOf(entry))
  return [...changed].sort()
}

/** `1 file (first: a)`, `5 files (first: a, b, c, …)`. */
const filesNamed = (paths) =>
  `${paths.length} ${paths.length === 1 ? 'file' : 'files'} ` +
  `(first: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''})`

/** An entry as a copy of the file keeps it: rsync carries the time of writing to the second. */
function copied(entry) {
  const [path, size, mtimeMs] = entry.split('\0')
  return `${path}\0${size}\0${Math.floor(Number(mtimeMs) / 1000)}`
}

/**
 * Why `--no-build` may not run on the copy, or null when the copy is a finished build of the
 * tree as it is now. The copy holds more than builds: core and the operator's commands load
 * the sources of the packages from it, and its migrations are the ones applied — so scenarios
 * of a tree that has changed since, or on a copy that was edited by hand, would pass or fail
 * on a product nobody is looking at.
 *
 * `tree`: the entries of the tree now; `held`: the entries of the same files as the copy
 * holds them now.
 */
export function staleCopy(stamp, tree, held) {
  if (stamp === null)
    return 'the copy holds no stamp of a finished build: its last build was interrupted, or it was made by an earlier version of the stand'
  if (stamp.digest !== treeDigest(tree))
    return `the tree has changed since the copy was built at ${stamp.builtAt}: ${filesNamed(treeChanges(stamp.entries, tree))}`
  const edited = treeChanges(stamp.entries.map(copied), held.map(copied))
  if (edited.length > 0)
    return `the copy itself has been changed since it was built at ${stamp.builtAt}: ${filesNamed(edited)}`
  return null
}

/**
 * The environment of a build command: nothing of the caller but PATH and HOME (pnpm keeps its
 * store under HOME). No DATABASE_URL, no shop, no address: `next build` reads nothing, and the
 * repository has no NEXT_PUBLIC_ variable, so no port of a stand can reach a bundle.
 */
export function buildEnvironment({ path, home }) {
  return { PATH: path, HOME: home, CI: '1', NEXT_TELEMETRY_DISABLED: '1' }
}

/**
 * The builds, in order, each a command run in the copy. The steps of apps/web/Dockerfile and
 * apps/core/Dockerfile without Docker: the stand needs its processes on the loopback
 * of the host, next to the fake.
 */
export const BUILD_STEPS = Object.freeze([
  {
    title: 'install dependencies',
    args: ['install', '--frozen-lockfile', '--prefer-offline'],
    env: {},
  },
  {
    title: 'generate the Prisma client',
    args: ['--filter', '@repo/db', 'db:generate'],
    // prisma.config.ts reads DATABASE_URL; generate never connects.
    env: { DATABASE_URL: 'postgresql://build@localhost/build' },
  },
  { title: 'build the orchestrator', args: ['--filter', 'core', 'build'], env: {} },
  { title: 'build web', args: ['--filter', 'web', 'build'], env: {} },
])

/** What a finished build leaves in the copy, relative to it: `--no-build` asks for all of them. */
export const BUILD_OUTPUT = Object.freeze({
  web: 'apps/web/.next/standalone/apps/web/server.js',
  webStatic: 'apps/web/.next/static',
  webStaticServed: 'apps/web/.next/standalone/apps/web/.next/static',
  core: 'apps/core/dist/main.js',
  operatorScripts: 'apps/core/scripts',
  database: 'packages/db/package.json',
})

// ─── What a run leaves on record, and what is swept after a run that died ─────

const RUN_DIRECTORY_PREFIX = 'raditi-billing-verify-run-'
/** Where a run directory is made before it gets its name: it appears with its record in it. */
export const RUN_STAGING_PREFIX = 'raditi-billing-verify-new-'
/** The record of a run, in its run directory. */
export const RUN_RECORD = 'run.json'

/** `raditi-billing-verify-run-<run>` under the temporary directory: env files, logs, the record. */
export function runDirectoryName(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id')
  return `${RUN_DIRECTORY_PREFIX}${run}`
}

/** Whether a name under the temporary directory is a run directory of the stand, named or not yet. */
export const isRunDirectory = (name) =>
  typeof name === 'string' &&
  (name.startsWith(RUN_DIRECTORY_PREFIX) || name.startsWith(RUN_STAGING_PREFIX))

const pidOf = (value) => (Number.isInteger(value) && value > 1 ? value : null)

/**
 * The text of a run's record: its id, which labels its containers; the process of the stand;
 * the build copy its processes run in; and the processes it has started, by name. Written
 * before anything else exists, so that a run killed outright — SIGKILL, a machine that went
 * down — can be told from a live one and cleaned up by the next (`sweepOf`).
 */
export function runRecord({ run, pid, copy, services = [] }) {
  runDirectoryName(run)
  if (pidOf(pid) === null) throw new Error('Invalid pid of the stand')
  if (typeof copy !== 'string' || !isAbsolute(copy)) throw new Error('Invalid build copy')
  for (const service of services)
    if (typeof service.name !== 'string' || pidOf(service.pid) === null)
      throw new Error('Invalid process of the stand')
  return `${JSON.stringify({ run, pid, copy, services: services.map(({ name, pid }) => ({ name, pid })) })}\n`
}

/**
 * A record as `runRecord` wrote it, read from the directory `name`; null for anything else. A
 * named run directory must hold the record of that very run: a record copied from elsewhere
 * says nothing of it.
 */
export function readRunRecord(name, text) {
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  const { run, pid, copy, services } = record ?? {}
  if (typeof run !== 'string' || !RUN.test(run) || pidOf(pid) === null) return null
  if (typeof copy !== 'string' || !isAbsolute(copy) || !Array.isArray(services)) return null
  if (
    !services.every((service) => typeof service?.name === 'string' && pidOf(service.pid) !== null)
  )
    return null
  if (!isRunDirectory(name)) return null
  if (name.startsWith(RUN_DIRECTORY_PREFIX) && name !== runDirectoryName(run)) return null
  return { run, pid, copy, services: services.map(({ name, pid }) => ({ name, pid })) }
}

/**
 * What the sweep removes for one recorded run, or null when the run is none of its business:
 * this run itself, or one whose stand is alive (two runs with build copies of their own may go
 * at once; `--keep` holds one up for hours).
 *
 * Of a dead run: the containers that carry its id in the label of the stand — never one found
 * by a name or labelled for another run; the processes it recorded that are still alive AND
 * whose working directory lies in its build copy — a pid that was given to someone else since
 * (another session's `next dev` has the same process name, and never that directory) is left
 * alone; its run directory; and the lock of the copy when it still names the dead stand.
 *
 * `alive(pid)`; `cwds`: pid → working directory, both sides resolved through symlinks, for the
 * recorded pids that are alive; `copy`: the resolved build copy of the record, null when it is
 * gone; `containers`: `[{ name, run }]` as Docker lists them by the label; `lockPid`: the pid
 * in the lock of that copy, null when there is none.
 */
export function sweepOf(record, { self, alive, cwds, copy, containers, lockPid }) {
  if (record.run === self || alive(record.pid)) return null
  return {
    run: record.run,
    pid: record.pid,
    containers: containers.filter(({ run }) => run === record.run).map(({ name }) => name),
    processes: record.services.filter(({ pid }) => {
      const cwd = cwds.get(pid)
      return alive(pid) && copy !== null && typeof cwd === 'string' && !outside(copy, cwd)
    }),
    lock: lockPid === record.pid,
  }
}

/** The line a swept run is reported with. */
export function sweepLine({ run, pid, containers, processes, lock }) {
  const parts = [
    ...(containers.length > 0 ? [`containers ${containers.join(', ')}`] : []),
    ...(processes.length > 0
      ? [
          `processes ${processes.map((service) => `${service.name} (pid ${service.pid})`).join(', ')}`,
        ]
      : []),
    'its run directory',
    ...(lock ? ['its lock of the build copy'] : []),
  ]
  return `SWEPT run ${run}, whose stand (pid ${pid}) is gone without cleaning up: ${parts.join('; ')}`
}

// ─── Processes ────────────────────────────────────────────────────────────────

const origin = (port) => {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Invalid port')
  return `http://127.0.0.1:${port}`
}

/** A synthetic HOME and TMPDIR of the run: no process of the stand can find real credentials. */
const sandboxed = ({ path, directory }) => ({
  PATH: path,
  HOME: `${directory}/home`,
  TMPDIR: `${directory}/tmp`,
})

const shopOf = ({ secrets, fakeApiUrl }) => ({
  YOOKASSA_SHOP_ID: SHOP_ID,
  YOOKASSA_SECRET_KEY: secrets.shopKey,
  YOOKASSA_API_URL: fakeApiUrl,
})

/**
 * The whole environment of web (the standalone server of `next build`). Vault is the stand's
 * OpenBao, and web logs in to it by the AppRole `sites-writer`: «Добавить проект» writes the
 * access of a new site there before it creates the site. Redis and S3 are left out: only
 * /api/health and the avatar routes read them. NODE_ENV is what the standalone server sets
 * anyway; APP_ENV is not production, so the fake's address, the loopback senders and a site on
 * loopback are accepted.
 */
export function webEnvironment({
  path,
  directory,
  ports,
  databaseUrl,
  fakeApiUrl,
  secrets,
  vault,
}) {
  return {
    ...sandboxed({ path, directory }),
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1',
    PORT: String(ports.web),
    APP_ENV: 'test',
    APP_URL: origin(ports.web),
    BETTER_AUTH_URL: origin(ports.web),
    BETTER_AUTH_SECRET: secrets.auth,
    DATABASE_URL: databaseUrl,
    METRICS_TOKEN: secrets.metrics,
    ...shopOf({ secrets, fakeApiUrl }),
    // The fake names 127.0.0.1 in X-Forwarded-For; for a sender without the header Next puts
    // the address of the connection there, 127.0.0.1 or ::1.
    YOOKASSA_WEBHOOK_ALLOWLIST: '127.0.0.1,::1',
    BILLING_PAST_DUE_DAYS: String(PAST_DUE_DAYS),
    VAULT_ADDR: vault.address,
    VAULT_ROLE_ID: vault.roleId,
    VAULT_SECRET_ID: vault.secretId,
  }
}

/**
 * The whole environment of a `core` process. PostgreSQL and Redis are the stand's own. S3 and
 * Vault are throwaway values: core parses both sections at start and connects to neither
 * until a turn or a health check asks, and no turn runs here. They name the discard port of
 * loopback, where nothing listens. The first import of a new site does not reach Vault either:
 * without git (no GITEA_*) it ends `repository_not_configured` before it reads the access.
 * NODE_ENV=production keeps core from looking for a `.env`.
 */
export function coreEnvironment({
  path,
  directory,
  ports,
  port,
  databaseUrl,
  redisUrl,
  fakeApiUrl,
  secrets,
}) {
  return {
    ...sandboxed({ path, directory }),
    NODE_ENV: 'production',
    NO_COLOR: '1',
    APP_ENV: 'test',
    APP_URL: origin(ports.web),
    CORE_PORT: String(port),
    // core's own Docker would run turns; none is started, and Docker is not asked at start.
    TURN_EXECUTOR: 'local',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    METRICS_TOKEN: secrets.metrics,
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_ACCESS_KEY_ID: 'billing-verify-unused',
    S3_SECRET_ACCESS_KEY: secrets.unused,
    VAULT_ADDR: 'http://127.0.0.1:9',
    VAULT_DEV_ROOT_TOKEN: secrets.unused,
    ...shopOf({ secrets, fakeApiUrl }),
    BILLING_TICK_SECONDS: String(TICK_SECONDS),
    BILLING_RENEWAL_NOTICE_DAYS: String(RENEWAL_NOTICE_DAYS),
    BILLING_PAST_DUE_DAYS: String(PAST_DUE_DAYS),
  }
}

/**
 * The environment of an operator command (apps/core/scripts/billing-*.mjs), as its
 * header asks for it: what core reads for the same things, given explicitly.
 */
export function operatorEnvironment({ path, directory, ports, databaseUrl, fakeApiUrl, secrets }) {
  return {
    ...sandboxed({ path, directory }),
    APP_ENV: 'test',
    APP_URL: origin(ports.web),
    DATABASE_URL: databaseUrl,
    ...shopOf({ secrets, fakeApiUrl }),
  }
}

/** The environment of `prisma migrate deploy` and of the seed in the copy. */
export function databaseEnvironment({ path, home, databaseUrl }) {
  return { PATH: path, HOME: home, CI: '1', DATABASE_URL: databaseUrl }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * What a run removes, in this order: whoever writes to the database or calls the fake stops
 * first, the fake after the last notification could be sent, the SFTP server of the site after
 * web, which checks the files there, the containers after everything that held a connection to
 * them, the files and the lock of the copy last. The logs of a run that failed are kept aside
 * before its directory goes.
 */
export const CLEANUP_ORDER = Object.freeze([
  'second core',
  'core',
  'web',
  'fake',
  'site server',
  'database client',
  'queue client',
  'vault container',
  'redis container',
  'postgres container',
  'logs of a failed run',
  'run directory',
  'build lock',
])

// ─── Scenarios ────────────────────────────────────────────────────────────────

/**
 * Scenarios the plan's table does not name: reviews found defects there, and the last one is
 * what a real shop did on its first day (AnyNote; docs/plan/51-yookassa-shop-setup.md).
 */
export const EXTRA_ROWS = Object.freeze([
  'Отвязка карты, когда списание уже в банке',
  'Списание без ответа, затем отвязка',
  'Два платежа за одну подписку',
  'Магазин без одобренных автоплатежей',
])

/**
 * Every scenario of the stand: `row` is the row of the table «Проверочный стенд» of
 * docs/plan/37-billing-plan.md it proves (stand.test.mjs compares with the document), or one
 * of EXTRA_ROWS. The order is the order of the run.
 */
export const SCENARIOS = Object.freeze([
  {
    id: 'signup-gift',
    row: 'Подарок: регистрация, первый сайт, оплата тарифа',
    title:
      'the gift of the registration: promised, granted with the first site, kept beside a tariff',
  },
  {
    id: 'credit-rate',
    row: 'Курс кредита: команда оператора',
    title: 'the operator approves the credit rate: tasks are taken from then on, never before',
  },
  {
    id: 'checkout',
    row: 'Оплата тарифа с автопродлением и без',
    title: 'a tariff is paid with the consent to auto-renewal and without it',
  },
  {
    id: 'saved-without-consent',
    row: 'Платёж без согласия, ЮKassa вернула `saved: true`',
    title: 'the shop saved a method nobody agreed to: it is not stored',
  },
  {
    id: 'webhook-and-return',
    row: 'Вебхук и страница возврата одновременно',
    title: 'the notification and the return page settle one order at once',
  },
  {
    id: 'webhook-lost',
    row: 'Вебхук потерян',
    title: 'a lost notification: the return page, then the pass of stuck orders',
  },
  {
    id: 'webhook-forged',
    row: 'Вебхук с адресом вне списка и с поддельным телом',
    title: 'a foreign sender and a forged body change nothing',
  },
  {
    id: 'pack-and-period-end',
    row: 'Покупка пакета, затем конец периода',
    title: 'a pack is bought, the period ends: the tariff rest expires, the pack stays',
  },
  {
    id: 'renewal-success',
    row: 'Продление: успех, отказ банка, ответ 500, зависший `pending`',
    title: 'a renewal: the notice, one charge, the period moved once',
  },
  {
    id: 'renewal-declined',
    row: 'Продление: успех, отказ банка, ответ 500, зависший `pending`',
    title: 'the bank declines the charge: past due, then paid by hand; the shop refuses another',
  },
  {
    id: 'renewal-http-500',
    row: 'Продление: успех, отказ банка, ответ 500, зависший `pending`',
    title: 'the answer of a charge is lost: the repeat under the same key charges nothing twice',
  },
  {
    id: 'renewal-stuck-pending',
    row: 'Продление: успех, отказ банка, ответ 500, зависший `pending`',
    title: 'a charge that hangs at the bank, and one that is given up once its key is too old',
  },
  {
    id: 'renewal-waits-for-notice',
    row: 'Продление: успех, отказ банка, ответ 500, зависший `pending`',
    title: 'while no notice can be written nothing is charged; the charge follows its notice',
  },
  {
    id: 'renewal-in-real-time',
    row: 'Продление: успех, отказ банка, ответ 500, зависший `pending`',
    title:
      'the period ends by itself: charged on the notice written ahead; a new price is announced first',
  },
  {
    id: 'two-ticks',
    row: 'Два тика планировщика одновременно',
    title: 'two core processes run the same passes at once: one renewal order per tariff',
  },
  {
    id: 'plan-change',
    row: 'Смена тарифа и её отмена',
    title: 'another tariff from the next period, and a change taken back',
  },
  {
    id: 'auto-renewal',
    row: 'Отключение и включение автопродления',
    title: 'auto-renewal off, on with the saved card and on through a binding',
  },
  {
    id: 'auto-renewal-without-consent',
    row: 'Отключение и включение автопродления',
    title:
      'a new edition of the documents is not accepted: charged all the same, stopped all the same',
  },
  {
    id: 'payment-method',
    row: 'Замена и отвязка способа оплаты',
    title: 'the card is replaced once and charged; after an unlink nothing is charged',
  },
  {
    id: 'past-due-expires',
    row: 'Просрочка дольше срока',
    title: 'an overdue tariff expires after the grace; purchased credits stay',
  },
  {
    id: 'refund',
    row: 'Возврат (M5.16)',
    title: 'the operator refunds a tariff and a pack: once, whatever is repeated',
  },
  {
    id: 'refund-in-cabinet',
    row: 'Возврат (M5.16)',
    title: 'money returned in the cabinet of the shop: no second refund on top of it',
  },
  {
    id: 'unlink-at-bank',
    row: EXTRA_ROWS[0],
    title: 'the card is unlinked while the renewal charge is at the bank',
  },
  {
    id: 'unanswered-then-unlink',
    row: EXTRA_ROWS[1],
    title: 'a charge without an answer, then an unlink: the notification, or the operator',
  },
  {
    id: 'double-payment',
    row: EXTRA_ROWS[2],
    title: 'two pages are paid for one tariff: the second payment waits for a refund',
  },
  {
    id: 'autopayments-not-approved',
    row: EXTRA_ROWS[3],
    title:
      'the shop has no right to autopayments: the tick is refused, the tariff is sold without it',
  },
])

// ─── Readers the scenarios share ──────────────────────────────────────────────

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

/**
 * The end of the monthly period that starts at `from`, by the rule of the plan (default «в»):
 * the day of month and the time of day of `anchor` by the Moscow calendar, in the month after
 * the one `from` is in; a shorter month takes its last day. Written here on its own, from the
 * rule and not from the code of the product: it is what the scenarios compare the product with.
 * Moscow has kept UTC+3 without daylight saving since 2014.
 */
export function moscowMonthLater(anchor, from) {
  const local = (date) => new Date(date.getTime() + MOSCOW_OFFSET_MS)
  const a = local(anchor)
  const f = local(from)
  const year = f.getUTCFullYear()
  const month = f.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(a.getUTCDate(), lastDay)
  const wall = Date.UTC(
    year,
    month,
    day,
    a.getUTCHours(),
    a.getUTCMinutes(),
    a.getUTCSeconds(),
    a.getUTCMilliseconds(),
  )
  return new Date(wall - MOSCOW_OFFSET_MS)
}

/**
 * The dates of a subscription whose current period ends at `end`: how a scenario moves time.
 * The product refuses a period end that is not a whole number of months from the anchor, so
 * the three dates are written together: the anchor is the same Moscow day and time one month
 * earlier, or further back while the months before are too short to hold that day (31 March is
 * two months after 31 January: no 31 February exists), and the period starts one month before
 * its end by that anchor.
 */
export function periodEndingAt(end) {
  const local = new Date(end.getTime() + MOSCOW_OFFSET_MS)
  const day = local.getUTCDate()
  for (let months = 1; months <= 12; months += 1) {
    const year = local.getUTCFullYear()
    const month = local.getUTCMonth() - months
    if (new Date(Date.UTC(year, month + 1, 0)).getUTCDate() < day) continue
    const anchor = new Date(
      Date.UTC(
        year,
        month,
        day,
        local.getUTCHours(),
        local.getUTCMinutes(),
        local.getUTCSeconds(),
        local.getUTCMilliseconds(),
      ) - MOSCOW_OFFSET_MS,
    )
    let start = anchor
    for (let passed = 1; passed < months; passed += 1) start = moscowMonthLater(anchor, start)
    return { anchor, start, end: new Date(end.getTime()) }
  }
  throw new Error('No month holds this day')
}

/** The address of a tRPC query: superjson input in `?input=`, nothing for a query without one. */
export function trpcQueryUrl(base, path, input) {
  const url = `${base}/api/trpc/${path}`
  return input === undefined
    ? url
    : `${url}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
}

/** What a tRPC answer over HTTP says: the data of a success, or the refusal with its codes. */
export function trpcOutcome(status, body) {
  const data = body?.result?.data
  if (status === 200 && data !== undefined && 'json' in data)
    return { ok: true, status, data: data.json }
  const error = body?.error?.json
  return {
    ok: false,
    status,
    code: error?.data?.code ?? null,
    domainCode: error?.data?.domainCode ?? null,
    message: error?.message ?? null,
  }
}

/** `name=value` pairs of Set-Cookie headers as a Cookie header; a deleted cookie is left out. */
export function cookieHeader(setCookies, previous = '') {
  const jar = new Map(
    previous
      .split('; ')
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  )
  for (const header of setCookies) {
    const [pair = '', ...attributes] = header.split(';').map((part) => part.trim())
    const separator = pair.indexOf('=')
    if (separator < 1) continue
    const name = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    const gone =
      value === '' || attributes.some((attribute) => /^max-age=(0|-\d+)$/i.test(attribute))
    if (gone) jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

// ─── Letters ──────────────────────────────────────────────────────────────────

/** The table of the stand's own database that keeps what every letter was made of. */
export const LETTER_MIRROR = 'stand_letter_mirror'

/**
 * A mirror of the outbox, made in the database of the stand after the migrations: every row
 * the product writes for the `notifications` queue is copied as it is written, in the
 * transaction that writes it. Nothing else keeps what a letter was made of: the relay clears
 * the payload of a row once it is published and a delivered job leaves Redis at once — both may
 * hold one-time links —, and the mailer of core logs a subject, a recipient and the links. The
 * product knows nothing of the table and never reads it. `seq` is the order the rows were
 * written in.
 */
export const LETTER_MIRROR_SQL = Object.freeze([
  `CREATE TABLE ${LETTER_MIRROR} (
     seq bigserial PRIMARY KEY,
     id uuid NOT NULL UNIQUE,
     type text NOT NULL,
     dedupe_key text,
     payload jsonb NOT NULL,
     created_at timestamptz NOT NULL
   )`,
  `CREATE FUNCTION ${LETTER_MIRROR}_copy() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     INSERT INTO ${LETTER_MIRROR} (id, type, dedupe_key, payload, created_at)
     VALUES (NEW.id, NEW.type, NEW.dedupe_key, NEW.payload, NEW.created_at);
     RETURN NULL;
   END $$`,
  `CREATE TRIGGER ${LETTER_MIRROR}_copy AFTER INSERT ON outbox_events
   FOR EACH ROW WHEN (NEW.topic = 'notifications' AND NEW.payload IS NOT NULL)
   EXECUTE FUNCTION ${LETTER_MIRROR}_copy()`,
])

/**
 * What reads a letter the way its reader would: a program for `node --input-type=module -e`,
 * run in apps/core of the private copy. It takes `[{ type, payload }]` on stdin — rows
 * of the mirror — and hands each to `deliverNotification`, the function the notifications
 * worker of core calls with a job, with a mailer whose transport keeps the letter instead of
 * sending it: the catalogue, the mailer and the template of the copy do what they do in core.
 * It prints `[{ to, subject, text }]`. No address of a database or of a shop reaches it.
 */
export const LETTER_READER = `
import { createMailer } from '@repo/mail'
import { deliverNotification } from '@repo/notifications'

let input = ''
for await (const chunk of process.stdin) input += chunk
const letters = []
for (const { type, payload } of JSON.parse(input)) {
  let kept = null
  const mailer = createMailer({
    transport: {
      async send(email) {
        kept = email
      },
    },
  })
  await deliverNotification({ type, payload }, { mailer })
  if (kept === null) throw new Error('The notification ' + type + ' sent no letter')
  letters.push({ to: kept.to, subject: kept.subject, text: kept.text })
}
process.stdout.write(JSON.stringify(letters))
`

/** The environment of the reader of letters: it reads no setting and reaches nothing. */
export function letterReaderEnvironment({ path, directory }) {
  return sandboxed({ path, directory })
}

const MAIL_LINE = /\[mail\] not sent \(SENDSAY_API_KEY is empty\): "(.*)" to (\S+)$/

/**
 * Letters core «sent»: without SENDSAY_API_KEY its mailer logs the subject, the recipient and
 * the links of each letter instead of sending it. The relay clears the payload of an outbox
 * row once it is published, so this log is where a letter can be read as its reader gets it.
 */
export function lettersOf(log) {
  const letters = []
  let current = null
  for (const line of log.split('\n')) {
    const [, subject, to] = MAIL_LINE.exec(line) ?? []
    if (subject !== undefined) {
      current = { subject, to, links: [] }
      letters.push(current)
    } else if (current !== null && /^ {2}https?:\/\/\S+$/.test(line)) {
      current.links.push(line.trim())
    } else current = null
  }
  return letters
}

/** One counter of a Prometheus text exposition, summed over the series its labels match. */
export function metricValue(text, name, labels = {}) {
  let sum = 0
  for (const line of text.split('\n')) {
    const [, series, value] = /^([a-zA-Z_:][\w:]*(?:\{[^}]*\})?) (\S+)$/.exec(line) ?? []
    if (series === undefined || !(series === name || series.startsWith(`${name}{`))) continue
    const given = Object.fromEntries(
      [...series.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map(([, key, text]) => [key, text]),
    )
    if (Object.entries(labels).every(([key, text]) => given[key] === text)) sum += Number(value)
  }
  return sum
}
