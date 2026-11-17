// Pure parts of the browser-task stand (verify-browser-task.mjs, docs/plan/57-browser-tasks.md §5;
// since plan 83 the browser of chats without a project only): its options, the names of everything
// a run owns, the images it starts and builds, the arguments of its containers, the environments
// of the processes it starts. Nothing here touches Docker, the network or a file.
import { isAbsolute } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

import { OPENBAO_IMAGE } from '../billing-verify/openbao.mjs'
import { POSTGRES_IMAGE, REDIS_IMAGE } from '../billing-verify/stand.mjs'

export { OPENBAO_IMAGE, POSTGRES_IMAGE, REDIS_IMAGE }

/** SeaweedFS of infra/dev, by digest. Never pulled. */
export const S3_IMAGE =
  'chrislusf/seaweedfs:4.47@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882'
/** The tags the pinned digests above were pulled by: `docker pull <tag>` before the first run. */
export const PULLED_TAGS = Object.freeze({ [S3_IMAGE]: 'chrislusf/seaweedfs:4.47' })

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
 * The scenarios in their order (README, «Сценарии»), and what each needs to have run first: S
 * signs up the clients the others share.
 */
export const SCENARIO_IDS = Object.freeze(['S', 'P', 'K', 'L', 'Q', 'R', 'M'])
const NEEDS = Object.freeze({
  S: [],
  P: ['S'],
  K: ['S', 'P'],
  L: ['S', 'P', 'K'],
  Q: ['S'],
  R: ['S'],
  M: ['S'],
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

/**
 * The deployment label of core's turn containers in this run. Without the run it would be one
 * label for every run of every tree, and their cores would collect each other's turns.
 */
function sandboxDeployment(stand, run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id of the stand')
  return `${stand}-${run}`
}

export const CONTAINERS = Object.freeze(['postgres', 'redis', 's3', 'openbao'])

/** Every resource of one run by name; nothing outside these names is created or removed by name. */
export function standNames(run) {
  if (typeof run !== 'string' || !RUN.test(run)) throw new Error('Invalid run id of the stand')
  const stand = `raditi-browser-task-verify-${run}`
  return {
    run,
    stand,
    label: `${STAND_LABEL}=${run}`,
    containers: Object.fromEntries(CONTAINERS.map((name) => [name, `${stand}-${name}`])),
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

/** The S3 identity file of SeaweedFS: one identity of the run. */
export function s3Identities({ accessKey, secretKey }) {
  return JSON.stringify({
    identities: [
      {
        name: 'raditi-browser-task-verify',
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
 * The CA of the stand and its one server certificate (services.mjs, createCertificates). `names`
 * — the DNS names of the server certificate besides `localhost` (the projects stand adds the hosts
 * its fake GitLab answers for).
 */
export function certificateConfigs(names = []) {
  return {
    authority: [
      'basicConstraints = critical, CA:true, pathlen:0',
      'keyUsage = critical, keyCertSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
    // The synthetic Z.ai under `localhost` (LLM_BACKEND_URL_ZAI_CODING).
    server: [
      'basicConstraints = critical, CA:false',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = IP:127.0.0.1, IP:::1, DNS:localhost${names.map((name) => `, DNS:${name}`).join('')}`,
      '',
    ].join('\n'),
  }
}

// ─── The host ─────────────────────────────────────────────────────────────────

/** The kinds of host a stand runs on (`hostOf`). */
export const HOST_KINDS = Object.freeze(['desktop', 'linux', 'vm'])

/** The name a container of the platform calls the host by (the gateway of a turn, `host-gateway`). */
export const HOST_NAME = 'host.docker.internal'

/**
 * What the host is for containers, read from `docker info` and a probe container (services.mjs,
 * `probeHost`), never from process.platform. `operatingSystem` — `docker info`; `bridgeGateway` —
 * the gateway of the default bridge; `hostGateway` — what `host-gateway` resolves to inside a
 * container on it.
 *
 * - `desktop`: Docker Desktop carries `host.docker.internal` of a container to the loopback of
 *   this machine, where the processes of the stand listen. Nothing is relayed.
 * - `linux`: `host-gateway` is the bridge gateway, an address of this machine where nothing of the
 *   stand listens (the apps listen on loopback, `listenHost` of app-bootstrap). A relay of the
 *   stand on the bridge gateway carries a container to them (`hostRelays`); the container calls
 *   it `host.docker.internal`, as on Docker Desktop.
 * - `vm`: `host-gateway` is another address — a VM whose daemon leads it to another machine
 *   (Colima: to the Mac), or `host-gateway-ip` of the daemon. The relay is the same, and the
 *   containers go to the bridge gateway by its address.
 *
 * Not by the interfaces of this machine: an idle `docker0` is DOWN and absent from them; and
 * `docker info` in a VM does not say Docker Desktop, so without the probe it would pass for Linux.
 */
export function hostOf({ operatingSystem, bridgeGateway, hostGateway }) {
  if (/Docker Desktop/.test(String(operatingSystem)))
    return { kind: 'desktop', relay: null, upstream: HOST_NAME, hostGateway, bridgeGateway }
  ipv4Of(bridgeGateway, 'the gateway of the default bridge')
  return hostGateway === bridgeGateway
    ? { kind: 'linux', relay: bridgeGateway, upstream: HOST_NAME, hostGateway, bridgeGateway }
    : { kind: 'vm', relay: bridgeGateway, upstream: bridgeGateway, hostGateway, bridgeGateway }
}

/** The host of a context without one: Docker Desktop, as every stand ran before Linux. */
export const DESKTOP_HOST = Object.freeze({ kind: 'desktop', relay: null, upstream: HOST_NAME })

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
function ipv4Of(value, what) {
  const address = String(value ?? '').trim()
  if (!IPV4.test(address)) throw new Error(`No IPv4 address of ${what}: ${address.slice(0, 100)}`)
  return address
}

/** `docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'`, checked. */
export const bridgeGatewayOf = (output) => ipv4Of(output, 'the gateway of the default bridge')

/**
 * The address `host.docker.internal` has in the /etc/hosts of a probe container started with
 * `--add-host host.docker.internal:host-gateway`: Docker writes what `host-gateway` resolved to.
 */
export function hostGatewayOf(hostsFile) {
  for (const line of String(hostsFile).split('\n')) {
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/)
    if (names.includes(HOST_NAME) && IPV4.test(address ?? '')) return address
  }
  throw new Error(
    `host-gateway of this daemon resolved to no IPv4: ${String(hostsFile).slice(0, 200)}`,
  )
}

/** The host of a run, refused in words when the context names none of the kinds. */
export function hostIn(context) {
  const host = context.host ?? DESKTOP_HOST
  if (!HOST_KINDS.includes(host.kind)) throw new Error(`No kind of host ${host.kind}`)
  return host
}

/**
 * The relays of a run on Linux and in a VM: `<bridge gateway>:<port>` → `127.0.0.1:<port>`, one
 * per port the containers reach on the host (the apps llm and mcp for the gateway of a turn; a
 * stand adds its own); none on Docker Desktop. The processes keep listening on loopback and see a
 * relayed connection from 127.0.0.1 (LLM_GATEWAY_CLIENTS stays `127.0.0.1/32`). Only containers on
 * the default bridge meet the relay: the trusted gateway proxy of a turn, never its sandbox, whose
 * attempt network is internal and has no address of the host (spec §8).
 */
export function hostRelays(host, ports) {
  if (host.relay === null) return []
  return Object.entries(ports).map(([role, port]) => ({
    role,
    listen: host.relay,
    port: loopbackPort(port),
    to: '127.0.0.1',
  }))
}

/** The runtimes of a turn's sandbox a stand runs under (`--runtime`); Docker Desktop has runc only. */
export const RUNTIMES = Object.freeze(['runc', 'runsc'])

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
 * The domain of the agent's pages on the stand (docs/plan/69-pages.md, Ст3): `<slug>.pages.localhost`
 * on the loopback port of the pages listener, which mcp names to the agent and web to the client.
 */
export const PAGES_DOMAIN = 'pages.localhost'
const pagesOf = (ports) => ({
  PAGES_BASE_DOMAIN: PAGES_DOMAIN,
  PAGES_PUBLIC_PORT: String(loopbackPort(ports.pages)),
})

/** The name of the platform: the refusal comes before the name is ever looked up. */
export const PLATFORM_HOST = 'raditi.ru'

/**
 * The environment of one app of the platform (`node dist/main.js` of the build copy).
 * NODE_ENV=production keeps it from looking for a `.env`; APP_ENV is `test`.
 *
 * `context.host` (`hostOf`; Docker Desktop when absent) — how the gateway of a turn reaches llm
 * and mcp: by `host.docker.internal`, or in a VM by the address of the bridge gateway, which then
 * the two apps accept as well. `context.runtime` (`RUNTIMES`; runc when absent) — the runtime of
 * the sandbox of a turn. Without either the environment is the one of Docker Desktop and runc.
 */
export function appEnvironment(app, context) {
  const { path, directory, ports, databaseUrl, vault, roles, s3, secrets } = context
  const host = hostIn(context)
  const byAddress = host.upstream !== HOST_NAME
  const runtime = context.runtime ?? 'runc'
  if (!RUNTIMES.includes(runtime)) throw new Error(`Unknown runtime ${runtime}`)
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
        LLM_GATEWAY_HOSTS: [
          `${HOST_NAME}:${ports.llm}`,
          `127.0.0.1:${ports.llm}`,
          ...(byAddress ? [`${host.upstream}:${ports.llm}`] : []),
        ].join(','),
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
        ...pagesOf(ports),
        MCP_PORT: String(loopbackPort(ports.mcp)),
        // What sandbox-gw rewrites Host to: the role accepts nothing else.
        MCP_ALLOWED_HOSTS: [HOST_NAME, ...(byAddress ? [host.upstream] : [])].join(','),
      }
    case 'preview':
      return {
        ...base,
        ...workerOf(ports, secrets),
        APP_URL: origin(ports.web),
        BROWSER_STREAM_PORT: String(loopbackPort(ports.stream)),
        BROWSER_STREAM_HOST: '127.0.0.1',
        // The third listener: the agent's pages, from the database (scenario Q).
        ...pagesOf(ports),
        PAGES_PORT: String(loopbackPort(ports.pages)),
        PAGES_HOST: '127.0.0.1',
        PAGES_COOKIE_SECRET: secrets.pagesCookie,
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
        // No page of any session reaches a name of the platform (К37): scenario P opens one.
        BROWSER_PLATFORM_HOSTS: PLATFORM_HOST,
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
        // The label of this run's turn containers: a core of another tree on this daemon lists
        // and collects only its own, and this one only these.
        SANDBOX_DEPLOYMENT: sandboxDeployment('browser-task-verify', context.run),
        SANDBOX_RUNTIME: runtime,
        SANDBOX_DOCKER_SOCKET: context.socket,
        SANDBOX_IMAGE: context.images.sandbox,
        SANDBOX_GATEWAY_IMAGE: context.images.gateway,
        SANDBOX_NETWORK_GUARD_IMAGE: context.images.guard,
        SANDBOX_LLM_UPSTREAM: `http://${host.upstream}:${ports.llm}`,
        SANDBOX_MCP_UPSTREAM: `http://${host.upstream}:${ports.mcp}`,
        BROWSER_SESSION_MAX_HOURS: '4',
      }
    default:
      throw new Error(`Unknown app ${app}`)
  }
}

/** The names of the apps' environments that are gone with the projects (plan 83): never set. */
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
    ...pagesOf(ports),
    PAGES_SIGNING_SECRET: secrets.pagesSigning,
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

/** A one-page PDF with a padding comment, `padding` bytes long. */
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

// ─── Probes and the cabinet's requests ────────────────────────────────────────

const TRPC_PATH = '/api/trpc/'

/** The procedures a request of the cabinet names: `/api/trpc/a,b?batch=1` → `['a', 'b']`. */
export function trpcProcedures(url) {
  let path
  try {
    path = new URL(url).pathname
  } catch {
    return []
  }
  if (!path.startsWith(TRPC_PATH)) return []
  return decodeURIComponent(path.slice(TRPC_PATH.length))
    .split(',')
    .filter((name) => name !== '')
}

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

/** Every value of `secrets` (6+ characters) that occurs in `text`, by its name: none is right. */
export function leakedIn(text, secrets) {
  const found = []
  for (const [name, value] of Object.entries(secrets))
    if (typeof value === 'string' && value.length >= 6 && text.includes(value)) found.push(name)
  return found
}
