// The stand of `pnpm verify:site-import` (README.md): everything the first import of a connected
// site touches, disposable and on loopback — the platform's PostgreSQL, Redis, S3 and OpenBao
// (real policies, AppRoles `web` and `core`), its Gitea over HTTPS with the stand's own CA, a
// hosting with SFTP and FTP(S) that serves a synthetic WordPress, the site's MySQL and PostgreSQL,
// and the `core` role from apps/core/dist. `startStand` brings it up and hands back the
// environments of core and web, the coordinates of every service and helpers; `stop` removes it.
//
// The upper half of the file is pure (the arguments of every container, the environments of the
// processes, the options) and covered by stand.test.mjs; `startStand` below it does the work.
//
// Never reads the repository .env, pulls an image or touches a container, a network or a volume
// it did not create: every container is `raditi-siteimport-<run>-<service>` and carries the label
// io.raditi.siteimport-verify=<run>. Secrets are random, live in memory and in 0600 files of the
// run directory, and reach containers through env files and `docker cp`, never through arguments.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  cleanEnvironment,
  localDesktop,
  runCommand,
  serviceImages,
} from '../../../apps/core/scripts/verify-agent-supervisor.mjs'
import {
  bootstrapLocalVault,
  localVaultRequest,
  waitForLocalVault,
} from '../../vault/bootstrap.mjs'
import {
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  postgresEnvFile,
  publishedPort,
  redisEnvFile,
} from '../billing-verify/stand.mjs'
import { GITEA_IMAGE, certificateConfigs, generatedGiteaPassword } from '../gitea-verify/stand.mjs'
import {
  EMPTY_ROOT,
  NESTED_PARENT,
  NESTED_ROOT,
  SITE_DATABASES,
  SITE_ROOT,
  databaseInitSql,
  expectedImport,
  gitleaksFindings,
  importManifest,
  newFixtureValues,
  siteTree,
} from './fixture.mjs'
import { newEd25519Key, newRsaKeyWithPassphrase } from './ssh-keys.mjs'

const here = fileURLToPath(new URL('./', import.meta.url))
const repository = resolve(here, '../../..')

// ─── Pure: names, images, options ─────────────────────────────────────────────

/** Every container of a run carries `io.raditi.siteimport-verify=<run>`. */
export const STAND_LABEL = 'io.raditi.siteimport-verify'
/** The label of the hosting image, so it can be found and removed across runs. */
export const IMAGE_LABEL = 'io.raditi.siteimport-verify.image'
const RUN = /^[0-9a-f]{8}$/
export const SERVICES = Object.freeze([
  'postgres',
  'redis',
  's3',
  'vault',
  'gitea',
  'site',
  'spare',
  'mysql',
  'sitepg',
])

/**
 * The two hostings: `site` serves every scenario that leaves the server alone, `spare` the ones
 * that change it while a check or an import runs (another host key, a pause, a stop).
 */
export const HOSTINGS = Object.freeze(['site', 'spare'])
/**
 * The SSH accounts of both hostings beside `site`: `siteb` has its password changed by the
 * scenario «Изменить доступ», `sitec` logs in for one scenario only, so its logins can be counted.
 */
export const EXTRA_SSH_USERS = Object.freeze(['siteb', 'sitec'])

/** The MySQL of the site and the base of the hosting image, by digest. Never pulled. */
export const MYSQL_IMAGE =
  'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb'
export const ALPINE_IMAGE =
  'alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce'
/** Every image the stand runs; the hosting image is built from ALPINE_IMAGE (Dockerfile). */
export const PINNED_IMAGES = Object.freeze([
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  serviceImages.s3,
  serviceImages.vault,
  GITEA_IMAGE,
  MYSQL_IMAGE,
])
/** The Gitleaks the product's scan is verified with. */
export const GITLEAKS_VERSION = '8.30.1'
/** How many passive FTP ports the hosting publishes, 1:1 on loopback. */
export const PASSIVE_PORTS = 10

export function newRunId() {
  return randomBytes(4).toString('hex')
}

export function runDirectoryName(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id')
  return `raditi-siteimport-${run}`
}

/** `raditi-siteimport-<run>-<service>`: no other session on the machine owns such a name. */
export function containerName(run, service) {
  runDirectoryName(run)
  if (!SERVICES.includes(service)) throw new Error('Unknown service of the stand')
  return `raditi-siteimport-${run}-${service}`
}

/**
 * The parts of a run, in the order they run: `infra` — the self-checks of the stand itself; the
 * browser scenarios `b1`…`b5` (Playwright, playwright.site-import.config.ts); the scenarios of
 * recovery `r1`…`r6`, driven by the stand through the product's own API (r6 in the browser too).
 */
export const SCENARIO_IDS = Object.freeze([
  'infra',
  'b1',
  'b2',
  'b3',
  'b4',
  'b5',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'r6',
])
/** The scenarios that run in the browser: Playwright tests whose titles start with the id. */
export const BROWSER_SCENARIOS = Object.freeze(['b1', 'b2', 'b3', 'b4', 'b5', 'r4', 'r6'])

/**
 * No flag runs everything; `--infra-only` brings the services up, runs the self-checks of the
 * stand and removes it; `--only a,b` runs the named parts (SCENARIO_IDS); `--keep` leaves the
 * stand up afterwards until Ctrl-C. Nothing names a database, a server or an address: the stand
 * works on nothing it did not start.
 */
export function standOptions(argv) {
  const options = { infraOnly: false, keep: false, only: null }
  const args = argv.filter((value) => value !== '--')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--infra-only') options.infraOnly = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? args[(index += 1)] : arg.slice('--only='.length)
      const ids = [...new Set((value ?? '').split(',').filter(Boolean))]
      if (ids.length === 0 || ids.some((id) => !SCENARIO_IDS.includes(id)))
        throw new Error(`--only takes ids separated by commas: ${SCENARIO_IDS.join(', ')}`)
      options.only = ids
    } else
      throw new Error(
        'This stand accepts --infra-only, --only <ids> and --keep; it takes no server, database, Vault or Gitea',
      )
  }
  if (options.infraOnly && options.only)
    throw new Error('--infra-only is --only infra: give one of them')
  const selected = options.infraOnly ? ['infra'] : (options.only ?? [...SCENARIO_IDS])
  return {
    keep: options.keep,
    infraOnly: options.infraOnly,
    // In the order of SCENARIO_IDS, whatever order they were named in.
    selected: SCENARIO_IDS.filter((id) => selected.includes(id)),
  }
}

/** The cabinet users each part signs in: one per scenario, one per refusal of b4. */
const ACCOUNTS = Object.freeze({
  b1: ['b1'],
  b2: ['b2'],
  b3: ['b3'],
  b4: ['b4auth', 'b4root', 'b4hostkey', 'b4database'],
  b5: ['b5'],
  r1: ['r1'],
  r2: ['r2'],
  r3: ['r3'],
  r4: ['r4'],
  r5: ['r5'],
  r6: ['r6'],
})

export function scenarioAccounts(selected) {
  return selected.flatMap((id) => ACCOUNTS[id] ?? [])
}

/** The --grep of Playwright: the tests whose titles start with `[<id>]`. */
export function playwrightGrep(ids) {
  if (ids.length === 0 || ids.some((id) => !/^[a-z][0-9]$/.test(id)))
    throw new Error('Scenario ids of the browser')
  // Matched against the whole title path (project, file, title): not anchored.
  return `\\[(?:${ids.join('|')})\\] `
}

/**
 * What each imported site must be (scenarios.mjs, verifySite): how its access signs in, the kind
 * and the hosting, the database, the events of its stage (`attempt:enqueues`), its counters.
 */
export function siteExpectations(id, { foreign } = {}) {
  const sftp = (hosting = 'site') => ({ kind: 'sftp', hosting, auth: 'password', database: null })
  const specs = {
    b1: { ...sftp(), database: 'mysql', events: ['1:1'], attempt: 1, enqueues: 1 },
    b2: {
      kind: 'ftp',
      tls: 'verified',
      hosting: 'site',
      auth: 'password',
      database: null,
      events: ['1:1'],
    },
    b3: { ...sftp(), auth: 'key', database: 'postgres', events: ['1:1'], attempt: 1 },
    b5: {
      kind: 'ftp',
      tls: 'plain',
      hosting: 'site',
      auth: 'password',
      database: null,
      events: ['1:1'],
    },
    r1: { ...sftp('spare'), events: ['1:1', '1:2'], attempt: 1, enqueues: 2 },
    r2: { ...sftp('spare'), events: ['1:1', '1:2'], attempt: 1, enqueues: 2 },
    r3: { ...sftp(), events: ['1:1', '2:1'], attempt: 2, enqueues: 1 },
    r4: {
      ...sftp(),
      events: ['1:1', '2:1'],
      attempt: 2,
      failedWith: 'repository_mismatch',
      foreign,
    },
    r5: { ...sftp(), events: ['1:1', '1:2'], attempt: 1, enqueues: 2 },
    r6: { ...sftp(), events: ['1:1', '2:1', '3:1'], attempt: 3, accessVersion: 2 },
  }
  if (!Object.hasOwn(specs, id)) throw new Error(`No site is expected of ${id}`)
  return specs[id]
}

/**
 * What the browser half reads (apps/e2e/tests/site-import/stand.ts), written by the stand into a
 * 0600 file whose path is the one variable Playwright gets: the cabinet, the sessions, the
 * hostings, the accesses to type, the control endpoint, the sites the stand made.
 */
export function browserStand(stand, { accounts, control, extras, holdCore, browser = [] }) {
  const hosting = (server) => ({
    host: server.host,
    ssh: server.ssh.port,
    ftp: server.ftp.port,
  })
  const { coordinates, secrets } = stand
  return {
    run: stand.run,
    origin: stand.web.origin,
    outputDir: join(stand.directory, 'playwright', 'results'),
    reportFile: join(stand.directory, 'playwright', 'report.json'),
    holdCore,
    /** The browser scenarios of this run: without b1 the project `held` is no dependency. */
    browser,
    control: { url: control.url, token: control.token },
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([id, { userId, cookies }]) => [id, { userId, cookies }]),
    ),
    hostings: { site: hosting(coordinates.siteServer), spare: hosting(coordinates.spareServer) },
    fingerprints: coordinates.siteServer.hostKeys,
    roots: coordinates.siteServer.roots,
    users: {
      site: secrets.site,
      ftpsite: secrets.ftpsite,
      siteb: { user: secrets.siteb.user, password: secrets.siteb.newPassword },
    },
    databases: {
      mysql: { ...secrets.mysql, host: '127.0.0.1', port: coordinates.siteDatabases.mysql.port },
      postgres: {
        ...secrets.postgres,
        host: '127.0.0.1',
        port: coordinates.siteDatabases.postgres.port,
      },
    },
    sites: extras,
  }
}

/** The tag of the hosting image: the hash of the Dockerfile and of every file of server/. */
export function serverImageTag(files) {
  const hash = createHash('sha256')
  for (const [name, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1)))
    hash.update(`${name}\0${content.length}\0`).update(content)
  return `raditi-siteimport-server:${hash.digest('hex').slice(0, 16)}`
}

// ─── Pure: container arguments ────────────────────────────────────────────────

function envFileOf(envFile) {
  if (typeof envFile !== 'string' || !isAbsolute(envFile))
    throw new Error('The env file of a container is an absolute path')
  return envFile
}

function portOf(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error('Invalid loopback port')
  return port
}

/** The head of every `docker create`: own name and label, no pull, bounded resources. */
const created = (run, service) => [
  ...['create', '--pull=never', '--name', containerName(run, service)],
  ...['--label', `${STAND_LABEL}=${run}`],
  ...['--cpus', '1', '--memory', '1g', '--pids-limit', '512'],
]

/** The platform's PostgreSQL: data in memory, the one application user `raditi`. */
export function postgresArgs({ run, envFile }) {
  return [
    ...created(run, 'postgres'),
    ...['--tmpfs', '/var/lib/postgresql/data:rw,size=768m', '-p', '127.0.0.1::5432'],
    ...['--env-file', envFileOf(envFile), POSTGRES_IMAGE],
  ]
}

/** Redis for BullMQ: nothing on disk, keys never evicted, a password from the env file. */
export function redisArgs({ run, envFile }) {
  return [
    ...created(run, 'redis'),
    ...['-p', '127.0.0.1::6379', '--env-file', envFileOf(envFile), REDIS_IMAGE, 'sh', '-c'],
    // The password goes into a file by a shell builtin: never an argument of redis-server.
    'umask 077 && printf "requirepass %s\\n" "$REDIS_PASSWORD" > /tmp/redis.conf && exec redis-server /tmp/redis.conf --save "" --appendonly no --maxmemory-policy noeviction',
  ]
}

/** SeaweedFS S3; it waits for its identities, written through `docker exec -i` (stdin). */
export function s3Args({ run }) {
  return [
    ...created(run, 's3'),
    ...['--tmpfs', '/data:rw,size=768m', '--tmpfs', '/config:rw,size=1m'],
    ...['-p', '127.0.0.1::8333', '--entrypoint', '/bin/sh', serviceImages.s3, '-c'],
    'while [ ! -f /config/s3.json ]; do sleep 0.1; done; exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/config/s3.json',
  ]
}

/** OpenBao in dev mode, its root token from the env file. */
export function vaultArgs({ run, envFile }) {
  return [
    ...created(run, 'vault'),
    ...['--tmpfs', '/tmp:rw,mode=1777,size=64m', '-p', '127.0.0.1::8200'],
    ...['--env-file', envFileOf(envFile), serviceImages.vault],
    ...['server', '-dev', '-dev-no-store-token', '-dev-listen-address=0.0.0.0:8200'],
  ]
}

/**
 * Gitea with built-in HTTPS (the certificate is copied into /tls before the start), SQLite
 * inside, published on one loopback port: the settings of infra/dev/gitea-verify.
 */
export function giteaArgs({ run, port }) {
  const env = {
    GITEA__security__INSTALL_LOCK: 'true',
    GITEA__database__DB_TYPE: 'sqlite3',
    GITEA__server__PROTOCOL: 'https',
    GITEA__server__HTTP_PORT: '3000',
    GITEA__server__ROOT_URL: `https://127.0.0.1:${portOf(port)}/`,
    GITEA__server__CERT_FILE: '/tls/server.pem',
    GITEA__server__KEY_FILE: '/tls/server-key.pem',
    GITEA__server__DISABLE_SSH: 'true',
    GITEA__server__START_SSH_SERVER: 'false',
    GITEA__service__DISABLE_REGISTRATION: 'true',
    GITEA__log__LEVEL: 'Warn',
  }
  return [
    ...created(run, 'gitea'),
    ...['-p', `127.0.0.1:${port}:3000`],
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    GITEA_IMAGE,
  ]
}

const ACCOUNT = /^[a-z][a-z0-9-]{0,39}$/
const PASSWORD_LENGTH = 36

/**
 * `docker exec` that creates a Gitea account; Gitea generates the password and prints it
 * (`generatedGiteaPassword` of gitea-verify reads it): never an argument of a process.
 */
export function giteaUserArgs({ run, user, admin = false }) {
  if (typeof user !== 'string' || !ACCOUNT.test(user)) throw new Error('Invalid account name')
  return [
    ...['exec', containerName(run, 'gitea'), 'gitea', 'admin', 'user', 'create'],
    ...['--username', user, '--random-password'],
    ...['--random-password-length', String(PASSWORD_LENGTH)],
    ...['--email', `${user}@example.test`, '--must-change-password=false'],
    ...(admin ? ['--admin'] : []),
  ]
}

/**
 * The hosting: sshd on 22 and vsftpd on 21, each on its own loopback port, and the passive
 * range published 1:1 — vsftpd names 127.0.0.1 and the port itself in its PASV answer.
 */
export function siteServerArgs({ run, service = 'site', image, ssh, ftp, passive }) {
  if (!HOSTINGS.includes(service)) throw new Error('A hosting of the stand is site or spare')
  const [first, last] = passive ?? []
  if (!Array.isArray(passive) || last - first !== PASSIVE_PORTS - 1)
    throw new Error(`The passive range has ${PASSIVE_PORTS} ports`)
  for (const port of [ssh, ftp, first, last]) portOf(port)
  if ([ssh, ftp].some((port) => port >= first && port <= last))
    throw new Error('The control ports lie outside the passive range')
  if (typeof image !== 'string' || !image.startsWith('raditi-siteimport-server:'))
    throw new Error('Only the stand hosting image runs as the hosting')
  return [
    ...created(run, service),
    ...['-p', `127.0.0.1:${ssh}:22`, '-p', `127.0.0.1:${ftp}:21`],
    ...['-p', `127.0.0.1:${first}-${last}:${first}-${last}`],
    ...['-e', `PASV_MIN=${first}`, '-e', `PASV_MAX=${last}`],
    image,
  ]
}

/**
 * The site's MySQL: the general log as a table (a scenario reads which statements arrived), TLS
 * with the stand's certificate (copied into /stand-tls before the start).
 */
export function mysqlArgs({ run, envFile }) {
  return [
    ...created(run, 'mysql'),
    ...['-p', '127.0.0.1::3306', '--env-file', envFileOf(envFile), MYSQL_IMAGE],
    ...['--general-log=ON', '--log-output=TABLE', '--skip-name-resolve'],
    ...['--ssl-ca=/stand-tls/ca.pem', '--ssl-cert=/stand-tls/cert.pem'],
    '--ssl-key=/stand-tls/key.pem',
  ]
}

/**
 * The site's PostgreSQL: TLS with the stand's certificate (the key must belong to postgres, so
 * it is installed before the server starts), every statement in the log.
 */
export function sitePostgresArgs({ run, envFile }) {
  return [
    ...created(run, 'sitepg'),
    ...['--tmpfs', '/var/lib/postgresql/data:rw,size=256m', '-p', '127.0.0.1::5432'],
    ...['--env-file', envFileOf(envFile), '--entrypoint', 'sh', POSTGRES_IMAGE, '-c'],
    [
      'install -o postgres -g postgres -m 0600 /stand-tls/key.pem /var/lib/postgresql/server-key.pem',
      'install -o postgres -g postgres -m 0644 /stand-tls/cert.pem /var/lib/postgresql/server.pem',
      'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.pem -c ssl_key_file=/var/lib/postgresql/server-key.pem -c log_statement=all -c log_connections=on',
    ].join(' && '),
  ]
}

/** The `user:password` lines chpasswd of the hostings reads from stdin, one account a line. */
export function hostingPasswords(values) {
  const lines = [
    ['site', values.sshPassword],
    ['ftpsite', values.ftpPassword],
    ['siteb', values.sitebPassword],
    ['sitec', values.sitecPassword],
  ]
  for (const [, password] of lines)
    if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(password))
      throw new Error('A hosting password is letters, digits, - and _')
  return lines.map(([user, password]) => `${user}:${password}\n`).join('')
}

export const mysqlEnvFile = ({ rootPassword, password }) =>
  `MYSQL_ROOT_PASSWORD=${rootPassword}\nMYSQL_DATABASE=${SITE_DATABASES.mysql.database}\nMYSQL_USER=${SITE_DATABASES.mysql.user}\nMYSQL_PASSWORD=${password}\n`
export const sitePostgresEnvFile = (password) =>
  `POSTGRES_USER=${SITE_DATABASES.postgres.user}\nPOSTGRES_DB=${SITE_DATABASES.postgres.database}\nPOSTGRES_PASSWORD=${password}\n`
export const vaultEnvFile = (token) => `BAO_DEV_ROOT_TOKEN_ID=${token}\n`

// ─── Pure: environments of the processes ──────────────────────────────────────

const origin = (host, port) => `http://${host}:${portOf(port)}`

/** A synthetic HOME and TMPDIR of the run: no process of the stand finds real credentials. */
const sandboxed = ({ path, directory }) => ({
  PATH: path,
  HOME: join(directory, 'home'),
  TMPDIR: join(directory, 'tmp'),
})

/** The buckets of the run in S3_BUCKET_* form; core's health checks four of them. */
export function bucketNames(run) {
  runDirectoryName(run)
  return Object.fromEntries(
    ['inbox', 'sessions', 'logs', 'artifacts', 'backups', 'platform'].map((kind) => [
      kind,
      `raditi-siteimport-${run}-${kind}`,
    ]),
  )
}

/**
 * The whole environment of `node apps/core/dist/main.js` as the core role. NODE_ENV is
 * production so the repository .env is not loaded (packages/app-bootstrap/src/env-file.ts); APP_ENV
 * is development, so loopback addresses of the hosting are allowed. The stand's CA is the one
 * extra root (Gitea API, FTPS, TLS of the databases) and the CA of git. Docker of the local
 * executor and the control channel of llm point where nothing listens: no turn runs here and
 * core must not reach a developer's Docker or llm. Gitleaks comes first on PATH.
 */
export function coreEnvironment({
  path,
  gitleaks,
  directory,
  port,
  webOrigin,
  databaseUrl,
  redisUrl,
  s3,
  vault,
  gitea,
  caPath,
  metricsToken,
}) {
  return {
    ...sandboxed({ path: `${dirname(gitleaks)}${delimiter}${path}`, directory }),
    NODE_ENV: 'production',
    NO_COLOR: '1',
    APP_ENV: 'development',
    APP_URL: webOrigin,
    CORE_PORT: String(portOf(port)),
    TURN_EXECUTOR: 'local',
    SANDBOX_DOCKER_SOCKET: join(directory, 'no-docker.sock'),
    LLM_CONTROL_URL: 'http://127.0.0.1:9',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    METRICS_TOKEN: metricsToken,
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: s3.region,
    S3_FORCE_PATH_STYLE: 'true',
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    ...Object.fromEntries(
      Object.entries(s3.buckets).map(([kind, name]) => [`S3_BUCKET_${kind.toUpperCase()}`, name]),
    ),
    VAULT_ADDR: vault.address,
    VAULT_ROLE_ID: vault.roleId,
    VAULT_SECRET_ID: vault.secretId,
    GITEA_URL: gitea.origin,
    GITEA_TOKEN: gitea.botToken,
    GITEA_PROVISIONER_TOKEN: gitea.provisionerToken,
    GIT_CA_FILE: caPath,
    NODE_EXTRA_CA_CERTS: caPath,
  }
}

/**
 * The environment of web for `next dev` against this stand (the browser half of W5). Next loads
 * the repository .env for every variable that is not set, so every name of .env.example is set,
 * blank where web needs nothing (blank counts as unset): no developer's key, shop or Vault comes
 * in. Vault is the stand's under the AppRole `web` (sites-writer, workspace-provisioner); the CA
 * lets the checks of the wizard verify FTPS and the TLS of the site databases. NODE_ENV is left
 * to Next.
 */
export function webEnvironment({
  path,
  directory,
  webOrigin,
  databaseUrl,
  redisUrl,
  vault,
  caPath,
  metricsToken,
  authSecret,
  exampleKeys,
}) {
  return {
    ...Object.fromEntries(exampleKeys.filter((key) => key !== 'NODE_ENV').map((key) => [key, ''])),
    ...sandboxed({ path, directory }),
    NEXT_TELEMETRY_DISABLED: '1',
    APP_ENV: 'development',
    APP_URL: webOrigin,
    BETTER_AUTH_URL: webOrigin,
    BETTER_AUTH_SECRET: authSecret,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    METRICS_TOKEN: metricsToken,
    VAULT_ADDR: vault.address,
    VAULT_ROLE_ID: vault.roleId,
    VAULT_SECRET_ID: vault.secretId,
    NODE_EXTRA_CA_CERTS: caPath,
    BILLING_PAST_DUE_DAYS: '7',
  }
}

/** The names .env.example declares, from its text. */
export function exampleKeysOf(text) {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key)
}

/**
 * git over HTTPS as a Gitea account: the token travels in `http.extraHeader` from the
 * environment (GIT_CONFIG_*), never in a URL or an argument; the CA is the stand's; no system or
 * global configuration, no prompt.
 */
export function gitEnvironment({ path, home, caPath, user, token }) {
  const basic = Buffer.from(`${user}:${token}`).toString('base64')
  return {
    PATH: path,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSL_CAINFO: caPath,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_AUTHOR_NAME: 'Stand',
    GIT_AUTHOR_EMAIL: 'stand@example.test',
    GIT_COMMITTER_NAME: 'Stand',
    GIT_COMMITTER_EMAIL: 'stand@example.test',
  }
}

/** Replaces every value of `secrets` (strings of eight characters or more) in `text`. */
export function redactor(secrets) {
  const values = [
    ...new Set(secrets.filter((value) => typeof value === 'string' && value.length >= 8)),
  ]
    // The longest first: a value that contains another is replaced whole.
    .sort((a, b) => b.length - a.length)
  return (text) =>
    values.reduce((result, value) => result.replaceAll(value, '[redacted]'), String(text))
}

/** The run record a later run sweeps by when this one was killed outright. */
export function runRecord({ run, pid, core, web = [] }) {
  runDirectoryName(run)
  return `${JSON.stringify({ run, pid, core, web })}\n`
}

export function readRunRecord(name, text) {
  const [, run] = /^raditi-siteimport-([0-9a-f]{8})$/.exec(name) ?? []
  if (!run) return null
  try {
    const record = JSON.parse(text)
    if (record?.run !== run || !Number.isInteger(record.pid) || !Array.isArray(record.core))
      return null
    const web = Array.isArray(record.web)
      ? record.web.filter((entry) => Number.isInteger(entry?.pid) && Number.isInteger(entry?.port))
      : []
    return {
      run,
      pid: record.pid,
      core: record.core.filter(Number.isInteger),
      web: web.map(({ pid, port }) => ({ pid, port })),
    }
  } catch {
    return null
  }
}

// ─── The stand ────────────────────────────────────────────────────────────────

const dockerCallerEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ['PATH', 'HOME'].includes(name) ||
        (name.startsWith('DOCKER_') && name !== 'DOCKER_CONTEXT'),
    ),
  )

async function availableLoopbackPort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  // Another process may take it after the close: Docker then fails instead of sharing it.
  return port
}

async function portIsFree(port) {
  const server = createServer()
  return new Promise((done) => {
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
}

/** PASSIVE_PORTS free consecutive loopback ports that hold none of `taken`. */
async function passiveRange(taken = []) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const first = 41_000 + (randomBytes(2).readUInt16BE(0) % 18_000)
    let free = !taken.some((port) => port >= first && port < first + PASSIVE_PORTS)
    for (let port = first; port < first + PASSIVE_PORTS && free; port++)
      free = await portIsFree(port)
    if (free) return [first, first + PASSIVE_PORTS - 1]
  }
  throw new Error('No free range of passive FTP ports on loopback')
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The working directory of a process, resolved; null when it cannot be read. */
async function workingDirectory(pid, command) {
  if (process.platform === 'linux') return readlink(`/proc/${pid}/cwd`).catch(() => null)
  const listed = await command('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    env: cleanEnvironment(process.env),
    allowFailure: true,
    timeoutMs: 10_000,
  }).catch(() => null)
  const [, path] = /^n(.+)$/m.exec(listed?.stdout ?? '') ?? []
  return path ?? null
}

/**
 * Cleans up after runs of the stand that ended without cleaning up (SIGKILL, a machine that went
 * down): for every run directory whose stand process is gone, the containers that carry its run
 * id in the label, the core processes it recorded that still run in its run directory, and the
 * directory itself. Nothing is chosen by a name alone.
 */
async function sweepDeadRuns({ docker, command, self, log }) {
  const tmp = tmpdir()
  for (const name of (await readdir(tmp))
    .filter((entry) => /^raditi-siteimport-[0-9a-f]{8}$/.test(entry))
    .sort()) {
    const directory = join(tmp, name)
    const record = readRunRecord(
      name,
      await readFile(join(directory, 'run.json'), 'utf8').catch(() => ''),
    )
    if (record === null || record.run === self || alive(record.pid)) continue
    const resolved = await realpath(directory).catch(() => directory)
    const killed = []
    for (const pid of record.core) {
      if (!alive(pid)) continue
      const cwd = await workingDirectory(pid, command)
      if (cwd !== null && (await realpath(cwd).catch(() => cwd)) === resolved) {
        process.kill(pid, 'SIGKILL')
        killed.push(pid)
      }
    }
    // next dev of the run: its process group, when it still runs in apps/web on the port of the
    // record — another session's next dev has another port, a reused pid another directory.
    const webRoot = await realpath(join(repository, 'apps/web')).catch(() => null)
    for (const { pid, port } of record.web) {
      if (!alive(pid) || webRoot === null) continue
      const cwd = await workingDirectory(pid, command)
      const line = await command('ps', ['-o', 'command=', '-p', String(pid)], {
        env: cleanEnvironment(process.env),
        allowFailure: true,
      }).catch(() => null)
      if (
        cwd !== null &&
        (await realpath(cwd).catch(() => cwd)) === webRoot &&
        new RegExp(`--port ${port}\\b`).test(line?.stdout ?? '')
      ) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          process.kill(pid, 'SIGKILL')
        }
        killed.push(pid)
      }
    }
    const listed = await docker([
      ...['ps', '-a', '--filter', `label=${STAND_LABEL}=${record.run}`],
      ...['--format', `{{.Names}}\t{{.Label "${STAND_LABEL}"}}`],
    ])
    const containers = listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([, run]) => run === record.run)
      .map(([container]) => container)
    for (const container of containers) await docker(['rm', '-fv', container])
    await rm(directory, { recursive: true, force: true })
    log(
      `SWEPT run ${record.run} (stand pid ${record.pid} is gone): ` +
        [
          containers.length > 0 ? `containers ${containers.join(', ')}` : null,
          killed.length > 0 ? `core and web pids ${killed.join(', ')}` : null,
          'its run directory',
        ]
          .filter(Boolean)
          .join('; '),
    )
  }
}

/** One request of the stand to its Gitea, trusted through the stand's CA only. */
function giteaRequest({ port, ca, signal }, method, path, { auth, body, raw = false } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const authorization =
    auth?.token !== undefined
      ? `token ${auth.token}`
      : auth?.user !== undefined
        ? `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`
        : undefined
  return new Promise((done, reject) => {
    const failed = () => reject(new Error(`Gitea did not answer ${method} ${path.split('?')[0]}`))
    const request = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/api${path}`,
        method,
        ca,
        headers: {
          accept: raw ? '*/*' : 'application/json',
          ...(authorization ? { authorization } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('error', failed)
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          let json = null
          if (!raw)
            try {
              json = buffer.length > 0 ? JSON.parse(buffer.toString('utf8')) : null
            } catch {
              // A body that is not JSON matters only to a caller that reads it raw.
            }
          done({ status: response.statusCode, json, buffer, headers: response.headers })
        })
      },
    )
    request.once('error', failed)
    request.end(payload)
  })
}

const expectStatus = (result, statuses, what) => {
  // The status only: a body may repeat what was sent.
  if (!statuses.includes(result.status)) throw new Error(`${what}: HTTP ${result.status}`)
  return result
}

/** Polls until `probe` answers something truthy. */
async function until(what, probe, { timeoutMs = 90_000, signal, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw new Error('The stand was interrupted')
    const answer = await Promise.resolve()
      .then(probe)
      .catch(() => null)
    if (answer) return answer
    if (Date.now() > deadline)
      throw new Error(`Waited ${Math.round(timeoutMs / 1000)} s for ${what}`)
    await sleep(intervalMs)
  }
}

/** The first line a TCP server says: the SSH or FTP banner. */
function banner(port, timeoutMs = 3000) {
  return new Promise((done, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('no banner'))
    }, timeoutMs)
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      socket.destroy()
      done(chunk.toString('latin1'))
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** The stand's CA (two days) and one server certificate for 127.0.0.1 and localhost. */
async function createCertificates(directory, command, name) {
  const openssl = (...args) =>
    command('openssl', args, {
      env: { PATH: process.env.PATH, HOME: directory },
      timeoutMs: 30_000,
    })
  const file = (leaf) => join(directory, leaf)
  const key = (path) =>
    openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', path)
  const configs = certificateConfigs()
  await writeFile(file('ca.ext'), configs.authority)
  await writeFile(file('server.ext'), configs.server)
  await key(file('ca-key.pem'))
  await openssl(
    ...[
      'req',
      '-new',
      '-key',
      file('ca-key.pem'),
      '-subj',
      `/CN=${name} CA`,
      '-out',
      file('ca.csr'),
    ],
  )
  await openssl(
    ...['x509', '-req', '-in', file('ca.csr'), '-signkey', file('ca-key.pem'), '-days', '2'],
    ...['-sha256', '-extfile', file('ca.ext'), '-out', file('ca.pem')],
  )
  await key(file('server-key.pem'))
  await openssl(
    ...['req', '-new', '-key', file('server-key.pem'), '-subj', '/CN=127.0.0.1'],
    ...['-out', file('server.csr')],
  )
  await openssl(
    ...['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey'],
    ...[file('ca-key.pem'), '-days', '2', '-sha256', '-set_serial'],
    ...[`0x${randomBytes(16).toString('hex')}`, '-extfile', file('server.ext')],
    ...['-out', file('server.pem')],
  )
  return {
    ca: file('ca.pem'),
    cert: file('server.pem'),
    key: file('server-key.pem'),
  }
}

/** A directory of TLS files as a container reads them: synthetic two-day key, readable by all. */
async function tlsDirectory(path, certificates, names) {
  await mkdir(path, { recursive: true, mode: 0o755 })
  for (const [name, from] of Object.entries(names)) {
    await writeFile(join(path, name), await readFile(certificates[from]), { mode: 0o444 })
    await chmod(join(path, name), 0o444)
  }
}

/** Writes the entries of `siteTree` below `directory`: files 0644, folders 0755, links as links. */
async function writeTree(directory, entries) {
  await mkdir(directory, { recursive: true, mode: 0o755 })
  for (const entry of entries) {
    const target = join(directory, ...entry.path.split('/'))
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    if (entry.type === 'link') await symlink(entry.target, target)
    else await writeFile(target, entry.content, { mode: 0o644 })
  }
}

/** The `core` role from its build, with a log file of the run. */
function coreProcess({ env, port, logFile, cwd, metricsToken, record, signal }) {
  const mainJs = join(repository, 'apps/core/dist/main.js')
  let child
  let log = ''
  let exited = Promise.resolve(null)
  const running = () => child !== undefined && child.exitCode === null && child.signalCode === null
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${metricsToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  const stop = async (kind) => {
    if (!running()) return
    child.kill(kind)
    const overdue = kind === 'SIGKILL' ? undefined : setTimeout(() => child.kill('SIGKILL'), 15_000)
    await exited
    clearTimeout(overdue)
  }
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    logFile,
    /** Starts core; with `wait` (the default) resolves once /health answers with its checks. */
    async start({ overrides = {}, wait = true } = {}) {
      if (running()) throw new Error('core is running already')
      if (!existsSync(mainJs))
        throw new Error('Build the orchestrator first: pnpm --filter core build')
      const file = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
      child = spawn(process.execPath, [mainJs], {
        cwd,
        env: { ...env, ...overrides },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const capture = (chunk) => {
        log += chunk.toString('utf8')
        file.write(chunk)
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      exited = new Promise((done) => {
        child.once('error', () => done(null))
        child.once('close', (code) => file.end(() => done(code)))
      })
      await record(child.pid)
      if (!wait) return
      await until(
        'core to answer /health',
        async () => {
          if (!running()) throw new Error('core exited')
          const answer = await health()
          return answer.body?.checks ? answer : null
        },
        { timeoutMs: 60_000, signal },
      ).catch((error) => {
        throw new Error(running() ? error.message : 'core exited before it answered /health')
      })
    },
    health,
    /** SIGTERM, as a deployment stops it; SIGKILL after 15 s. */
    stop: () => stop('SIGTERM'),
    /** SIGKILL: what a crash of core looks like to the import. */
    kill: () => stop('SIGKILL'),
    running,
    log: () => log,
    pid: () => child?.pid,
  }
}

/** The pids of the processes that run next dev or next-server in `directory`; [] without pgrep. */
async function nextServersIn(directory, command) {
  const listed = await command('pgrep', ['-f', 'next dev|next-server|next/dist/server'], {
    env: cleanEnvironment(process.env),
    allowFailure: true,
  }).catch(() => null)
  const pids = (listed?.stdout ?? '')
    .split('\n')
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  const root = await realpath(directory).catch(() => directory)
  const inside = []
  for (const pid of pids) {
    const cwd = await workingDirectory(pid, command)
    if (cwd !== null && (await realpath(cwd).catch(() => cwd)) === root) inside.push(pid)
  }
  return inside
}

/**
 * `next dev` of apps/web with the stand's environment, on 127.0.0.1 only. Next allows one dev
 * server per app directory: another one (a developer's `pnpm dev`, another stand's Playwright
 * run) is waited for, never stopped. Its own process group, so the stop reaches next-server too.
 */
function webProcess({ env, port, logFile, record, signal, command }) {
  const cwd = join(repository, 'apps/web')
  let child
  let log = ''
  let exited = Promise.resolve(null)
  const running = () => child !== undefined && child.exitCode === null && child.signalCode === null
  const group = (kind) => {
    try {
      process.kill(-child.pid, kind)
    } catch {
      try {
        child.kill(kind)
      } catch {
        // Gone already.
      }
    }
  }
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    logFile,
    /** Waits for any other next dev of apps/web to end, starts this one, waits for /sign-in. */
    async start({ waitMs = 15 * 60_000, onWait = () => {} } = {}) {
      if (running()) throw new Error('web is running already')
      const deadline = Date.now() + waitMs
      let told = false
      for (;;) {
        const others = await nextServersIn(cwd, command)
        if (others.length === 0) break
        if (!told) onWait(others)
        told = true
        if (Date.now() > deadline)
          throw new Error('Another next dev of apps/web did not end in time; it was not stopped')
        await sleep(5_000, undefined, { signal })
      }
      const file = createWriteStream(logFile, { flags: 'a', mode: 0o600 })
      child = spawn(
        join(cwd, 'node_modules/.bin/next'),
        ['dev', '--port', String(port), '--hostname', '127.0.0.1'],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      )
      const capture = (chunk) => {
        log += chunk.toString('utf8')
        file.write(chunk)
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      exited = new Promise((done) => {
        child.once('error', () => done(null))
        child.once('close', (code) => file.end(() => done(code)))
      })
      await record(child.pid, port)
      await until(
        'next dev to answer /sign-in',
        async () => {
          if (!running()) throw new Error('next dev exited')
          const response = await fetch(`http://127.0.0.1:${port}/sign-in`, {
            redirect: 'manual',
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          })
          await response.arrayBuffer()
          return response.status === 200
        },
        { timeoutMs: 240_000, signal, intervalMs: 1000 },
      ).catch((error) => {
        throw new Error(running() ? error.message : 'next dev exited before it answered')
      })
    },
    async stop() {
      if (!running()) return
      group('SIGTERM')
      const overdue = setTimeout(() => group('SIGKILL'), 10_000)
      await exited
      clearTimeout(overdue)
    },
    running,
    log: () => log,
    pid: () => child?.pid,
  }
}

/**
 * Brings the stand up. `signal` aborts every step; `log` gets one line per stage. Resolves to
 * the stand (README.md, «Что возвращает startStand»); on a failure everything created so far
 * is removed before the error is thrown.
 */
export async function startStand({ signal = new AbortController().signal, log = () => {} } = {}) {
  const run = newRunId()
  const owned = {
    run,
    containers: [],
    directory: undefined,
    db: undefined,
    core: undefined,
    web: undefined,
    later: [],
  }
  const secretValues = []
  const redact = (text) => redactor(secretValues)(text)
  const command = (binary, args, options = {}) => runCommand(binary, args, { signal, ...options })
  let docker = (args, options = {}) =>
    command('docker', args, { env: dockerCallerEnv(), ...options })
  let stage = 'preflight'
  const progress = (value) => {
    stage = value
    log(`site-import ${value}`)
  }

  // Once: a second call waits for the first and reports the same outcome.
  let stopping
  const stop = () => (stopping ??= removeEverything())
  const removeEverything = async () => {
    const failed = []
    const step = async (name, action) => {
      try {
        await action()
      } catch {
        failed.push(name)
      }
    }
    for (const close of [...owned.later].reverse()) await step('helper', close)
    await step('web', () => owned.web?.stop())
    await step('core', () => owned.core?.stop())
    await step('database client', () => owned.db?.end())
    for (const name of [...owned.containers].reverse())
      await step(`container ${name}`, async () => {
        const label = await docker(
          ['inspect', name, '--format', `{{index .Config.Labels "${STAND_LABEL}"}}`],
          {
            cleanup: true,
            allowFailure: true,
            timeoutMs: 15_000,
          },
        )
        if (label.code !== 0) {
          if (!/No such (object|container)/u.test(label.stderr)) throw new Error('inspect failed')
          return
        }
        // The name is random and the label names this run: never a container of another session.
        if (label.stdout.trim() !== run) throw new Error('foreign label')
        await docker(['rm', '-fv', name], { cleanup: true, timeoutMs: 30_000 })
      })
    if (owned.containers.length > 0)
      await step('containers of the run', async () => {
        const left = await docker(['ps', '-aq', '--filter', `label=${STAND_LABEL}=${run}`], {
          cleanup: true,
          timeoutMs: 15_000,
        })
        if (left.stdout.trim() !== '') throw new Error('left')
      })
    await step('run directory', () =>
      owned.directory ? rm(owned.directory, { recursive: true, force: true }) : undefined,
    )
    if (failed.length > 0)
      throw new Error(`Cleanup of the site-import stand failed: ${failed.join(', ')}`)
  }

  try {
    // ── Preflight: a local Docker, the pinned images, the tools ─────────────────────────────
    const connection = await localDesktop(process.env, command, {
      nativeLinux: process.platform === 'linux',
    })
    const dockerEnv = { ...dockerCallerEnv(), DOCKER_HOST: connection.endpoint }
    docker = (args, options = {}) => command('docker', args, { env: dockerEnv, ...options })
    for (const image of PINNED_IMAGES) {
      const found = await docker(['image', 'inspect', image, '--format', '{{.Id}}'], {
        allowFailure: true,
      })
      if (found.code !== 0)
        throw new Error(
          `A pinned image is missing locally; nothing is pulled. Run: docker pull ${image}`,
        )
    }
    const gitleaks = process.env.P2_GITLEAKS_BINARY?.trim()
      ? process.env.P2_GITLEAKS_BINARY
      : (
          await command('sh', ['-c', 'command -v gitleaks'], {
            env: cleanEnvironment(process.env),
            allowFailure: true,
          })
        ).stdout.trim()
    if (!gitleaks || !isAbsolute(gitleaks))
      throw new Error(
        `Gitleaks ${GITLEAKS_VERSION} is needed: set P2_GITLEAKS_BINARY or put gitleaks on PATH`,
      )
    const scanner = await command(gitleaks, ['version'], { env: cleanEnvironment(process.env) })
    if (scanner.stdout.trim() !== GITLEAKS_VERSION)
      throw new Error(`Use Gitleaks ${GITLEAKS_VERSION}; ${gitleaks} is another version`)
    await command('git', ['--version'], { env: cleanEnvironment(process.env) })
    await command('openssl', ['version'], { env: cleanEnvironment(process.env) })

    progress('sweeping after runs that died')
    await sweepDeadRuns({ docker, command, self: run, log })

    // ── The run directory and its secrets ────────────────────────────────────────────────────
    progress('preparing the run directory')
    const directory = join(tmpdir(), runDirectoryName(run))
    await mkdir(directory, { mode: 0o700 })
    owned.directory = directory
    await chmod(directory, 0o700)
    const corePids = []
    const webPids = []
    const writeRecord = async () => {
      await writeFile(
        join(directory, 'run.json.new'),
        runRecord({ run, pid: process.pid, core: corePids, web: webPids }),
        {
          mode: 0o600,
        },
      )
      await rename(join(directory, 'run.json.new'), join(directory, 'run.json'))
    }
    await writeRecord()
    for (const leaf of ['home', 'tmp', 'logs', 'secrets', 'tls', 'site-in', 'work'])
      await mkdir(join(directory, leaf), { mode: 0o700 })
    const file = (...parts) => join(directory, ...parts)
    const secretFile = async (name, value) => {
      await writeFile(file('secrets', name), value, { mode: 0o600 })
      return file('secrets', name)
    }
    const random = (bytes = 24) => randomBytes(bytes).toString('hex')
    const values = newFixtureValues()
    const secrets = {
      postgres: random(),
      redis: random(),
      vaultRoot: random(),
      s3Access: `siteimport-${random(8)}`,
      s3Secret: random(),
      metrics: randomBytes(24).toString('base64url'),
      auth: randomBytes(36).toString('base64url'),
      mysqlRoot: random(),
    }
    secretValues.push(
      ...Object.values(secrets),
      values.sshPassword,
      values.ftpPassword,
      values.sitebPassword,
      values.sitebNewPassword,
      values.sitecPassword,
      values.keyPassphrase,
      values.databasePassword,
      values.postgresPassword,
      values.awsKeyId,
      values.awsSecret,
      ...Object.values(values.wpSecrets),
    )
    const envFiles = {
      postgres: await secretFile('postgres.env', postgresEnvFile(secrets.postgres)),
      redis: await secretFile('redis.env', redisEnvFile(secrets.redis)),
      vault: await secretFile('vault.env', vaultEnvFile(secrets.vaultRoot)),
      // The WordPress of the hosting talks to this MySQL: DB_PASSWORD is the password of `stand`.
      mysql: await secretFile(
        'mysql.env',
        mysqlEnvFile({ rootPassword: secrets.mysqlRoot, password: values.databasePassword }),
      ),
      sitepg: await secretFile('sitepg.env', sitePostgresEnvFile(values.postgresPassword)),
    }

    progress('issuing the stand CA and its server certificate')
    const certificates = await createCertificates(file('tls'), command, `raditi-siteimport-${run}`)
    const caPath = certificates.ca
    const ca = await readFile(caPath)

    progress('generating the site, the SSH keys and the hosting inputs')
    const hostKeys = {
      first: newEd25519Key('stand-host-first'),
      second: newEd25519Key('stand-host-second'),
    }
    const userKey = newEd25519Key('site@stand')
    const userKeyWithPassphrase = newRsaKeyWithPassphrase(
      values.keyPassphrase,
      'site-passphrase@stand',
    )
    secretValues.push(
      hostKeys.first.privateKey,
      hostKeys.second.privateKey,
      userKey.privateKey,
      userKeyWithPassphrase.privateKey,
    )
    const tree = siteTree(values)
    await writeTree(file('site-home'), tree)
    const siteIn = file('site-in')
    await mkdir(join(siteIn, 'host_keys'), { mode: 0o755 })
    await mkdir(join(siteIn, 'authorized_keys'), { mode: 0o755 })
    await writeFile(join(siteIn, 'host_keys/first'), hostKeys.first.privateKey, { mode: 0o600 })
    await writeFile(join(siteIn, 'host_keys/second'), hostKeys.second.privateKey, { mode: 0o600 })
    await writeFile(
      join(siteIn, 'authorized_keys/site'),
      `${userKey.publicKey}\n${userKeyWithPassphrase.publicKey}\n`,
      { mode: 0o644 },
    )
    await writeFile(join(siteIn, 'passwords'), hostingPasswords(values), { mode: 0o600 })
    await tlsDirectory(join(siteIn, 'tls'), certificates, { 'cert.pem': 'cert', 'key.pem': 'key' })
    await tlsDirectory(file('tls-db'), certificates, {
      'ca.pem': 'ca',
      'cert.pem': 'cert',
      'key.pem': 'key',
    })
    await tlsDirectory(file('tls-gitea'), certificates, {
      'server.pem': 'cert',
      'server-key.pem': 'key',
    })
    const init = databaseInitSql()
    await mkdir(file('init-mysql'), { mode: 0o755 })
    await mkdir(file('init-sitepg'), { mode: 0o755 })
    await writeFile(file('init-mysql', 'init.sql'), init.mysql, { mode: 0o644 })
    await writeFile(file('init-sitepg', 'init.sql'), init.postgres, { mode: 0o644 })

    progress('building the hosting image when it is not there yet')
    const serverFiles = [['Dockerfile', await readFile(join(here, 'Dockerfile'))]]
    for (const name of (await readdir(join(here, 'server'))).sort())
      serverFiles.push([`server/${name}`, await readFile(join(here, 'server', name))])
    const image = serverImageTag(serverFiles)
    if (
      (await docker(['image', 'inspect', image, '--format', '{{.Id}}'], { allowFailure: true }))
        .code !== 0
    ) {
      if (
        (
          await docker(['image', 'inspect', ALPINE_IMAGE, '--format', '{{.Id}}'], {
            allowFailure: true,
          })
        ).code !== 0
      )
        throw new Error(
          `The base of the hosting image is missing; nothing is pulled. Run: docker pull ${ALPINE_IMAGE}`,
        )
      await docker(
        [
          ...['build', '--label', `${IMAGE_LABEL}=1`, '-t', image],
          ...['-f', join(here, 'Dockerfile'), join(here, 'server')],
        ],
        { timeoutMs: 600_000 },
      )
    }

    // ── Containers ───────────────────────────────────────────────────────────────────────────
    progress('starting PostgreSQL, Redis, S3, OpenBao, Gitea, the hosting and the site databases')
    const single = {
      gitea: await availableLoopbackPort(),
      ssh: await availableLoopbackPort(),
      ftp: await availableLoopbackPort(),
      core: await availableLoopbackPort(),
      web: await availableLoopbackPort(),
      spareSsh: await availableLoopbackPort(),
      spareFtp: await availableLoopbackPort(),
    }
    // The passive ranges hold no port picked above, nor each other's ports.
    const passive = await passiveRange(Object.values(single))
    const range = (first) => Array.from({ length: PASSIVE_PORTS }, (_, index) => first + index)
    const sparePassive = await passiveRange([...Object.values(single), ...range(passive[0])])
    const ports = { ...single, passive }
    const sparePorts = { ssh: single.spareSsh, ftp: single.spareFtp, passive: sparePassive }
    const name = (service) => containerName(run, service)
    const create = async (service, args, copies = []) => {
      // Registered before the create: Docker may create the container although its CLI fails.
      owned.containers.push(name(service))
      await docker(args)
      for (const [from, to] of copies) await docker(['cp', from, `${name(service)}:${to}`])
      await docker(['start', name(service)])
    }
    // All of them settle before a failure is thrown: the cleanup must not race a create.
    // Every argument list first: one that throws must not leave the others half started.
    const hostingCopies = [
      [`${siteIn}/.`, '/stand/in'],
      [`${file('site-home')}/.`, '/home/site'],
    ]
    const plan = [
      ['postgres', postgresArgs({ run, envFile: envFiles.postgres })],
      ['redis', redisArgs({ run, envFile: envFiles.redis })],
      ['s3', s3Args({ run })],
      ['vault', vaultArgs({ run, envFile: envFiles.vault })],
      ['gitea', giteaArgs({ run, port: ports.gitea }), [[file('tls-gitea'), '/tls']]],
      ...HOSTINGS.map((service) => [
        service,
        siteServerArgs({ run, service, image, ...(service === 'site' ? ports : sparePorts) }),
        hostingCopies,
      ]),
      [
        'mysql',
        mysqlArgs({ run, envFile: envFiles.mysql }),
        [
          [file('tls-db'), '/stand-tls'],
          [`${file('init-mysql')}/.`, '/docker-entrypoint-initdb.d'],
        ],
      ],
      [
        'sitepg',
        sitePostgresArgs({ run, envFile: envFiles.sitepg }),
        [
          [file('tls-db'), '/stand-tls'],
          [`${file('init-sitepg')}/.`, '/docker-entrypoint-initdb.d'],
        ],
      ],
    ]
    const starts = await Promise.allSettled(
      plan.map(([service, args, copies]) => create(service, args, copies)),
    )
    const refused = starts.find(({ status }) => status === 'rejected')
    if (refused) throw refused.reason
    // The passwords of the hosting were read by its entrypoint and are gone with the file.
    await rm(join(siteIn, 'passwords'), { force: true })
    const published = async (service, port) =>
      publishedPort((await docker(['port', name(service), `${port}/tcp`])).stdout)
    const coordinates = {
      run,
      directory,
      postgres: {
        host: '127.0.0.1',
        port: await published('postgres', 5432),
        user: 'raditi',
        database: 'raditi',
        container: name('postgres'),
      },
      redis: { host: '127.0.0.1', port: await published('redis', 6379), container: name('redis') },
      s3: {
        endpoint: `http://127.0.0.1:${await published('s3', 8333)}`,
        region: 'us-east-1',
        buckets: bucketNames(run),
        container: name('s3'),
      },
      vault: {
        address: `http://127.0.0.1:${await published('vault', 8200)}`,
        container: name('vault'),
      },
      gitea: {
        origin: `https://127.0.0.1:${ports.gitea}`,
        port: ports.gitea,
        container: name('gitea'),
        organization: 'sites',
      },
      ...Object.fromEntries(
        HOSTINGS.map((service) => {
          const own = service === 'site' ? ports : sparePorts
          return [
            service === 'site' ? 'siteServer' : 'spareServer',
            {
              host: '127.0.0.1',
              ssh: { port: own.ssh },
              ftp: { port: own.ftp, passive: own.passive },
              container: name(service),
              image,
              users: { ssh: ['site', ...EXTRA_SSH_USERS], ftp: ['site', 'ftpsite'] },
              roots: {
                site: SITE_ROOT,
                empty: EMPTY_ROOT,
                nestedParent: NESTED_PARENT,
                nested: NESTED_ROOT,
              },
              hostKeys: {
                first: hostKeys.first.fingerprint,
                second: hostKeys.second.fingerprint,
              },
            },
          ]
        }),
      ),
      siteDatabases: {
        mysql: {
          host: '127.0.0.1',
          port: await published('mysql', 3306),
          ...SITE_DATABASES.mysql,
          container: name('mysql'),
        },
        postgres: {
          host: '127.0.0.1',
          port: await published('sitepg', 5432),
          ...SITE_DATABASES.postgres,
          container: name('sitepg'),
        },
      },
      core: { port: ports.core, url: `http://127.0.0.1:${ports.core}` },
      // A numeric origin: next dev listens on 127.0.0.1 only, and the session cookie is its own.
      web: { port: ports.web, origin: `http://127.0.0.1:${ports.web}` },
    }
    const databaseUrl = `postgresql://raditi:${secrets.postgres}@127.0.0.1:${coordinates.postgres.port}/raditi`
    const redisUrl = `redis://default:${secrets.redis}@127.0.0.1:${coordinates.redis.port}`

    progress('waiting for the services')
    await Promise.all([
      until(
        'PostgreSQL',
        async () =>
          (
            await docker(
              [
                'exec',
                name('postgres'),
                'pg_isready',
                '-h',
                '127.0.0.1',
                '-U',
                'raditi',
                '-d',
                'raditi',
              ],
              { allowFailure: true, timeoutMs: 5000 },
            )
          ).code === 0,
        { signal },
      ),
      until(
        'Redis',
        async () =>
          (
            await docker(
              ['exec', name('redis'), 'sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'],
              { allowFailure: true, timeoutMs: 5000 },
            )
          ).stdout.trim() === 'PONG',
        { signal },
      ),
      waitForLocalVault({ address: coordinates.vault.address }, { timeoutMs: 60_000 }),
      until(
        'Gitea',
        async () =>
          (await giteaRequest({ port: ports.gitea, ca, signal }, 'GET', '/healthz')).status === 200,
        { signal },
      ),
      ...[ports, sparePorts].map((own) =>
        until(
          'the hostings',
          async () =>
            (await banner(own.ssh)).startsWith('SSH-2.0-') &&
            (await banner(own.ftp)).startsWith('220'),
          { signal },
        ),
      ),
      until(
        'the site PostgreSQL',
        async () =>
          (
            await docker(
              [
                'exec',
                name('sitepg'),
                'pg_isready',
                '-h',
                '127.0.0.1',
                '-U',
                'stand',
                '-d',
                'stand',
              ],
              { allowFailure: true, timeoutMs: 5000 },
            )
          ).code === 0,
        { signal },
      ),
      // The image's entrypoint initialises without networking and restarts: TCP means ready.
      until(
        'the site MySQL',
        async () => {
          const probe = await docker(
            [
              'exec',
              name('mysql'),
              'sh',
              '-c',
              'MYSQL_PWD="$MYSQL_PASSWORD" mysql -h 127.0.0.1 -u "$MYSQL_USER" -N -e "SELECT 1" "$MYSQL_DATABASE"',
            ],
            { allowFailure: true, timeoutMs: 10_000 },
          )
          return probe.code === 0 && probe.stdout.trim() === '1'
        },
        { signal, timeoutMs: 180_000, intervalMs: 1000 },
      ),
    ])

    progress('S3 identities and buckets')
    await docker(
      [
        'exec',
        '-i',
        name('s3'),
        'sh',
        '-c',
        'umask 077; cat > /config/s3.json.tmp && mv /config/s3.json.tmp /config/s3.json',
      ],
      {
        input: JSON.stringify({
          identities: [
            {
              name: 'siteimport-stand',
              credentials: [{ accessKey: secrets.s3Access, secretKey: secrets.s3Secret }],
              actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
            },
          ],
        }),
      },
    )
    const { S3Client, CreateBucketCommand, HeadBucketCommand } = createRequire(
      join(repository, 'packages/storage/package.json'),
    )('@aws-sdk/client-s3')
    const s3 = new S3Client({
      endpoint: coordinates.s3.endpoint,
      region: coordinates.s3.region,
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: secrets.s3Access, secretAccessKey: secrets.s3Secret },
    })
    try {
      for (const bucket of Object.values(coordinates.s3.buckets))
        await until(
          `S3 bucket ${bucket}`,
          async () => {
            const options = { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }
            await s3.send(new CreateBucketCommand({ Bucket: bucket }), options).catch(() => {})
            await s3.send(new HeadBucketCommand({ Bucket: bucket }), options)
            return true
          },
          { signal, timeoutMs: 60_000 },
        )
    } finally {
      s3.destroy()
    }

    progress('platform database: migrations and seeds')
    // The stand's own Prisma configuration: the repository's one loads the repository .env.
    const prismaConfig = await secretFile(
      'prisma.config.ts',
      `export default {schema:${JSON.stringify(join(repository, 'packages/db/prisma/schema.prisma'))},migrations:{path:${JSON.stringify(join(repository, 'packages/db/prisma/migrations'))},seed:${JSON.stringify(`node ${join(repository, 'packages/db/prisma/seed.ts')}`)}},datasource:{url:process.env.DATABASE_URL}}\n`,
    )
    const prismaEnv = {
      ...cleanEnvironment(process.env),
      NODE_ENV: 'test',
      CI: '1',
      JITI_FS_CACHE: 'false',
      DATABASE_URL: databaseUrl,
    }
    for (const args of [
      ['migrate', 'deploy'],
      ['db', 'seed'],
    ])
      await command(
        'pnpm',
        ['--filter', '@repo/db', 'exec', 'prisma', ...args, '--config', prismaConfig],
        {
          env: prismaEnv,
          timeoutMs: 240_000,
        },
      )
    const { Pool } = createRequire(join(repository, 'packages/db/package.json'))('pg')
    owned.db = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 })
    // An idle client whose container is being removed must not take the process down.
    owned.db.on('error', () => {})

    progress('OpenBao: mounts, the nine policies, AppRoles web and core')
    const vaultAddress = coordinates.vault.address
    const operator = (path, options = {}) =>
      localVaultRequest({ address: vaultAddress, token: secrets.vaultRoot }, path, options)
    await bootstrapLocalVault({ address: vaultAddress, token: secrets.vaultRoot })
    expectStatus(
      await operator('sys/auth/approle', { method: 'POST', body: { type: 'approle' } }),
      [200, 204],
      'Enable AppRole',
    )
    const appRoles = {}
    for (const [role, policies] of [
      // As in production: the Transit key of a workspace is made by web before its first task.
      ['web', ['sites-writer', 'workspace-provisioner']],
      ['core', ['core-turns', 'core-transit', 'core-site-import']],
    ]) {
      expectStatus(
        await operator(`auth/approle/role/${role}`, {
          method: 'POST',
          // Unlimited uses and no expiry of the SecretID: a process logs in again whenever its
          // token expires, and a stand kept up (--keep) lives for hours.
          body: {
            token_policies: policies,
            token_no_default_policy: true,
            token_ttl: '15m',
            token_max_ttl: '1h',
            secret_id_ttl: '0',
            secret_id_num_uses: 0,
          },
        }),
        [200, 204],
        `AppRole ${role}`,
      )
      const roleId = (await operator(`auth/approle/role/${role}/role-id`)).body?.data?.role_id
      const secretId = (
        await operator(`auth/approle/role/${role}/secret-id`, { method: 'POST', body: {} })
      ).body?.data?.secret_id
      if (typeof roleId !== 'string' || typeof secretId !== 'string')
        throw new Error(`AppRole ${role} has no credentials`)
      secretValues.push(secretId)
      appRoles[role] = {
        roleId,
        secretId,
        secretIdFile: await secretFile(`${role}.secret-id`, `${secretId}\n`),
        policies,
      }
    }
    coordinates.vault.roles = Object.fromEntries(
      Object.entries(appRoles).map(([role, { roleId, secretIdFile, policies }]) => [
        role,
        { roleId, secretIdFile, policies },
      ]),
    )
    const vault = {
      address: vaultAddress,
      /** A request as the dev root token: what the operator of the stand sees. */
      operator,
      /** A token of the AppRole `web` or `core`, from a fresh login. */
      async login(role) {
        const { roleId, secretId } = appRoles[role] ?? {}
        const answer = await localVaultRequest({ address: vaultAddress }, 'auth/approle/login', {
          method: 'POST',
          body: { role_id: roleId, secret_id: secretId },
        })
        const token = answer.body?.auth?.client_token
        if (answer.status !== 200 || typeof token !== 'string')
          throw new Error(`AppRole ${role} login failed`)
        secretValues.push(token)
        return token
      },
      request: (token, path, options) =>
        localVaultRequest({ address: vaultAddress, token }, path, options),
      /** The metadata of a KV v2 path (`kv/sites/<id>/ssh`): versions and the current one. */
      async metadata(path) {
        if (!path.startsWith('kv/')) throw new Error('A path of the kv/ mount')
        const answer = await operator(`kv/metadata/${path.slice(3)}`)
        if (answer.status === 404) return null
        return expectStatus(answer, [200], 'Read KV metadata').body.data
      },
      /** The keys below a KV v2 folder (`sites`, `sites/<id>`); [] when there is none. */
      async list(folder) {
        const answer = await operator(`kv/metadata/${folder}?list=true`)
        if (answer.status === 404) return []
        return expectStatus(answer, [200], 'List KV keys').body.data.keys
      },
    }

    progress('Gitea: accounts, organization sites, teams and tokens')
    const giteaOptions = { port: ports.gitea, ca, signal }
    const gitea = (method, path, options) => giteaRequest(giteaOptions, method, path, options)
    if ((await gitea('GET', '/v1/version')).json?.version !== '1.27.3')
      throw new Error('Unexpected Gitea version')
    const account = async (user, admin = false) => {
      const result = await docker(giteaUserArgs({ run, user, admin }))
      const password = generatedGiteaPassword(result.stdout)
      secretValues.push(password)
      return { user, password }
    }
    const admin = await account('stand-admin', true)
    const bot = await account('raditi-bot')
    const provisioner = await account('raditi-provisioner')
    expectStatus(
      await gitea('POST', '/v1/orgs', {
        auth: admin,
        body: { username: 'sites', visibility: 'private' },
      }),
      [201],
      'Create the organization',
    )
    const team = async (body, member) => {
      const created = expectStatus(
        await gitea('POST', '/v1/orgs/sites/teams', { auth: admin, body }),
        [201],
        `Create the team ${body.name}`,
      )
      expectStatus(
        await gitea('PUT', `/v1/teams/${created.json.id}/members/${member}`, { auth: admin }),
        [204],
        `Add ${member} to ${body.name}`,
      )
    }
    // The bot pushes to every repository of the organization, the ones created later included.
    await team(
      {
        name: 'bots',
        permission: 'write',
        includes_all_repositories: true,
        units: ['repo.code', 'repo.pulls', 'repo.actions'],
      },
      bot.user,
    )
    // The provisioner may create repositories and nothing more; Gitea makes it an administrator
    // of each repository it creates (packages/git-providers/src/gitea-repository-provisioner.ts).
    await team(
      {
        name: 'provisioners',
        permission: 'read',
        includes_all_repositories: false,
        can_create_org_repo: true,
        units: ['repo.code'],
      },
      provisioner.user,
    )
    const token = async (holder, tokenName, scopes) => {
      const answer = expectStatus(
        await gitea('POST', `/v1/users/${holder.user}/tokens`, {
          auth: holder,
          body: { name: tokenName, scopes },
        }),
        [201],
        `Token of ${holder.user}`,
      )
      if (!/^[0-9a-f]{40}$/.test(answer.json?.sha1 ?? ''))
        throw new Error('Gitea returned no token')
      secretValues.push(answer.json.sha1)
      return answer.json.sha1
    }
    const botToken = await token(bot, 'raditi-core', ['write:user', 'write:repository'])
    const provisionerToken = await token(provisioner, 'raditi-provisioner', [
      'write:organization',
      'write:repository',
    ])
    coordinates.gitea.admin = { user: admin.user }
    coordinates.gitea.bot = {
      user: bot.user,
      tokenFile: await secretFile('gitea-bot.token', `${botToken}\n`),
    }
    coordinates.gitea.provisioner = {
      user: provisioner.user,
      tokenFile: await secretFile('gitea-provisioner.token', `${provisionerToken}\n`),
    }
    const repo = (repositoryName, rest = '') =>
      `/v1/repos/sites/${encodeURIComponent(repositoryName)}${rest}`
    const json = async (promise, what, statuses = [200]) => {
      const answer = await promise
      if (answer.status === 404) return null
      return expectStatus(answer, statuses, what).json
    }
    const gitAs = (who) =>
      gitEnvironment({
        path: process.env.PATH,
        home: file('home'),
        caPath,
        ...(who === 'provisioner'
          ? { user: provisioner.user, token: provisionerToken }
          : { user: bot.user, token: botToken }),
      })
    let gitWork = 0
    /** git in a scratch directory of the run, as the bot, against one repository. */
    const gitIn = async (repositoryName, work) => {
      const cwd = file('work', `git-${(gitWork += 1)}`)
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      try {
        await work(
          (args) => command('git', args, { env: gitAs('bot'), cwd, timeoutMs: 120_000 }),
          `${coordinates.gitea.origin}/sites/${repositoryName}.git`,
        )
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    }
    const giteaApi = {
      origin: coordinates.gitea.origin,
      /** Any request below /api, as the stand's administrator unless `auth` says otherwise. */
      request: (method, path, options = {}) => gitea(method, path, { auth: admin, ...options }),
      repository: (repositoryName) =>
        json(gitea('GET', repo(repositoryName), { auth: admin }), 'Read the repository'),
      /**
       * A branch as Gitea's database knows it; null when there is none. Gitea fills that table
       * after a push in the background and answers HTTP 500 until then: `refs` reads git itself.
       */
      branch: (repositoryName, branch = 'main') =>
        json(
          gitea('GET', repo(repositoryName, `/branches/${encodeURIComponent(branch)}`), {
            auth: admin,
          }),
          'Read the branch',
        ),
      /** Every ref (`refs/heads/…`, `refs/tags/…`) with the object it points at; [] when empty. */
      async refs(repositoryName) {
        const answer = await gitea('GET', repo(repositoryName, '/git/refs'), { auth: admin })
        // An empty repository has no refs: Gitea answers 404 or 409 for it.
        if ([404, 409].includes(answer.status)) return []
        return expectStatus(answer, [200], 'List the refs').json.map(({ ref, object }) => ({
          ref,
          sha: object.sha,
          type: object.type,
        }))
      },
      async tags(repositoryName) {
        const answer = await gitea('GET', repo(repositoryName, '/tags?limit=50'), { auth: admin })
        if ([404, 409].includes(answer.status)) return []
        return expectStatus(answer, [200], 'List the tags').json.map((tag) => ({
          name: tag.name,
          sha: tag.commit?.sha,
          id: tag.id,
        }))
      },
      commit: (repositoryName, sha) =>
        json(
          gitea('GET', repo(repositoryName, `/git/commits/${sha}`), { auth: admin }),
          'Read the commit',
        ),
      /** Every entry of a tree, recursively: `{ path, type, sha, size, mode }`. */
      async tree(repositoryName, sha) {
        const entries = []
        for (let page = 1; ; page++) {
          const answer = expectStatus(
            await gitea(
              'GET',
              repo(repositoryName, `/git/trees/${sha}?recursive=true&per_page=1000&page=${page}`),
              { auth: admin },
            ),
            [200],
            'Read the tree',
          )
          entries.push(
            ...answer.json.tree.map(({ path, type, sha: id, size, mode }) => ({
              path,
              type,
              sha: id,
              size,
              mode,
            })),
          )
          if (!answer.json.truncated || answer.json.tree.length === 0) break
        }
        return entries
      },
      /** The bytes of a file at `ref`; null when there is none. */
      async raw(repositoryName, path, ref = 'main') {
        const encoded = path.split('/').map(encodeURIComponent).join('/')
        const answer = await gitea(
          'GET',
          repo(repositoryName, `/raw/${encoded}?ref=${encodeURIComponent(ref)}`),
          { auth: admin, raw: true },
        )
        if (answer.status === 404) return null
        return expectStatus(answer, [200], 'Read a file').buffer
      },
      /** A commit through the Contents API (an empty repository gets its first branch so). */
      async createFile(
        repositoryName,
        { path, content, message = `stand: ${path}`, branch = 'main', newBranch },
      ) {
        const answer = expectStatus(
          await gitea(
            'POST',
            repo(repositoryName, `/contents/${path.split('/').map(encodeURIComponent).join('/')}`),
            {
              auth: admin,
              body: {
                content: Buffer.from(content).toString('base64'),
                message,
                branch,
                ...(newBranch ? { new_branch: newBranch } : {}),
              },
            },
          ),
          [201],
          'Create a file',
        )
        return answer.json.commit.sha
      },
      /** A lightweight tag at `target` (a commit or a branch). */
      createTag: async (repositoryName, { tag, target }) =>
        expectStatus(
          await gitea('POST', repo(repositoryName, '/tags'), {
            auth: admin,
            body: { tag_name: tag, target },
          }),
          [201],
          'Create a tag',
        ).json,
      /** A repository the way the product creates one, with the provisioner's token. */
      createRepository: async (repositoryName) =>
        expectStatus(
          await gitea('POST', '/v1/orgs/sites/repos', {
            auth: { token: provisionerToken },
            body: { name: repositoryName, private: true, auto_init: false, default_branch: 'main' },
          }),
          [201],
          'Create a repository',
        ).json,
      /**
       * Removes a tag of the repository with a git push, as a client of Gitea would: the tag API
       * only knows the tags Gitea has synced into its table, which it does after a push, later.
       */
      async deleteTag(repositoryName, tag) {
        await gitIn(repositoryName, async (git, url) => {
          await git(['init', '--quiet', '.'])
          await git(['push', '--quiet', url, `:refs/tags/${tag}`])
        })
      },
      /** Puts a lightweight tag on a commit of the repository with a git push. */
      async pushTag(repositoryName, tag, sha) {
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('A commit id')
        await gitIn(repositoryName, async (git, url) => {
          await git(['init', '--quiet', '.'])
          await git(['fetch', '--quiet', url, '+refs/heads/*:refs/remotes/origin/*'])
          await git(['push', '--quiet', url, `${sha}:refs/tags/${tag}`])
        })
      },
      /** Every repository of the organization `sites`. */
      async repositories() {
        const names = []
        for (let page = 1; ; page++) {
          const answer = expectStatus(
            await gitea('GET', `/v1/orgs/sites/repos?limit=50&page=${page}`, { auth: admin }),
            [200],
            'List the repositories',
          )
          names.push(...answer.json.map(({ name }) => name))
          if (answer.json.length < 50) break
        }
        return names.sort()
      },
      deleteRepository: async (repositoryName) =>
        expectStatus(
          await gitea('DELETE', repo(repositoryName), { auth: admin }),
          [204, 404],
          'Delete the repository',
        ),
      /** The environment of git over HTTPS as the bot (default) or the provisioner. */
      gitEnvironment: gitAs,
      /** A clone of the repository into `target` (an absolute directory that does not exist). */
      async clone(repositoryName, target, { as = 'bot' } = {}) {
        await command(
          'git',
          ['clone', '--quiet', `${coordinates.gitea.origin}/sites/${repositoryName}.git`, target],
          {
            env: gitAs(as),
            timeoutMs: 120_000,
          },
        )
        return target
      },
    }

    // ── The environments and the processes ──────────────────────────────────────────────────
    const exampleKeys = exampleKeysOf(await readFile(join(repository, '.env.example'), 'utf8'))
    const s3Settings = {
      endpoint: coordinates.s3.endpoint,
      region: coordinates.s3.region,
      accessKeyId: secrets.s3Access,
      secretAccessKey: secrets.s3Secret,
      buckets: coordinates.s3.buckets,
    }
    const env = {
      core: coreEnvironment({
        path: process.env.PATH,
        gitleaks,
        directory,
        port: ports.core,
        webOrigin: coordinates.web.origin,
        databaseUrl,
        redisUrl,
        s3: s3Settings,
        vault: {
          address: vaultAddress,
          roleId: appRoles.core.roleId,
          secretId: appRoles.core.secretId,
        },
        gitea: { origin: coordinates.gitea.origin, botToken, provisionerToken },
        caPath,
        metricsToken: secrets.metrics,
      }),
      web: webEnvironment({
        path: process.env.PATH,
        directory,
        webOrigin: coordinates.web.origin,
        databaseUrl,
        redisUrl,
        vault: {
          address: vaultAddress,
          roleId: appRoles.web.roleId,
          secretId: appRoles.web.secretId,
        },
        caPath,
        metricsToken: secrets.metrics,
        authSecret: secrets.auth,
        exampleKeys,
      }),
    }
    owned.core = coreProcess({
      env: env.core,
      port: ports.core,
      logFile: file('logs', 'core.log'),
      cwd: directory,
      metricsToken: secrets.metrics,
      signal,
      record: async (pid) => {
        corePids.push(pid)
        await writeRecord()
      },
    })

    owned.web = webProcess({
      env: env.web,
      port: ports.web,
      logFile: file('logs', 'web.log'),
      signal,
      command,
      record: async (pid, port) => {
        webPids.push({ pid, port })
        await writeRecord()
      },
    })

    const exec = (service, script, options = {}) =>
      docker(['exec', name(service), 'sh', '-c', script], { timeoutMs: 30_000, ...options })
    /** What a scenario does to one hosting, and reads of it. */
    const hosting = (service, own) => {
      const fingerprints = coordinates[service === 'site' ? 'siteServer' : 'spareServer'].hostKeys
      const ready = (what) =>
        until(
          what,
          async () =>
            (await banner(own.ssh)).startsWith('SSH-2.0-') &&
            (await banner(own.ftp)).startsWith('220'),
          { signal, timeoutMs: 30_000 },
        )
      const logs = async () => {
        const answer = await docker(['logs', name(service)], { timeoutMs: 15_000 })
        return redact(`${answer.stdout}${answer.stderr}`)
      }
      return {
        service,
        container: name(service),
        /** The host key sshd presents from now on: `first` (at start) or `second` (a changed key). */
        async useHostKey(which) {
          if (!['first', 'second'].includes(which)) throw new Error('first or second')
          await docker(['exec', name(service), '/opt/stand/use-host-key.sh', which])
          // sshd re-executes itself: its banner answers again once the new key is loaded.
          await until(
            'sshd with the new host key',
            async () => (await banner(own.ssh)).startsWith('SSH-2.0-'),
            { signal, timeoutMs: 20_000 },
          )
          return fingerprints[which]
        },
        /**
         * Every entry of the hosting home with its type, size, mode and SHA-256: compare two of
         * them to prove a check or an import wrote nothing there.
         */
        snapshot: async () =>
          (
            await exec(
              service,
              "cd /home/site && find . -exec stat -c '%n %F %s %a %Y' {} + | sort && find . -type f -exec sha256sum {} + | sort",
            )
          ).stdout,
        logs,
        /** How many times sshd let `user` in so far («Accepted … for <user>»). */
        async logins(user) {
          if (!/^[a-z]+$/.test(user)) throw new Error('Invalid hosting user')
          return (await logs())
            .split('\n')
            .filter((line) => new RegExp(`Accepted \\S+ for ${user} from`).test(line)).length
        },
        /** A new password of an account, through chpasswd's stdin. */
        async setPassword(user, password) {
          if (!['site', 'ftpsite', ...EXTRA_SSH_USERS].includes(user))
            throw new Error('Not an account of the hosting')
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(password)) throw new Error('Invalid password')
          secretValues.push(password)
          await docker(['exec', '-i', name(service), 'chpasswd'], {
            input: `${user}:${password}\n`,
          })
        },
        /** Frozen: connections are accepted and never answered. */
        pause: () => docker(['pause', name(service)]),
        unpause: async () => {
          await docker(['unpause', name(service)])
          await ready('the hosting after the pause')
        },
        /** Stopped: its ports refuse. The published ports stay the same after the start. */
        stopContainer: () => docker(['stop', '--time', '5', name(service)], { timeoutMs: 30_000 }),
        startContainer: async () => {
          await docker(['start', name(service)])
          await ready('the hosting after the start')
        },
      }
    }
    const siteServer = hosting('site', ports)
    const spareServer = hosting('spare', sparePorts)
    const siteDatabases = {
      mysql: {
        /** What the user `stand` sent, from the general log: `{ at, command, argument }`. */
        async statements() {
          const answer = await exec(
            'mysql',
            'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root -N -B -e "SELECT event_time, command_type, CONVERT(argument USING utf8mb4) FROM mysql.general_log WHERE user_host LIKE \'stand[%\' ORDER BY event_time"',
          )
          return answer.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [at, type, ...rest] = line.split('\t')
              return { at, command: type, argument: rest.join('\t') }
            })
        },
      },
      postgres: {
        /** Every statement the server logged (log_statement=all), in order. */
        async statements() {
          const answer = await docker(['logs', name('sitepg')], { timeoutMs: 15_000 })
          return `${answer.stdout}\n${answer.stderr}`.split('\n').flatMap((line) => {
            const match = /LOG: {2}(?:statement|execute [^:]*): (.*)$/.exec(line)
            return match ? [match[1]] : []
          })
        },
      },
    }
    const db = {
      pool: owned.db,
      query: (text, params) => owned.db.query(text, params),
    }
    progress('ready')
    return {
      run,
      env,
      coordinates,
      caPath,
      logsDir: file('logs'),
      directory,
      /** What the scenarios type into the wizard. */
      secrets: {
        site: {
          user: 'site',
          password: values.sshPassword,
          privateKey: userKey.privateKey,
          keyWithPassphrase: {
            privateKey: userKeyWithPassphrase.privateKey,
            passphrase: values.keyPassphrase,
          },
        },
        ftpsite: { user: 'ftpsite', password: values.ftpPassword },
        siteb: {
          user: 'siteb',
          password: values.sitebPassword,
          newPassword: values.sitebNewPassword,
        },
        sitec: { user: 'sitec', password: values.sitecPassword },
        mysql: {
          user: SITE_DATABASES.mysql.user,
          password: values.databasePassword,
          database: SITE_DATABASES.mysql.database,
        },
        postgres: {
          user: SITE_DATABASES.postgres.user,
          password: values.postgresPassword,
          database: SITE_DATABASES.postgres.database,
        },
        metricsToken: secrets.metrics,
      },
      fixture: {
        values,
        tree,
        manifest: importManifest(values),
        expected: (auth) => expectedImport(values, { auth }),
        gitleaksFindings: gitleaksFindings(values),
        siteHome: file('site-home'),
      },
      tools: { gitleaks },
      vault,
      giteaApi,
      db,
      core: owned.core,
      web: owned.web,
      siteServer,
      spareServer,
      siteDatabases,
      /** `docker logs` of one service of the stand, redacted. */
      containerLogs: async (service) => {
        const answer = await docker(['logs', '--tail', '400', name(service)], {
          timeoutMs: 15_000,
          allowFailure: true,
        })
        return redact(`${answer.stdout}${answer.stderr}`)
      },
      redact,
      /** Every secret value of the run, for the scans of what it left behind. */
      secretValues: () => [...secretValues],
      /** The passwords of the hostings' accounts, the one a later scenario sets included. */
      hostingPasswords: () => [
        values.sshPassword,
        values.ftpPassword,
        values.sitebPassword,
        values.sitebNewPassword,
        values.sitecPassword,
      ],
      /** The Docker CLI of the stand: its socket, its environment. */
      docker: (args, options = {}) => docker(args, options),
      /** Something the scenarios started that the stop of the stand closes first. */
      closeLater: (close) => owned.later.push(close),
      stage: () => stage,
      stop,
    }
  } catch (error) {
    const failure = new Error(
      `The site-import stand failed at ${stage}: ${redact(error?.message ?? 'unknown')}`,
    )
    // What the failed command and every container said, for a private diagnostic only.
    const said = [String(error?.stack ?? ''), String(error?.verificationOutput ?? '')]
    for (const container of owned.containers) {
      const answer = await docker(['logs', '--tail', '200', container], {
        cleanup: true,
        allowFailure: true,
        timeoutMs: 10_000,
      }).catch(() => null)
      if (answer) said.push(`--- ${container}\n${answer.stdout}${answer.stderr}`)
    }
    failure.verificationOutput = redact(said.join('\n'))
    await stop().catch((cleanup) => {
      failure.cleanup = cleanup.message
    })
    throw failure
  }
}
