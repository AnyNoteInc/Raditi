// Pure parts of the browser-task stand (verify-browser-task.mjs, docs/plan/57-browser-tasks.md §5):
// its options, the names of everything a run owns, the images it builds, the environments of the
// processes it starts, the synthetic WordPress it serves under its own name and the accounts of
// that site. Nothing here touches Docker, the network or a file.
import { isAbsolute } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

import { MARIADB_IMAGE, WORDPRESS_IMAGE, WPCLI_IMAGE } from '../release-verify/stand.mjs'

export { MARIADB_IMAGE, WORDPRESS_IMAGE, WPCLI_IMAGE }

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * `--no-build` reuses the private build copy and the images of an earlier run (refused when the
 * tree has changed since); `--keep` leaves the stand up after the scenarios until Ctrl-C;
 * `--web-dev` runs web as `next dev` of the copy instead of its `next build` (a tree whose web
 * does not build yet); `--stream-only` leaves the cabinet out (the client acts over the stream
 * alone, as its canvas would); `--only a,b` runs the named scenarios alone (the ones they need
 * first).
 * Nothing names a database, a site or an address: the stand works only on what it started.
 */
export function standOptions(argv) {
  const options = { build: true, keep: false, webDev: false, streamOnly: false, only: null }
  const args = argv.filter((value) => value !== '--')
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--no-build') options.build = false
    else if (arg === '--keep') options.keep = true
    else if (arg === '--web-dev') options.webDev = true
    else if (arg === '--stream-only') options.streamOnly = true
    else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? args[++index] : arg.slice('--only='.length)
      const ids = String(value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      for (const id of ids)
        if (!SCENARIO_IDS.includes(id)) throw new Error(`Unknown scenario ${id}`)
      if (ids.length === 0) throw new Error('--only names at least one scenario')
      options.only = ids
    } else
      throw new Error(
        'This stand accepts --no-build, --keep, --web-dev, --stream-only and --only only; it takes no database, site, address or key',
      )
  }
  return options
}

/**
 * The scenarios in their order (README, «Сценарии»), and what each needs to have run first: a
 * later one works in the site, the task and the session an earlier one left.
 */
export const SCENARIO_IDS = Object.freeze([
  'A',
  'D',
  'B',
  'C',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
])
const NEEDS = Object.freeze({
  A: [],
  D: ['A'],
  B: ['A', 'D'],
  C: ['A', 'D'],
  E: ['A', 'D'],
  F: ['A', 'D', 'E'],
  G: ['A'],
  H: ['A'],
  I: ['A'],
  J: ['A'],
  K: ['A'],
  L: ['A'],
  M: ['A'],
})

/** The scenarios a run goes through: all of them, or the named ones with what they need. */
export function scenariosToRun(only) {
  if (only === null) return [...SCENARIO_IDS]
  const wanted = new Set()
  const add = (id) => {
    for (const need of NEEDS[id]) add(need)
    wanted.add(id)
  }
  for (const id of only) add(id)
  return SCENARIO_IDS.filter((id) => wanted.has(id))
}

// ─── Names ────────────────────────────────────────────────────────────────────

/** Every container, network and volume of a run carries `io.raditi.browser-task-verify=<run>`. */
export const STAND_LABEL = 'io.raditi.browser-task-verify'
const RUN = /^[0-9a-f]{8}$/

export const CONTAINERS = Object.freeze([
  'postgres',
  'redis',
  's3',
  'openbao',
  'site-db',
  'site-web',
])

/** Every resource of one run by name; nothing outside these names is created or removed by name. */
export function standNames(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id of the stand')
  const stand = `raditi-browser-task-verify-${run}`
  return {
    run,
    stand,
    label: `${STAND_LABEL}=${run}`,
    containers: Object.fromEntries(CONTAINERS.map((name) => [name, `${stand}-${name}`])),
    // The synthetic site's own network: its database and its web server.
    network: `${stand}-site`,
    volumes: { docroot: `${stand}-docroot` },
  }
}

/**
 * The images the stand builds from this tree under names of its own: the sandbox of a turn with
 * its gateway and guard, and the three containers of a browser session (the browser of the
 * previews, the forwarder of their tools image, the egress proxy). `file` and `target` as
 * `docker build -f <file> --target <target>`; the context is the root of the repository unless
 * `context` names a folder of it.
 */
export const BUILT_IMAGES = Object.freeze({
  sandbox: {
    tag: 'raditi-browser-task-verify/sandbox:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'runtime',
  },
  gateway: {
    tag: 'raditi-browser-task-verify/gateway:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'gateway',
  },
  guard: {
    tag: 'raditi-browser-task-verify/network-guard:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'network-guard',
  },
  egress: {
    tag: 'raditi-browser-task-verify/client-egress:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'client-egress',
  },
  tools: {
    tag: 'raditi-browser-task-verify/preview-tools:local',
    file: 'infra/preview/Dockerfile',
    target: 'tools',
    context: 'infra/preview',
  },
  browser: {
    tag: 'raditi-browser-task-verify/preview-browser:local',
    file: 'infra/preview/Dockerfile',
    target: 'browser',
    context: 'infra/preview',
  },
})

/**
 * The builds of the private copy, in order: the dependencies, the Prisma client, the six apps of
 * the platform this stand runs (turbo builds the packages they need first), then web.
 */
export const BUILD_STEPS = Object.freeze([
  { title: 'install dependencies', args: ['install', '--frozen-lockfile', '--prefer-offline'] },
  {
    title: 'generate the Prisma client',
    args: ['--filter', '@repo/db', 'db:generate'],
    // prisma.config.ts reads DATABASE_URL; generate never connects.
    env: { DATABASE_URL: 'postgresql://build@localhost/build' },
  },
  {
    title: 'build core, llm, mcp, preview and browser',
    // One at a time: each build script builds @repo/service-runtime first.
    args: [
      ...['--workspace-concurrency=1', '--filter', 'core', '--filter', 'llm', '--filter', 'mcp'],
      ...['--filter', 'preview', '--filter', 'browser', 'build'],
    ],
  },
])
export const WEB_BUILD_STEP = Object.freeze({
  title: 'build web',
  args: ['--filter', 'web', 'build'],
})
/** What the steps leave and the run starts. */
export const APP_OUTPUTS = Object.freeze([
  'apps/core/dist/main.js',
  'apps/llm/dist/main.js',
  'apps/mcp/dist/main.js',
  'apps/preview/dist/main.js',
  'apps/browser/dist/main.js',
])
export const WEB_OUTPUT = Object.freeze({
  server: 'apps/web/.next/standalone/apps/web/server.js',
  static: 'apps/web/.next/static',
  staticServed: 'apps/web/.next/standalone/apps/web/.next/static',
})

// ─── The synthetic site ───────────────────────────────────────────────────────

/**
 * The site of the stand: WordPress 7.x (block editor) under an exact name of its own, which no
 * DNS knows. The browser of a task reaches it only through the session's egress proxy, which
 * maps this origin to the published port of the site (BROWSER_LOCAL_SITES, Б11): the same
 * Host header the site was installed with.
 */
export const SITE_HOST = 'wp.raditi.test'
export const SITE_ORIGIN = `http://${SITE_HOST}`

/** The accounts of the synthetic site; their passwords are generated per run. */
export const SITE_ACCOUNTS = Object.freeze({
  /** The owner of the site: an editor who may publish and upload. */
  owner: { login: 'anna-redaktor', role: 'editor', email: 'anna@example.test' },
  /** A contributor: may write and submit for review, never publish or upload (scenario H). */
  contributor: { login: 'boris-avtor', role: 'contributor', email: 'boris@example.test' },
})

/**
 * What wp-config.php gets besides the database: no cron of WordPress (its loopback requests would
 * go to a name nothing resolves), no request of PHP outside the site (no update checks, no
 * Gravatar from the server), a local environment, no automatic updates.
 */
export const SITE_CONFIG_EXTRA = [
  "define('DISABLE_WP_CRON', true);",
  "define('WP_ENVIRONMENT_TYPE', 'local');",
  "define('WP_HTTP_BLOCK_EXTERNAL', true);",
  "define('AUTOMATIC_UPDATER_DISABLED', true);",
  "define('WP_AUTO_UPDATE_CORE', false);",
].join(' ')

/**
 * The folders of the site's container the stand reads and the fixture's must-use plugins write,
 * outside the document root: the cookie values the site set (to look for them where they must
 * never be) and the switches of the refusals of scenarios I and J.
 */
export const STAND_STATE_DIR = '/var/stand'
export const SWITCH = Object.freeze({
  /** Uploads of PDF files above UPLOAD_LIMIT_BYTES are refused while this file exists. */
  uploadLimit: `${STAND_STATE_DIR}/switches/limit-pdf-uploads`,
  /** The next publish through the REST API is held PUBLISH_DELAY_SECONDS; the file is then removed. */
  publishDelay: `${STAND_STATE_DIR}/switches/delay-next-publish`,
})
export const COOKIE_TAP = `${STAND_STATE_DIR}/cookies/values.txt`
export const UPLOAD_LIMIT_BYTES = 20 * 1024
export const PUBLISH_DELAY_SECONDS = 30

// ─── Containers ───────────────────────────────────────────────────────────────

const loopbackPort = (port) => {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Invalid port')
  return port
}
const created = (names, service, extra = []) => [
  ...['run', '-d', '--pull', 'never', '--name', names.containers[service]],
  ...['--label', names.label, ...extra],
]
const envFileOf = (file) => {
  if (typeof file !== 'string' || !isAbsolute(file))
    throw new Error('The env file of a container is an absolute path')
  return ['--env-file', file]
}

/** The database of the synthetic site: MariaDB on the site's network only. */
export function siteDbArgs({ names, envFile }) {
  return [
    ...created(names, 'site-db', ['--network', names.network, '--network-alias', 'db']),
    ...envFileOf(envFile),
    MARIADB_IMAGE,
  ]
}
export const siteDbEnvFile = (password) =>
  [
    'MARIADB_DATABASE=wordpress',
    'MARIADB_USER=wordpress',
    `MARIADB_PASSWORD=${password}`,
    'MARIADB_RANDOM_ROOT_PASSWORD=1',
    '',
  ].join('\n')

export const siteWebEnvFile = (password) =>
  [
    'WORDPRESS_DB_HOST=db',
    'WORDPRESS_DB_USER=wordpress',
    `WORDPRESS_DB_PASSWORD=${password}`,
    'WORDPRESS_DB_NAME=wordpress',
    `WORDPRESS_CONFIG_EXTRA=${SITE_CONFIG_EXTRA}`,
    '',
  ].join('\n')

/**
 * The web server of the synthetic site on a published loopback port: the egress proxy of a
 * browser session reaches it there through host.docker.internal (Docker Desktop carries that
 * name to the loopback of the Mac).
 */
export function siteWebArgs({ names, port, envFile }) {
  return [
    ...created(names, 'site-web', ['--network', names.network]),
    ...['--mount', `type=volume,src=${names.volumes.docroot},dst=/var/www/html`],
    ...['-p', `127.0.0.1:${loopbackPort(port)}:80`, ...envFileOf(envFile)],
    WORDPRESS_IMAGE,
  ]
}

/** WP-CLI on the site's network as the web server's user, over the same document root. */
export function wpCliArgs({ names, envFile, args, input = false }) {
  return [
    ...['run', '--rm', ...(input ? ['-i'] : []), '--pull', 'never', '--label', names.label],
    ...['--network', names.network, '--user', '33:33', ...envFileOf(envFile)],
    ...['--mount', `type=volume,src=${names.volumes.docroot},dst=/var/www/html`],
    WPCLI_IMAGE,
    'wp',
    ...args,
  ]
}

// ─── Processes ────────────────────────────────────────────────────────────────

const sandboxed = ({ path, directory }) => ({
  PATH: path,
  HOME: `${directory}/home`,
  TMPDIR: `${directory}/tmp`,
})
const origin = (port) => `http://127.0.0.1:${loopbackPort(port)}`

/** The buckets of the platform (spec §14). */
export const BUCKETS = Object.freeze({
  inbox: 'raditi-inbox',
  sessions: 'raditi-sessions',
  logs: 'raditi-logs',
  artifacts: 'raditi-artifacts',
  backups: 'raditi-backups',
  platform: 'raditi-platform',
})
const s3Of = (s3, buckets = Object.keys(BUCKETS)) => ({
  S3_ENDPOINT: s3.endpoint,
  S3_REGION: 'us-east-1',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: s3.accessKey,
  S3_SECRET_ACCESS_KEY: s3.secretKey,
  ...Object.fromEntries(buckets.map((name) => [`S3_BUCKET_${name.toUpperCase()}`, BUCKETS[name]])),
})
const vaultOf = (vault, role) => ({
  VAULT_ADDR: vault.address,
  VAULT_ROLE_ID: role.roleId,
  VAULT_SECRET_ID: role.secretId,
})
/** The worker of the browser as core, mcp and the stream gateway reach it. */
const workerOf = (ports, secrets) => ({
  BROWSER_WORKER_URL: origin(ports.browser),
  BROWSER_WORKER_TOKEN: secrets.workerToken,
})

/**
 * The local site of the stand as the worker's egress proxies reach it: the exact origin of the
 * site to the address of its web server on Docker's default bridge (Б11, outside production only).
 */
export function localSites(target) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(String(target)))
    throw new Error('The target of the local site is an IPv4 address and a port')
  return JSON.stringify({ [SITE_ORIGIN]: target })
}

/**
 * The environment of one app of the platform (`node dist/main.js` of the build copy).
 * NODE_ENV=production keeps it from looking for a `.env`; APP_ENV is `test`. Core has no git
 * at all (no GITEA_*, no GIT_*): a task in the browser needs none (Б7).
 */
export function appEnvironment(app, context) {
  const { path, directory, ports, databaseUrl, vault, roles, s3, secrets } = context
  const base = {
    ...sandboxed({ path, directory }),
    NODE_ENV: 'production',
    NO_COLOR: '1',
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
    METRICS_TOKEN: secrets.metrics,
  }
  switch (app) {
    case 'llm':
      return {
        ...base,
        ...vaultOf(vault, roles.llm),
        LLM_GATEWAY_PORT: String(loopbackPort(ports.llm)),
        LLM_GATEWAY_LISTEN_HOST: '127.0.0.1',
        LLM_GATEWAY_CLIENTS: '127.0.0.1/32',
        LLM_GATEWAY_HOSTS: `host.docker.internal:${ports.llm},127.0.0.1:${ports.llm}`,
        LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${loopbackPort(ports.zai)}`,
        LLM_UPSTREAM_CA_FILE: context.caFile,
        // A turn of the scripted model calls a tool every second or so (observe, act, observe):
        // more than the 20 calls of a key in 30 s that suit a model which thinks between them.
        LLM_MAX_CALLS_PER_KEY_30S: '90',
      }
    case 'mcp':
      return {
        ...base,
        ...vaultOf(vault, roles.mcp),
        ...workerOf(ports, secrets),
        MCP_PORT: String(loopbackPort(ports.mcp)),
        // What sandbox-gw rewrites Host to: the role accepts nothing else.
        MCP_ALLOWED_HOSTS: 'host.docker.internal',
      }
    case 'preview':
      return {
        ...base,
        ...workerOf(ports, secrets),
        // The gateway of previews is the public gateway of the platform; this stand builds no
        // preview, but the app needs its address to start.
        PREVIEW_BASE_DOMAIN: 'localhost',
        PREVIEW_SCHEME: 'http',
        PREVIEW_PUBLIC_PORT: String(loopbackPort(ports.preview)),
        PREVIEW_GATEWAY_PORT: String(loopbackPort(ports.preview)),
        PREVIEW_GATEWAY_HOST: '127.0.0.1',
        PREVIEW_SESSION_SECRET: secrets.previewSession,
        APP_URL: origin(ports.web),
        BROWSER_STREAM_PORT: String(loopbackPort(ports.stream)),
        BROWSER_STREAM_HOST: '127.0.0.1',
      }
    case 'browser':
      return {
        ...base,
        ...s3Of(s3, ['inbox']),
        BROWSER_WORKER_HOST: '127.0.0.1',
        BROWSER_WORKER_PORT: String(loopbackPort(ports.browser)),
        BROWSER_WORKER_TOKEN: secrets.workerToken,
        BROWSER_RUNTIME: 'runc',
        BROWSER_DOCKER_SOCKET: context.socket,
        BROWSER_IMAGE: context.images.browser,
        BROWSER_FORWARDER_IMAGE: context.images.tools,
        BROWSER_EGRESS_IMAGE: context.images.egress,
        BROWSER_LOCAL_SITES: localSites(context.siteTarget),
      }
    case 'core':
      return {
        ...base,
        ...vaultOf(vault, roles.core),
        ...s3Of(s3),
        ...workerOf(ports, secrets),
        APP_URL: origin(ports.web),
        CORE_PORT: String(loopbackPort(ports.core)),
        REDIS_URL: context.redisUrl,
        LLM_CONTROL_URL: origin(ports.llm),
        TURN_EXECUTOR: 'local',
        // Every turn in a container of its own, as the scenarios count them: no warm sandbox.
        SANDBOX_WARM_MINUTES: '0',
        SANDBOX_RUNTIME: 'runc',
        SANDBOX_DOCKER_SOCKET: context.socket,
        SANDBOX_IMAGE: context.images.sandbox,
        SANDBOX_GATEWAY_IMAGE: context.images.gateway,
        SANDBOX_NETWORK_GUARD_IMAGE: context.images.guard,
        SANDBOX_LLM_UPSTREAM: `http://host.docker.internal:${ports.llm}`,
        SANDBOX_MCP_UPSTREAM: `http://host.docker.internal:${ports.mcp}`,
        BROWSER_SESSION_MAX_HOURS: '4',
      }
    default:
      throw new Error(`Unknown app ${app}`)
  }
}

/** The names of the apps' environments that must stay unset: core runs without git (Б7). */
export const CORE_WITHOUT = Object.freeze([
  'GITEA_URL',
  'GITEA_TOKEN',
  'GITEA_PROVISIONER_TOKEN',
  'GIT_CA_FILE',
  'GIT_MIRROR_DIR',
  'PREVIEW_BASE_DOMAIN',
])

/**
 * The environment of web: the standalone server of `next build` (or `next dev` of the copy with
 * `--web-dev`), the stream of the browser at the stream gateway of the preview app.
 */
export function webEnvironment(context, { dev = false } = {}) {
  const { path, directory, ports, databaseUrl, vault, roles, s3, secrets } = context
  return {
    ...sandboxed({ path, directory }),
    ...(dev ? {} : { NODE_ENV: 'production' }),
    NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1',
    PORT: String(loopbackPort(ports.web)),
    APP_ENV: 'test',
    APP_URL: origin(ports.web),
    BETTER_AUTH_URL: origin(ports.web),
    BETTER_AUTH_SECRET: secrets.auth,
    DATABASE_URL: databaseUrl,
    REDIS_URL: context.redisUrl,
    METRICS_TOKEN: secrets.metrics,
    BROWSER_STREAM_PUBLIC_URL: `ws://127.0.0.1:${loopbackPort(ports.stream)}/v1/browser/stream`,
    ...s3Of(s3, ['inbox', 'artifacts']),
    ...vaultOf(vault, roles.web),
  }
}

/** An operator command (scripts of the copy), given its environment. */
export function operatorEnvironment(context) {
  const { path, directory, databaseUrl, vault, ports } = context
  return {
    ...sandboxed({ path, directory }),
    APP_ENV: 'test',
    DATABASE_URL: databaseUrl,
    VAULT_ADDR: vault.address,
    LLM_UPSTREAM_CA_FILE: context.caFile,
    LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${loopbackPort(ports.zai)}`,
  }
}

// ─── Files of a task ──────────────────────────────────────────────────────────

/** A PNG of one colour, `width`×`height`, valid and small: what the client attaches. */
export function solidPng(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A file named and typed as a JPEG whose bytes are text: the upload must refuse it. */
export const FAKE_JPEG = Buffer.from('Это не картинка, а текст под видом JPEG.\n', 'utf8')

/**
 * A one-page PDF with a padding comment, `padding` bytes long: above UPLOAD_LIMIT_BYTES it is
 * the file scenario I's site refuses.
 */
export function syntheticPdf(title, padding = 0) {
  const lines = [
    '%PDF-1.4',
    '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
    '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
    '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]>> endobj',
    `% ${title}`,
    `% ${'x'.repeat(padding)}`,
    'trailer <</Root 1 0 R>>',
    '%%EOF',
    '',
  ]
  return Buffer.from(lines.join('\n'), 'latin1')
}

// ─── Billing ──────────────────────────────────────────────────────────────────

/** The stand rates of the profile, ₽ per million tokens with VAT (as the release stand). */
export const STAND_RATES = Object.freeze({
  inputPer1m: '10.000000',
  cacheReadPer1m: '1.000000',
  cacheWritePer1m: null,
  outputPer1m: '30.000000',
  vatRate: '0.2200',
})
export const STAND_PROFILES = Object.freeze(['glm-5.3-standard', 'glm-5.3-heavy'])
export const STAND_RUB_PER_CREDIT = '6.00'

export function standRatesFile() {
  return {
    rubPerCredit: STAND_RUB_PER_CREDIT,
    basis:
      'Стенд задач в браузере: синтетические ставки профилей и предварительный курс кредита проекта кредитов, не утверждены.',
    prices: STAND_PROFILES.map((model) => ({
      provider: 'zai-coding',
      model,
      ...STAND_RATES,
      sourceUrl: 'https://synthetic.invalid/browser-task-verify-rates',
    })),
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

/** The final table: one row per scenario with its checks and its NOTE lines (none is a check). */
export function summaryTable(rows) {
  const lines = ['| Сценарий | Проверок | Итог |', '| --- | --- | --- |']
  for (const row of rows)
    lines.push(
      `| ${row.id} ${row.title} | ${row.checks}${row.notes ? ` (NOTE: ${row.notes})` : ''} | ${row.ok ? 'PASS' : 'FAIL'} |`,
    )
  return lines.join('\n')
}

/** Every value of `secrets` (6+ characters) that occurs in `text`, by its name: none is right. */
export function leakedIn(text, secrets) {
  const found = []
  for (const [name, value] of Object.entries(secrets))
    if (typeof value === 'string' && value.length >= 6 && text.includes(value)) found.push(name)
  return found
}
