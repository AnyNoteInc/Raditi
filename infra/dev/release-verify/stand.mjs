// Pure parts of the release stand (verify-release.mjs): its options, the names of everything a
// run owns, the arguments of its containers, the configuration of the deploy runner and of the
// loopback mirror the runner's jobs see the host through, the environments of the processes it
// starts, the files of the synthetic production site and the answers of the scripted model.
// Nothing here touches Docker, the network or a file.
import { isAbsolute } from 'node:path'

import { POSTGRES_IMAGE, REDIS_IMAGE } from '../billing-verify/stand.mjs'
import {
  GITEA_IMAGE,
  HOSTING_IMAGE,
  OPENBAO_IMAGE,
  REPOSITORY_WORKFLOWS_OFF,
  RUNNER_IMAGE,
} from '../pipeline-verify/stand.mjs'

export { GITEA_IMAGE, HOSTING_IMAGE, OPENBAO_IMAGE, POSTGRES_IMAGE, REDIS_IMAGE, RUNNER_IMAGE }

/** SeaweedFS of infra/dev and of the agent-content stand, by digest. Never pulled. */
export const S3_IMAGE =
  'chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882'
/**
 * The synthetic production site and the images of its previews: the ones of `.env.example`
 * (PREVIEW_WEB_IMAGES, PREVIEW_DB_IMAGE, PREVIEW_CLI_IMAGE), by digest. Never pulled.
 */
export const WORDPRESS_IMAGE =
  'wordpress@sha256:8ae73d594a154e30b112e8d085afbc0895acf7651d8f53ef63aefb42e30822d5'
export const MARIADB_IMAGE =
  'mariadb@sha256:70cc072b29b4a89ae07abb2d4da2c64678a7f2dfe092751bb51c87d67dc1338b'
export const WPCLI_IMAGE =
  'wordpress@sha256:2b5e9d4d3e51909dca1aaa4732e9f5e5bf0377c2114dbd8ff39f060bff202586'
/** The tags the pinned digests above were pulled by: `docker pull <tag>` before the first run. */
export const PULLED_TAGS = Object.freeze({
  [WORDPRESS_IMAGE]: 'wordpress:7.1.2-php8.3-apache',
  [MARIADB_IMAGE]: 'mariadb:11.4.13',
  [WPCLI_IMAGE]: 'wordpress:cli-php8.3',
  [S3_IMAGE]: 'chrislusf/seaweedfs:4.47',
})

/**
 * The images the stand builds from this tree, under names of its own: no shared tag is moved.
 * `file` and `target` as `docker build -f <file> --target <target>`; the context is the root of
 * the repository unless `context` names another folder of it.
 */
export const BUILT_IMAGES = Object.freeze({
  sandbox: {
    tag: 'raditi-release-verify/sandbox:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'runtime',
  },
  gateway: {
    tag: 'raditi-release-verify/gateway:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'gateway',
  },
  guard: {
    tag: 'raditi-release-verify/network-guard:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'network-guard',
  },
  egress: {
    tag: 'raditi-release-verify/client-egress:local',
    file: 'infra/sandbox/Dockerfile',
    target: 'client-egress',
  },
  tools: {
    tag: 'raditi-release-verify/preview-tools:local',
    file: 'infra/preview/Dockerfile',
    target: 'tools',
    context: 'infra/preview',
  },
  browser: {
    tag: 'raditi-release-verify/preview-browser:local',
    file: 'infra/preview/Dockerfile',
    target: 'browser',
    context: 'infra/preview',
  },
  // The image of the deploy runner's label `deploy` and of the stand's loopback mirror.
  core: {
    tag: 'raditi-release-verify/core:local',
    file: 'apps/core/Dockerfile',
    target: 'runtime',
  },
})

/** `repository@sha256:…`: how the configuration names an image, never by a tag. */
export const DIGEST_REFERENCE = /^[a-z0-9][a-z0-9._/-]{0,199}@sha256:[a-f0-9]{64}$/

/** The image reference of a local build, from `docker image inspect --format {{json .RepoDigests}}`. */
export function localDigestReference(tag, inspected) {
  const repository = tag.replace(/:[^/:]+$/, '')
  let digests
  try {
    digests = JSON.parse(inspected)
  } catch {
    throw new Error(`No digest of ${tag}`)
  }
  const own = Array.isArray(digests)
    ? digests.find((digest) => typeof digest === 'string' && digest.startsWith(`${repository}@`))
    : undefined
  if (!own || !DIGEST_REFERENCE.test(own))
    throw new Error(`No digest of ${tag}: the stand needs the containerd image store`)
  return own
}

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * `--no-build` reuses the private build copy and the images of an earlier run, and is refused
 * when the tree has changed since; `--keep` leaves the stand up after the last scenario until
 * it is interrupted. Nothing names a database, a Gitea or an address: the stand works only on
 * what it started itself.
 */
export function standOptions(argv) {
  const options = { build: true, keep: false }
  for (const arg of argv.filter((value) => value !== '--')) {
    if (arg === '--no-build') options.build = false
    else if (arg === '--keep') options.keep = true
    else
      throw new Error(
        'This stand accepts --no-build and --keep only; it takes no database, Gitea, address or key',
      )
  }
  return options
}

// ─── Names ────────────────────────────────────────────────────────────────────

/** Every container of a run carries `io.raditi.release-verify=<run>`. */
export const STAND_LABEL = 'io.raditi.release-verify'
const RUN = /^[0-9a-f]{8}$/

export const CONTAINERS = Object.freeze([
  'postgres',
  'redis',
  's3',
  'openbao',
  'gitea',
  'mirror',
  'runner',
  'site-db',
  'site-web',
  'hosting',
])

/** Every resource of one run by name; nothing outside these names is created or removed by name. */
export function standNames(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id of the stand')
  const stand = `raditi-release-verify-${run}`
  return {
    run,
    stand,
    label: `${STAND_LABEL}=${run}`,
    containers: Object.fromEntries(CONTAINERS.map((name) => [name, `${stand}-${name}`])),
    // The production site's own network: its database, its web server and its hosting.
    network: `${stand}-site`,
    volumes: {
      // The document root of the production site: its web server, its hosting and WP-CLI.
      docroot: `${stand}-docroot`,
      // The stand's CA for the deploy jobs: they check the certificate of Gitea.
      ca: `${stand}-ca`,
    },
  }
}

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

/** PostgreSQL: data in memory, the platform's one user `raditi`, a loopback port. */
export function postgresArgs({ names, envFile }) {
  return [
    ...created(names, 'postgres'),
    ...['--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432', ...envFileOf(envFile)],
    POSTGRES_IMAGE,
  ]
}
export const postgresEnvFile = (password) =>
  `POSTGRES_USER=raditi\nPOSTGRES_DB=raditi\nPOSTGRES_PASSWORD=${password}\n`

/** Redis of BullMQ: nothing on disk, keys never evicted (infra/dev, infra/app). */
export function redisArgs({ names, envFile }) {
  return [
    ...created(names, 'redis'),
    ...['-p', '127.0.0.1::6379', ...envFileOf(envFile)],
    REDIS_IMAGE,
    ...['sh', '-c'],
    'exec redis-server --save "" --appendonly no --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"',
  ]
}
export const redisEnvFile = (password) => `REDIS_PASSWORD=${password}\n`

/** The buckets of the platform (spec §14), all of them: core reaches each. */
export const BUCKETS = Object.freeze({
  inbox: 'raditi-inbox',
  sessions: 'raditi-sessions',
  logs: 'raditi-logs',
  artifacts: 'raditi-artifacts',
  backups: 'raditi-backups',
  platform: 'raditi-platform',
})

/** The S3 identity file of SeaweedFS: one identity of the run. */
export function s3Identities({ accessKey, secretKey }) {
  return JSON.stringify({
    identities: [
      {
        name: 'raditi-release-verify',
        credentials: [{ accessKey, secretKey }],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
    ],
  })
}

/** SeaweedFS: data on a tmpfs, the identity copied in before the start, S3 on a loopback port. */
export function s3Args({ names, port }) {
  return [
    ...['create', '--pull', 'never', '--name', names.containers.s3, '--label', names.label],
    ...['--tmpfs', '/data:rw,size=2g', '-p', `127.0.0.1:${loopbackPort(port)}:8333`],
    S3_IMAGE,
    ...['server', '-dir=/data', '-s3', '-s3.port=8333', '-s3.config=/stand/s3.json'],
    // Small volumes, many of them: each bucket is a collection with volumes of its own, and the
    // defaults (30 GB a volume) leave none writable on a tmpfs.
    ...['-master.volumeSizeLimitMB=64', '-volume.max=128'],
  ]
}

const openbaoConfig = `disable_mlock = true
storage "inmem" {}
listener "tcp" {
  address = "0.0.0.0:8200"
  tls_disable = true
}
`

/** OpenBao: a regular in-memory server, initialised through its API by the stand. */
export function openbaoArgs({ names, port }) {
  return [
    ...created(names, 'openbao'),
    ...['-p', `127.0.0.1:${loopbackPort(port)}:8200`, '--entrypoint', 'sh'],
    OPENBAO_IMAGE,
    '-c',
    `umask 077; cat > /tmp/raditi-bao.hcl <<'RADITI_CONFIG'\n${openbaoConfig}RADITI_CONFIG\nexec bao server -config=/tmp/raditi-bao.hcl`,
  ]
}

/**
 * Gitea 1.27.3 with built-in HTTPS and the stand's certificate (copied in before the start),
 * Actions on and `[actions] WORKFLOW_DIRS` of every Gitea of the platform. ROOT_URL is the
 * loopback address the host and, through the mirror, the deploy jobs reach it on.
 */
export function giteaArgs({ names, port }) {
  const env = {
    GITEA__security__INSTALL_LOCK: 'true',
    GITEA__database__DB_TYPE: 'sqlite3',
    GITEA__server__PROTOCOL: 'https',
    GITEA__server__HTTP_PORT: '3000',
    GITEA__server__ROOT_URL: `https://127.0.0.1:${loopbackPort(port)}/`,
    GITEA__server__CERT_FILE: '/tls/server.pem',
    GITEA__server__KEY_FILE: '/tls/server-key.pem',
    GITEA__server__DISABLE_SSH: 'true',
    GITEA__server__START_SSH_SERVER: 'false',
    GITEA__service__DISABLE_REGISTRATION: 'true',
    GITEA__actions__ENABLED: 'true',
    GITEA__actions__DEFAULT_ACTIONS_URL: 'self',
    GITEA__actions__WORKFLOW_DIRS: REPOSITORY_WORKFLOWS_OFF,
    GITEA__webhook__ALLOWED_HOST_LIST: 'private,loopback',
    GITEA__repository__DEFAULT_BRANCH: 'main',
    GITEA__log__LEVEL: 'Warn',
  }
  return [
    ...['create', '--pull', 'never', '--name', names.containers.gitea, '--label', names.label],
    ...['-p', `127.0.0.1:${port}:3000`],
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    GITEA_IMAGE,
  ]
}

/** Where a deploy job finds the stand's CA (the volume `ca`, read-only). */
export const CA_INSIDE = '/run/raditi/ca/ca.pem'

/** Writes the stand's CA into its volume: a container without network, the PEM on stdin. */
export function caWriterArgs({ names, image }) {
  return [
    ...['run', '--rm', '-i', '--pull', 'never', '--label', names.label, '--network', 'none'],
    // The new volume belongs to root; the file is readable by every uid of a job.
    ...['--user', '0:0', '--mount', `type=volume,src=${names.volumes.ca},dst=/ca`],
    '--entrypoint',
    'sh',
    image,
    '-c',
    'umask 022; cat > /ca/ca.pem',
  ]
}

/**
 * The loopback of the host as the deploy runner and its jobs see it. Every container on the
 * network of the Docker VM (`--network host`) shares one loopback, where Docker Desktop's proxy
 * also listens on each port a container publishes on 127.0.0.1 (measured 17.10.2026, Docker
 * Desktop 29.8.2): Gitea, OpenBao, S3, the hosting and the site are there at the very addresses
 * the platform keeps for them, the ones core uses on the Mac. A process of the platform on the
 * Mac (the release API of core) is not: the mirror lives on that network, listens on 127.0.0.1
 * on its port and forwards to the same port of the Mac by `host.docker.internal`.
 */
export const MIRROR_SCRIPT = [
  "const net = require('node:net')",
  'const ports = JSON.parse(process.env.MIRROR_PORTS)',
  'let listening = 0',
  'for (const port of ports) {',
  '  const server = net.createServer((inbound) => {',
  "    const outbound = net.connect({ host: 'host.docker.internal', port })",
  '    inbound.pipe(outbound).pipe(inbound)',
  "    for (const end of [inbound, outbound]) end.on('error', () => { inbound.destroy(); outbound.destroy() })",
  '  })',
  "  server.listen(port, '127.0.0.1', () => { if (++listening === ports.length) console.log('mirror ready') })",
  '}',
].join('\n')

export function mirrorArgs({ names, image, ports }) {
  const list = ports.map(loopbackPort)
  return [
    ...created(names, 'mirror', ['--network', 'host']),
    ...['--add-host', 'host.docker.internal:host-gateway'],
    ...['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'],
    ...['-e', `MIRROR_PORTS=${JSON.stringify(list)}`, '--entrypoint', 'node'],
    image,
    '-e',
    MIRROR_SCRIPT,
  ]
}

/**
 * The configuration of the deploy runner: the jobs on the network of the Docker VM, where the
 * mirror gives them the host's loopback; no Docker socket, no privileges, the CA volume only;
 * the addresses of OpenBao and of the release API, the CA and APP_ENV from the runner, never
 * from a repository.
 */
export function runnerConfig({ names, ports }) {
  return [
    'log:',
    '  level: info',
    'runner:',
    '  capacity: 1',
    '  fetch_interval: 1s',
    '  fetch_interval_max: 2s',
    '  shutdown_timeout: 0s',
    '  envs:',
    `    RADITI_VAULT_ADDR: http://127.0.0.1:${loopbackPort(ports.vault)}`,
    `    RADITI_RELEASE_API_URL: http://127.0.0.1:${loopbackPort(ports.releaseApi)}`,
    `    NODE_EXTRA_CA_CERTS: ${CA_INSIDE}`,
    '    APP_ENV: test',
    'container:',
    '  network: host',
    "  docker_host: '-'",
    '  privileged: false',
    '  force_pull: false',
    `  options: --label ${names.label} --volume ${names.volumes.ca}:${CA_INSIDE.replace(/\/[^/]+$/, '')}:ro`,
    '  valid_volumes:',
    `    - ${names.volumes.ca}`,
    '',
  ].join('\n')
}

/**
 * The deploy runner: on the network of the Docker VM with the mirror, its own Docker socket
 * (jobs do not get it), /config copied in before the start. Its label `deploy` names the
 * orchestrator image of this tree.
 */
export function runnerArgs({ names, ports, deployImage, socket }) {
  if (!DIGEST_REFERENCE.test(deployImage)) throw new Error('Invalid deploy image')
  return [
    ...['create', '--pull', 'never', '--name', names.containers.runner, '--label', names.label],
    ...['--network', 'host', '-v', `${socket}:/var/run/docker.sock`],
    ...[
      ['GITEA_INSTANCE_URL', `https://127.0.0.1:${loopbackPort(ports.gitea)}`],
      ['GITEA_RUNNER_REGISTRATION_TOKEN_FILE', '/config/registration-token'],
      ['GITEA_RUNNER_NAME', names.containers.runner],
      ['GITEA_RUNNER_LABELS', `deploy:docker://${deployImage}`],
      ['CONFIG_FILE', '/config/runner.yaml'],
      ['SSL_CERT_FILE', '/config/ca.pem'],
    ].flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    RUNNER_IMAGE,
  ]
}

/** The database of the production site: MariaDB on the site's network, a loopback port. */
export function siteDbArgs({ names, envFile }) {
  return [
    ...created(names, 'site-db', ['--network', names.network, '--network-alias', 'db']),
    ...['-p', '127.0.0.1::3306', ...envFileOf(envFile)],
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

/**
 * A query of a preview's own database as root on its socket (`sh -c <this> sh <query>` in the
 * container). The password is the file of the container's tmpfs its environment names
 * (`MARIADB_ROOT_PASSWORD_FILE`): the product keeps the passwords in Vault and never in the
 * environment of the container (owner's answer of 19.10.2026).
 */
export const PREVIEW_ROOT_QUERY =
  'mariadb -uroot -p"$(cat "$MARIADB_ROOT_PASSWORD_FILE")" -N -B preview -e "$1"'

const SITE_ENV = (password) => [
  'WORDPRESS_DB_HOST=db',
  'WORDPRESS_DB_USER=wordpress',
  `WORDPRESS_DB_PASSWORD=${password}`,
  'WORDPRESS_DB_NAME=wordpress',
  // No cron of WordPress: its loopback requests would go to the published port of the Mac. A
  // local environment: WordPress offers application passwords over plain http only there.
  "WORDPRESS_CONFIG_EXTRA=define('DISABLE_WP_CRON', true); define('WP_ENVIRONMENT_TYPE', 'local');",
  '',
]
export const siteWebEnvFile = (password) => SITE_ENV(password).join('\n')

/** The web server of the production site: the document root volume, the published port of its URL. */
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
    ...['--network', names.network, '--user', '33:33'],
    ...['--mount', `type=volume,src=${names.volumes.docroot},dst=/var/www/html`],
    ...envFileOf(envFile),
    WPCLI_IMAGE,
    'wp',
    ...args,
  ]
}

/** The document root as the hosting serves it over SFTP. */
export const HOSTING_ROOT = '/var/www/html'
export const HOSTING_USER = 'site'

/**
 * The hosting of the production site: OpenSSH with SFTP over the document root, as the web
 * server's user (uid 33) so that a file written over SFTP is the site's. The password is a file
 * copied in before the start, never an argument.
 */
export function hostingArgs({ names, port }) {
  return [
    ...['create', '--pull', 'never', '--name', names.containers.hosting, '--label', names.label],
    ...['--network', names.network, '-p', `127.0.0.1:${loopbackPort(port)}:2222`],
    ...['--mount', `type=volume,src=${names.volumes.docroot},dst=${HOSTING_ROOT}`],
    ...[
      ['PUID', '33'],
      ['PGID', '33'],
      ['USER_NAME', HOSTING_USER],
      ['PASSWORD_ACCESS', 'true'],
      ['USER_PASSWORD_FILE', '/stand/password'],
    ].flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    HOSTING_IMAGE,
  ]
}

/** OpenSSL extension files of the stand's two-day CA and of its one server certificate. */
export function certificateConfigs() {
  return {
    authority: [
      'basicConstraints = critical, CA:true, pathlen:0',
      'keyUsage = critical, keyCertSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
    // Gitea on 127.0.0.1 and the synthetic Z.ai under `localhost` (LLM_BACKEND_URL_ZAI_CODING).
    server: [
      'basicConstraints = critical, CA:false',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = IP:127.0.0.1, DNS:localhost',
      '',
    ].join('\n'),
  }
}

// ─── Processes ────────────────────────────────────────────────────────────────

/** A synthetic HOME and TMPDIR of the run: no process of the stand finds real credentials. */
const sandboxed = ({ path, directory }) => ({
  PATH: path,
  HOME: `${directory}/home`,
  TMPDIR: `${directory}/tmp`,
})
const origin = (port) => `http://127.0.0.1:${loopbackPort(port)}`

/** What every process of the platform is told about previews; web, core, mcp and preview agree. */
const previewAddress = (ports) => ({
  PREVIEW_BASE_DOMAIN: 'localhost',
  PREVIEW_SCHEME: 'http',
  PREVIEW_PUBLIC_PORT: String(loopbackPort(ports.preview)),
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

/**
 * The environment of one role process of the orchestrator (`node dist/main.js` of the build
 * copy). NODE_ENV=production keeps it from looking for a `.env`; APP_ENV is `test`.
 */
export function roleEnvironment(role, context) {
  const { path, directory, ports, databaseUrl, vault, roles, s3, secrets } = context
  const base = {
    ...sandboxed({ path, directory }),
    NODE_ENV: 'production',
    NO_COLOR: '1',
    APP_ENV: 'test',
    // The llm app has no roles to choose from: it is one role.
    DATABASE_URL: databaseUrl,
    METRICS_TOKEN: secrets.metrics,
  }
  switch (role) {
    case 'llm':
      return {
        ...base,
        ...vaultOf(vault, roles.llm),
        LLM_GATEWAY_PORT: String(loopbackPort(ports.llm)),
        LLM_GATEWAY_LISTEN_HOST: '127.0.0.1',
        // Docker Desktop brings a container's host.docker.internal to the loopback of the Mac.
        LLM_GATEWAY_CLIENTS: '127.0.0.1/32',
        LLM_GATEWAY_HOSTS: `host.docker.internal:${ports.llm},127.0.0.1:${ports.llm}`,
        LLM_BACKEND_URL_ZAI_CODING: `https://localhost:${loopbackPort(ports.zai)}`,
        LLM_UPSTREAM_CA_FILE: context.caFile,
      }
    case 'mcp':
      return {
        ...base,
        ...vaultOf(vault, roles.mcp),
        ...s3Of(s3, ['artifacts']),
        ...previewAddress(ports),
        MCP_PORT: String(loopbackPort(ports.mcp)),
        // What sandbox-gw rewrites Host to: the role accepts nothing else.
        MCP_ALLOWED_HOSTS: 'host.docker.internal',
        MCP_CONTENT_PROFILE: 'local',
        MCP_BROWSER_PROFILE: 'local',
        PREVIEW_UPSTREAM_HOST: '127.0.0.1',
      }
    case 'preview':
      return {
        ...base,
        ...previewAddress(ports),
        APP_URL: origin(ports.web),
        GITEA_URL: `https://127.0.0.1:${ports.gitea}`,
        PREVIEW_GATEWAY_PORT: String(loopbackPort(ports.preview)),
        PREVIEW_GATEWAY_HOST: '127.0.0.1',
        PREVIEW_SESSION_SECRET: secrets.previewSession,
      }
    case 'core':
      return {
        ...base,
        ...vaultOf(vault, roles.core),
        ...s3Of(s3),
        ...previewAddress(ports),
        APP_URL: origin(ports.web),
        CORE_PORT: String(loopbackPort(ports.core)),
        REDIS_URL: context.redisUrl,
        LLM_CONTROL_URL: origin(ports.llm),
        TURN_EXECUTOR: 'local',
        SANDBOX_RUNTIME: 'runc',
        SANDBOX_DOCKER_SOCKET: context.socket,
        SANDBOX_IMAGE: context.images.sandbox,
        SANDBOX_GATEWAY_IMAGE: context.images.gateway,
        SANDBOX_NETWORK_GUARD_IMAGE: context.images.guard,
        SANDBOX_LLM_UPSTREAM: `http://host.docker.internal:${ports.llm}`,
        SANDBOX_MCP_UPSTREAM: `http://host.docker.internal:${ports.mcp}`,
        GITEA_URL: `https://127.0.0.1:${loopbackPort(ports.gitea)}`,
        GITEA_TOKEN: secrets.botToken,
        GIT_CA_FILE: context.caFile,
        // The REST client of Gitea trusts the stand's CA this way.
        NODE_EXTRA_CA_CERTS: context.caFile,
        GIT_MIRROR_DIR: `${directory}/mirrors`,
        PREVIEW_GATEWAY_PORT: String(ports.preview),
        PREVIEW_EXECUTOR: 'local',
        PREVIEW_RUNTIME: 'runc',
        PREVIEW_TTL_HOURS: '72',
        PREVIEW_WEB_IMAGES: `8.3=${WORDPRESS_IMAGE}`,
        PREVIEW_DB_IMAGE: MARIADB_IMAGE,
        PREVIEW_CLI_IMAGE: WPCLI_IMAGE,
        PREVIEW_FORWARDER_IMAGE: context.images.tools,
        PREVIEW_BROWSER_IMAGE: context.images.browser,
        PREVIEW_EGRESS_IMAGE: context.images.egress,
        PREVIEW_UPSTREAM_HOST: '127.0.0.1',
        RELEASE_API_HOST: '127.0.0.1',
        RELEASE_API_PORT: String(loopbackPort(ports.releaseApi)),
        RELEASE_API_PUBLIC_URL: origin(ports.releaseApi),
        RELEASE_START_TIMEOUT_MINUTES: '10',
      }
    default:
      throw new Error(`Unknown role ${role}`)
  }
}

/** The environment of web: the standalone server of `next build` in the build copy. */
export function webEnvironment(context) {
  const { path, directory, ports, databaseUrl, vault, roles, s3, secrets } = context
  return {
    ...sandboxed({ path, directory }),
    NODE_ENV: 'production',
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
    GITEA_URL: `https://127.0.0.1:${ports.gitea}`,
    PREVIEW_TTL_HOURS: '72',
    ...previewAddress(ports),
    ...s3Of(s3, ['artifacts']),
    ...vaultOf(vault, roles.web),
  }
}

/** An operator command of the orchestrator (scripts/*.mjs of the copy), given its environment. */
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

// ─── The production site ──────────────────────────────────────────────────────

export const THEME = 'raditi-demo'
export const THEME_DIR = `wp-content/themes/${THEME}`
export const FOOTER_PATH = `${THEME_DIR}/footer.php`
export const NOTICE_PATH = `${THEME_DIR}/notice.php`
export const STYLE_PATH = `${THEME_DIR}/style.css`

/** The words the scenarios look for on the pages; each version of the footer is one line. */
export const TEXT = Object.freeze({
  siteName: 'Цветочная лавка «Ромашка»',
  footer: (version) => `Подвал сайта: версия ${version}`,
  footerOther: 'Подвал сайта: другая подпись',
  notice: 'Доставка по городу бесплатно',
  contacts: 'Контакты',
  contactsAfter: 'Контакты и реквизиты',
  contactsManual: 'Контакты (правка владельца)',
  contactsConflict: 'Контакты для оптовых покупателей',
  post: 'Новости лавки',
  postBroken: 'Новости лавки (новая версия)',
  // «Операции БД и миграции» (S8): a new page, a setting, a table and a text of every kind.
  prices: 'Цены',
  pricesText: 'Букеты от 500 ₽ и доставка за час',
  description: 'Цветы у дома — доставка за час',
  postDb: 'Новости лавки и цены',
  team: 'Команда',
  teamOwner: 'Команда (страница владельца)',
  // «Попробовать ещё» (S10): a line of the style of the theme, one version per pass.
  retryMark: (version) => `Радити: отметка повтора, версия ${version}`,
  retryWords: 'Поменяйте отметку в стилях на версию 2.',
  offers: 'Акции',
  siteNameOffers: 'Цветочная лавка «Ромашка» — акции',
  // «Отменить выпуск» (S9): the owner's own title of the news post, set after the release.
  postOwner: 'Новости лавки (правка владельца)',
})

/**
 * A must-use plugin the stand puts on production by hand (S9): a page of the site fails with a
 * fatal error of PHP while the description of the site holds `description` — a site that a write
 * of an undo breaks (or mends). Only the pages of the theme: the plugin's own routes answer.
 */
export const undoTrap = (description) =>
  `<?php\nadd_action( 'wp_footer', function () {\n  if ( get_option( 'blogdescription' ) === ${JSON.stringify(description)} ) { raditi_release_verify_missing(); }\n} );\n`
/**
 * Where a trap lies: a file of its own per trap — PHP's opcache of production looks at the time of
 * a file every 2 s, and a file rewritten in place may run its old code for that long.
 */
export const undoTrapPath = (name) => `wp-content/mu-plugins/stand-undo-trap-${name}.php`

/** The table of the platform S8 creates and extends (`<prefix>raditi_bookings` on production). */
export const BOOKINGS = Object.freeze({
  table: 'bookings',
  create: {
    columns: [
      { name: 'name', type: 'string', length: 120, nullable: true },
      { name: 'starts_at', type: 'datetime', nullable: true },
    ],
    indexes: [{ name: 'by_start', columns: ['starts_at'], unique: false }],
  },
  add: { columns: [{ name: 'note', type: 'text', nullable: true }] },
})

/** A small classic theme: the footer has a slot for a template part that is not there yet. */
export function themeFiles() {
  return {
    [`${THEME_DIR}/style.css`]: `/*\nTheme Name: Raditi Demo\nVersion: 1.0\n*/\nbody { font-family: sans-serif; }\n`,
    [`${THEME_DIR}/header.php`]:
      '<!doctype html>\n<html <?php language_attributes(); ?>>\n<head><meta charset="utf-8"><title><?php bloginfo( \'name\' ); ?></title><?php wp_head(); ?></head>\n<body>\n<header class="site-header"><?php bloginfo( \'name\' ); ?></header>\n',
    [`${THEME_DIR}/index.php`]:
      '<?php get_header(); ?>\n<main>\n<?php while ( have_posts() ) : the_post(); ?>\n<article><h1 class="entry-title"><?php the_title(); ?></h1><div class="entry-content"><?php the_content(); ?></div></article>\n<?php endwhile; ?>\n</main>\n<?php get_footer(); ?>\n',
    [FOOTER_PATH]: `<footer class="site-footer"><p class="footer-text">${TEXT.footer(0)}</p><?php get_template_part( 'notice' ); ?></footer>\n<?php wp_footer(); ?>\n</body>\n</html>\n`,
    [`${THEME_DIR}/functions.php`]: "<?php\nadd_theme_support( 'title-tag' );\n",
  }
}

/** One small PNG of the media library: a file of the repository the platform never edits. */
export const MEDIA_PATH = 'wp-content/uploads/2026/10/lavka.png'
export const MEDIA_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

/** What of the document root the repository of the site holds: everything but the configuration. */
export const REPOSITORY_EXCLUDES = Object.freeze([
  './wp-config.php',
  './.htaccess',
  './wp-content/upgrade',
])

// ─── The scripted model ───────────────────────────────────────────────────────

/** A turn result by the contract of the platform (turnResultSchema). */
export function turnResult({ summary, changeType, message, files = [], risk = 'low' }) {
  return JSON.stringify({
    summary,
    change_type: changeType,
    client_message: message,
    files_changed: files,
    questions: [],
    needs_approval: false,
    risk,
  })
}

const bash = (command, description) => ({ name: 'bash', arguments: { command, description } })
/**
 * The usage every answer of the first turn reports: half of the context the driver declares
 * (1 M tokens, packages/agent-drivers/src/opencode.ts), far from the CLI's compaction.
 */
export const LARGE_USAGE = Object.freeze({
  prompt: 400_000,
  cached: 6_784,
  completion: 100_000,
  reasoning: 54,
})
const tool = (name, args) => ({ name: `raditi_${name}`, arguments: args })

/**
 * The answers of the scripted model for each turn of the scenarios: `rounds` — the tool calls of
 * one answer each, in order; `text` — the final answer of the turn. The CLI declares the
 * platform tools as `raditi_<tool>`.
 */
export const MODEL_TURNS = Object.freeze({
  /** S1: the footer, a new template part, the title of «Контакты» in the preview, the browser. */
  first: ({ contactsId }) => ({
    scenario: 'tools',
    rounds: [
      [
        bash(
          `sed -i 's/${TEXT.footer(0)}/${TEXT.footer(1)}/' ${FOOTER_PATH} && printf '%s\\n' '<p class="site-notice">${TEXT.notice}</p>' > ${NOTICE_PATH}`,
          'Update the footer and add the notice',
        ),
      ],
      [tool('wp_rest', { method: 'GET', route: `/wp/v2/pages/${contactsId}` })],
      [
        tool('wp_rest', {
          method: 'POST',
          route: `/wp/v2/pages/${contactsId}`,
          body: { title: TEXT.contactsAfter },
          idempotencyKey: 'release-verify-contacts-title',
        }),
      ],
      [tool('browser_navigate', { path: '/' })],
      [
        tool('browser_run_checks', {
          checks: [
            { path: '/', selector: '.footer-text', text: TEXT.footer(1) },
            { path: '/', selector: '.site-notice', text: TEXT.notice },
            { path: `/?page_id=${contactsId}`, selector: '.entry-title', text: TEXT.contactsAfter },
          ],
        }),
      ],
    ],
    // Every answer of this turn reports a large usage: the charge of the dialog then stands
    // above the minimum of a task, so S4 can tell a charge by usage from the minimum.
    usage: LARGE_USAGE,
    text: turnResult({
      summary: 'Footer text, a delivery notice and the title of the contacts page',
      changeType: 'mixed',
      message:
        'Обновили подвал, добавили объявление о доставке и поменяли заголовок страницы «Контакты». Проверьте предпросмотр.',
      files: [FOOTER_PATH, NOTICE_PATH],
    }),
  }),
  /**
   * S3: the clarification — the footer once more, on top of the candidate. The browser opens the
   * page first (the preview's PHP compiles the footer), the footer is edited, and the check right
   * after must see the new text: a preview whose code cache looked at file times every few
   * seconds would still run the old footer (R12).
   */
  clarification: () => ({
    scenario: 'tools',
    rounds: [
      [tool('browser_navigate', { path: '/' })],
      [
        bash(
          `sed -i 's/${TEXT.footer(1)}/${TEXT.footer(2)}/' ${FOOTER_PATH}`,
          'Update the footer again',
        ),
      ],
      [
        tool('browser_run_checks', {
          checks: [{ path: '/', selector: '.footer-text', text: TEXT.footer(2) }],
        }),
      ],
    ],
    text: turnResult({
      summary: 'Footer text once more',
      changeType: 'code',
      message: 'Поправили текст подвала, как вы просили.',
      files: [FOOTER_PATH],
    }),
  }),
  /**
   * S5: a change the preview cannot catch — the footer calls a function that is missing where
   * the platform's preview constant is not defined, that is on production only — and the title
   * of the post.
   */
  breaking: ({ postId }) => ({
    scenario: 'tools',
    rounds: [
      [
        bash(
          `sed -i 's|<footer class="site-footer">|<?php if ( ! defined( "RADITI_PREVIEW_ORIGIN" ) ) { raditi_release_verify_missing(); } ?><footer class="site-footer">|' ${FOOTER_PATH}`,
          'Add a call to the footer',
        ),
      ],
      [tool('wp_rest', { method: 'GET', route: `/wp/v2/posts/${postId}` })],
      [
        tool('wp_rest', {
          method: 'POST',
          route: `/wp/v2/posts/${postId}`,
          body: { title: TEXT.postBroken },
          idempotencyKey: 'release-verify-post-title',
        }),
      ],
      // The agent's browser of this dialog starts: S6a attacks the neighbour from it.
      [tool('browser_navigate', { path: '/' })],
    ],
    text: turnResult({
      summary: 'A footer call and the title of the news post',
      changeType: 'mixed',
      message: 'Поменяли подвал и заголовок новости.',
      files: [FOOTER_PATH],
    }),
  }),
  /**
   * S6: the title of «Контакты» again, which the owner then edits by hand on production. The
   * first call comes while the preview is still being built (CONTENT_PREVIEW_NOT_READY), the
   * same call again once it is ready, then the write.
   */
  conflicting: ({ contactsId }) => ({
    scenario: 'tools',
    rounds: [
      [tool('wp_rest', { method: 'GET', route: `/wp/v2/pages/${contactsId}` })],
      [tool('wp_rest', { method: 'GET', route: `/wp/v2/pages/${contactsId}` })],
      [
        tool('wp_rest', {
          method: 'POST',
          route: `/wp/v2/pages/${contactsId}`,
          body: { title: TEXT.contactsConflict },
          idempotencyKey: 'release-verify-contacts-conflict',
        }),
      ],
    ],
    text: turnResult({
      summary: 'The title of the contacts page',
      changeType: 'content',
      message: 'Поменяли заголовок страницы «Контакты».',
    }),
  }),
  /** S10: the first pass of dialog J — a line of the style of the theme. */
  retryBase: () => ({
    scenario: 'tools',
    rounds: [
      [
        bash(
          `printf '%s\\n' '/* ${TEXT.retryMark(1)} */' >> ${STYLE_PATH}`,
          'Mark the style of the theme',
        ),
      ],
    ],
    text: turnResult({
      summary: 'A mark in the style of the theme',
      changeType: 'code',
      message: 'Добавили отметку в стили темы.',
      files: [STYLE_PATH],
    }),
  }),
  /**
   * S10: the second pass of dialog J, whose container the stand kills while its first answer is
   * held: a failure of the platform, not of the model — the answers below are never used.
   */
  retryKilled: () => ({
    scenario: 'tools',
    rounds: [
      [bash(`sed -i 's/${TEXT.retryMark(1)}/${TEXT.retryMark(9)}/' ${STYLE_PATH}`, 'Never run')],
    ],
    text: turnResult({
      summary: 'Never sent',
      changeType: 'code',
      message: 'Этот ответ не уходит: контейнер хода остановлен.',
      files: [STYLE_PATH],
    }),
  }),
  /** S10: «Попробовать ещё» — the request of the failed pass, from the checkpoint of turn 1. */
  retryDone: () => ({
    scenario: 'tools',
    rounds: [
      [
        bash(
          `sed -i 's/${TEXT.retryMark(1)}/${TEXT.retryMark(2)}/' ${STYLE_PATH}`,
          'Mark version 2',
        ),
      ],
    ],
    text: turnResult({
      summary: 'The mark of version 2',
      changeType: 'code',
      message: 'Поменяли отметку в стилях на версию 2.',
      files: [STYLE_PATH],
    }),
  }),
  /** S4: a dialog opened before a release, whose candidate the release makes stale. */
  stale: () => ({
    scenario: 'tools',
    rounds: [
      [
        bash(
          `printf '%s\\n' '.site-footer { color: green; }' >> ${STYLE_PATH}`,
          'Colour the footer',
        ),
      ],
    ],
    text: turnResult({
      summary: 'A colour of the footer',
      changeType: 'code',
      message: 'Сделали подвал зелёным.',
      files: [STYLE_PATH],
    }),
  }),
  /**
   * S4a/S4b: a dialog opened before a release that changes the same line of the footer: its
   * «Обновить» cannot carry the change onto the release.
   */
  footerConflict: () => ({
    scenario: 'tools',
    rounds: [
      [
        bash(
          `sed -i 's/${TEXT.footer(0)}/${TEXT.footerOther}/' ${FOOTER_PATH}`,
          'Change the footer',
        ),
      ],
    ],
    text: turnResult({
      summary: 'Another footer',
      changeType: 'code',
      message: 'Поменяли подпись в подвале.',
      files: [FOOTER_PATH],
    }),
  }),
  /**
   * S8a: every kind of a database plan in one turn — a table of the platform, a new page, the
   * description of the site, the title of the news post — and a check of the new page in the
   * browser by its number in the preview.
   */
  allKinds: ({ postId }) => ({
    scenario: 'tools',
    rounds: [
      [
        tool('db_schema', {
          method: 'POST',
          table: BOOKINGS.table,
          create: BOOKINGS.create,
          idempotencyKey: 'release-verify-bookings',
        }),
      ],
      [
        tool('wp_rest', {
          method: 'POST',
          route: '/wp/v2/pages',
          body: {
            title: TEXT.prices,
            content: `<p>${TEXT.pricesText}</p>`,
            slug: 'prices',
            status: 'publish',
          },
          idempotencyKey: 'release-verify-prices',
        }),
      ],
      [
        tool('wp_rest', {
          method: 'POST',
          route: '/wp/v2/settings',
          body: { description: TEXT.description },
          idempotencyKey: 'release-verify-description',
        }),
      ],
      [tool('wp_rest', { method: 'GET', route: `/wp/v2/posts/${postId}` })],
      [
        tool('wp_rest', {
          method: 'POST',
          route: `/wp/v2/posts/${postId}`,
          body: { title: TEXT.postDb },
          idempotencyKey: 'release-verify-post-db',
        }),
      ],
    ],
    text: turnResult({
      summary: 'A prices page, a bookings table, the site description and the news title',
      changeType: 'content',
      message:
        'Добавили страницу «Цены», таблицу для записей, новое описание сайта и заголовок новости. Проверьте предпросмотр.',
    }),
  }),
  /** S8b: a new page at an address the owner then takes on production by hand. */
  team: () => ({
    scenario: 'tools',
    rounds: [
      [
        tool('wp_rest', {
          method: 'POST',
          route: '/wp/v2/pages',
          body: {
            title: TEXT.team,
            content: '<p>Мы — флористы.</p>',
            slug: 'team',
            status: 'publish',
          },
          idempotencyKey: 'release-verify-team',
        }),
      ],
    ],
    text: turnResult({
      summary: 'A team page',
      changeType: 'content',
      message: 'Добавили страницу «Команда».',
    }),
  }),
  /**
   * S8c: a footer that breaks production only (as S5), and every kind beside it — a new page,
   * the name of the site, a column added to the table of S8a.
   */
  breakingDb: () => ({
    scenario: 'tools',
    rounds: [
      [
        bash(
          `sed -i 's|<footer class="site-footer">|<?php if ( ! defined( "RADITI_PREVIEW_ORIGIN" ) ) { raditi_release_verify_missing(); } ?><footer class="site-footer">|' ${FOOTER_PATH}`,
          'Add a call to the footer',
        ),
      ],
      [
        tool('wp_rest', {
          method: 'POST',
          route: '/wp/v2/pages',
          body: {
            title: TEXT.offers,
            content: '<p>Скидки недели</p>',
            slug: 'offers',
            status: 'publish',
          },
          idempotencyKey: 'release-verify-offers',
        }),
      ],
      [
        tool('wp_rest', {
          method: 'POST',
          route: '/wp/v2/settings',
          body: { title: TEXT.siteNameOffers },
          idempotencyKey: 'release-verify-site-name',
        }),
      ],
      [
        tool('db_schema', {
          method: 'POST',
          table: BOOKINGS.table,
          add: BOOKINGS.add,
          idempotencyKey: 'release-verify-bookings-note',
        }),
      ],
    ],
    text: turnResult({
      summary: 'A footer call, an offers page, the site name and a note column',
      changeType: 'mixed',
      message: 'Поменяли подвал, добавили страницу акций, поле для заметок и название сайта.',
      files: [FOOTER_PATH],
    }),
  }),
  /** S7: a dialog that only asks; its turn waits while a deploy holds the site. */
  question: () => ({
    scenario: 'text',
    text: turnResult({
      summary: 'Answered a question',
      changeType: 'none',
      message: 'Сайт работает на WordPress, изменений не нужно.',
    }),
  }),
})

// ─── Billing ──────────────────────────────────────────────────────────────────

/** The stand rates of the profile, ₽ per million tokens with VAT (verify-llm-zai-setup.mjs). */
export const STAND_RATES = Object.freeze({
  inputPer1m: '10.000000',
  cacheReadPer1m: '1.000000',
  cacheWritePer1m: null,
  outputPer1m: '30.000000',
  vatRate: '0.2200',
})
export const STAND_PROFILE = 'glm-5.3-standard'
/**
 * Every profile the operator of the stand switches on: the standard one of a dialog, and the
 * heavy one «Попробовать ещё» moves a dialog to (spec §9; S10). One rate for both: the charge is
 * worked out apart from the product at the same rates (`expectedCharge`).
 */
export const STAND_PROFILES = Object.freeze([STAND_PROFILE, 'glm-5.3-heavy'])
export const STAND_RUB_PER_CREDIT = '6.00'

/** The file `billing:rates` takes: the rates of the profiles and the provisional credit rate. */
export function standRatesFile() {
  return {
    rubPerCredit: STAND_RUB_PER_CREDIT,
    basis:
      'Стенд выпуска: синтетические ставки профилей и предварительный курс кредита проекта кредитов, не утверждены.',
    prices: STAND_PROFILES.map((model) => ({
      provider: 'zai-coding',
      model,
      ...STAND_RATES,
      sourceUrl: 'https://synthetic.invalid/release-verify-rates',
    })),
  }
}

/**
 * What a done task is charged, worked out apart from the product: each model call at the rates of
 * the stand (input without the cache, cache reads, cache writes at the input rate, output with
 * reasoning), the sum in credits at the stand's rate, rounded half up once, at least 5, at most the
 * reserve (spec §17, «Правила списания»).
 */
export function expectedCharge(calls, reservedCredits) {
  const rate = (value) => Number(value)
  let costRub = 0
  for (const call of calls)
    costRub +=
      (call.inputUncachedTokens * rate(STAND_RATES.inputPer1m) +
        call.cacheReadTokens * rate(STAND_RATES.cacheReadPer1m) +
        call.cacheWriteTokens * rate(STAND_RATES.inputPer1m) +
        call.outputTokens * rate(STAND_RATES.outputPer1m)) /
      1_000_000
  const used = Math.round(costRub / rate(STAND_RUB_PER_CREDIT))
  return { costRub, credits: Math.min(reservedCredits, Math.max(5, used)), used }
}

/** `vX.Y.Z` above `vA.B.C`. */
export function versionAbove(version, other) {
  const parts = (value) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(value).slice(1).map(Number)
  const [a, b] = [parts(version), parts(other)]
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index]
  return false
}

// ─── Probes ───────────────────────────────────────────────────────────────────

/**
 * TCP from PHP by address: `open`, `closed:<errno>:<words>` or `dns` (a name that does not
 * resolve). The errno tells a packet that reached a host (111, refused) from one that found no
 * way (101, 113, a timeout).
 */
export const PHP_ERRNO_PROBE = [
  '$host = $argv[1]; $port = (int) $argv[2];',
  '$ip = filter_var($host, FILTER_VALIDATE_IP) ? $host : gethostbyname($host);',
  'if (!filter_var($ip, FILTER_VALIDATE_IP)) { echo "dns"; exit(0); }',
  '$socket = @fsockopen($ip, $port, $code, $message, 3);',
  'echo $socket ? "open" : "closed:" . $code . ":" . preg_replace("/[^A-Za-z ]/", "", (string) $message);',
].join(' ')

/** The same from Node (the tools and the browser images): `closed:<error code>`. */
export const NODE_ERRNO_PROBE = [
  'const [host, port] = process.argv.slice(1);',
  "const socket = require('net').connect({ host, port: +port, timeout: 3000 });",
  'const done = (state) => { process.stdout.write(state); socket.destroy(); process.exit(0) };',
  "socket.on('connect', () => done('open'));",
  "socket.on('timeout', () => done('closed:ETIMEDOUT'));",
  "socket.on('error', (error) => done(error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN' ? 'dns' : 'closed:' + error.code));",
].join(' ')

/** A connection that found no way to its address: unreachable network or host, or no answer. */
const UNREACHED =
  /^closed:(?:101|113|110|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)(?::|$)|^closed:\d+:.*(?:timed out|unreachable)/i

/**
 * Whether what a probe saw shows the target isolated: an address must be unreachable — a refusal
 * means the packet reached a host, and proves nothing about the network —, a name must not
 * resolve at all.
 */
export function isolatedAnswer(answer, { name = false } = {}) {
  return name ? answer === 'dns' : UNREACHED.test(answer)
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
