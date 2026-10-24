import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import {
  PREVIEW_SETTINGS_PATH,
  type PreviewDatabasePasswords,
  type PreviewRuntimeKind,
  type PreviewRuntimeSpec,
} from '@repo/domain'
import type Docker from 'dockerode'

import { previewServiceLimits } from './config.ts'
import {
  browserAddresses,
  previewAddresses,
  previewLabels,
  previewNames,
  PREVIEW_LABEL,
  subnetAddress,
  type PreviewIdentity,
  type PreviewRole,
} from './resources.ts'

/**
 * Create options of a preview's containers (docs/plan/53-chat-preview-release.md, Р18): pure, so
 * every hardening flag is visible in one place and checked by tests. The PHP, CLI, database,
 * files helper and browser containers run the preview's runtime (gVisor in production); the
 * platform's forwarders, which parse nothing, run the daemon's default like sandbox-gw.
 */

export const SETTINGS_DIR = posix.dirname(PREVIEW_SETTINGS_PATH)
/** The tools image (infra/preview/Dockerfile, target `tools`): forwarders and the files helper. */
export const TOOLS = '/usr/local/lib/raditi'
export const FORWARD_PORT = 8080
export const EGRESS_PORT = 3128
export const RELAY_PROXY_PORT = 3128
export const BROWSER_CONTROL_PORT = 9333
export const BROWSER_STATE_DIR = '/run/raditi/browser'
export const BROWSER_SECRET_FILE = `${BROWSER_STATE_DIR}/ws-path`
export const BROWSER_READY_FILE = `${BROWSER_STATE_DIR}/ready`
export const FORWARD_READY_FILE = '/run/raditi-forward/ready'
/** Where the files helper mounts the docroot volume (infra/preview/files.mjs ROOT). */
export const FILES_ROOT = '/files'
/** The database the runtime creates: one per preview, on its own container. */
export const PREVIEW_DATABASE = Object.freeze({ name: 'preview', user: 'preview', port: 3306 })
/** The official MariaDB image runs as `mysql`; its data folder is that user's on first mount. */
export const DATABASE_USER = '999:999'
export const SERVICE_USER = '10001:10001'
/** Names on the preview's network, from /etc/hosts: no DNS is needed under gVisor. */
export const previewHosts = Object.freeze({ db: 'db', egress: 'egress' })
export const CONFIG_LABEL = `${PREVIEW_LABEL}config`
export const CLI_IMAGE_LABEL = `${PREVIEW_LABEL}cli-image`
export const HOSTNAME_LABEL = `${PREVIEW_LABEL}hostname`

/** Never the image's content in a preview's volume: dockerode types ask for more than Docker. */
const noCopy = { NoCopy: true } as unknown as NonNullable<Docker.MountSettings['VolumeOptions']>
export const logConfig = {
  Type: 'local',
  Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' },
}
export const node = (script: string) => [
  '/usr/bin/tini',
  '--',
  '/usr/local/bin/node',
  `${TOOLS}/${script}`,
]

interface Limits {
  cpu: number
  memoryMiB: number
  pids: number
}

/**
 * Under gVisor the host's pids limit counts the threads of the sandbox's own kernel (the
 * sentry), not the processes of the preview, which live inside it: below this the sandbox dies
 * at a busy moment. Measured 17.10.2026 (Colima, 4 vCPU, runsc systrap): with 32, five of eight
 * execs of Node in a fresh container ended in `WaitPID failed: EOF`; from 48 up, none.
 */
export const RUNSC_MIN_PIDS = 128

/** What every container of a preview shares: no privilege, no writable root, bounded. */
export function hardened(limits: Limits, runtime?: PreviewRuntimeKind): Docker.HostConfig {
  return {
    ...(runtime ? { Runtime: runtime } : {}),
    ReadonlyRootfs: true,
    Privileged: false,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    NanoCpus: Math.round(limits.cpu * 1e9),
    Memory: limits.memoryMiB * 1024 * 1024,
    MemorySwap: limits.memoryMiB * 1024 * 1024,
    PidsLimit: runtime === 'runsc' ? Math.max(limits.pids, RUNSC_MIN_PIDS) : limits.pids,
    RestartPolicy: { Name: 'no' },
    AutoRemove: false,
    LogConfig: logConfig,
  }
}

export const tmpfs = (user: string, size: string) => {
  const [uid, gid] = user.split(':')
  return `rw,noexec,nosuid,nodev,size=${size},uid=${uid},gid=${gid},mode=0700`
}
/** The platform's own forwarders: a hop of bytes, never a router. */
export const serviceSysctls = {
  'net.ipv4.ip_forward': '0',
  'net.ipv6.conf.all.disable_ipv6': '1',
  'net.ipv6.conf.default.disable_ipv6': '1',
}
export const fixedAddress = (networkId: string, address: string): Docker.EndpointsConfig => ({
  [networkId]: { IPAMConfig: { IPv4Address: address } },
})

/**
 * A container's desired state as a label: an existing one with another value is replaced.
 * `inputs` is what the container is given after its start and reads only then — the server's
 * configuration files — so a change of them replaces it too.
 */
export function configHash(options: Docker.ContainerCreateOptions, inputs: unknown = null) {
  const { Labels: _labels, ...rest } = options
  return createHash('sha256')
    .update(
      JSON.stringify({ ...rest, Env: rest.Env ?? [], ...(inputs === null ? {} : { inputs }) }),
    )
    .digest('hex')
}

function labelled(
  options: Docker.ContainerCreateOptions,
  identity: PreviewIdentity,
  role: PreviewRole,
  deadline: number,
  extra: Record<string, string> = {},
  inputs: unknown = null,
): Docker.ContainerCreateOptions {
  return {
    ...options,
    Labels: {
      ...previewLabels(identity, role, deadline),
      ...extra,
      [CONFIG_LABEL]: configHash(options, inputs),
    },
  }
}

export interface NetworkPlace {
  id: string
  subnet: string
}

export const identityOf = (spec: PreviewRuntimeSpec): PreviewIdentity => ({
  previewId: spec.previewId,
  siteId: spec.siteId,
  taskId: spec.taskId,
})

/** /etc/hosts of the PHP and CLI containers: the database and the egress proxy, when present. */
export function previewExtraHosts(
  network: NetworkPlace,
  present: { db: boolean; egress: boolean },
): string[] {
  return [
    ...(present.db
      ? [`${previewHosts.db}:${subnetAddress(network.subnet, previewAddresses.db)}`]
      : []),
    ...(present.egress
      ? [`${previewHosts.egress}:${subnetAddress(network.subnet, previewAddresses.egress)}`]
      : []),
  ]
}

/**
 * The server starts only once `ensure` wrote its settings and configuration into the tmpfs:
 * a fixed script of the image's /bin/sh, the server's argv after it, no shell around that.
 */
export const WAIT_FOR_SETTINGS = [
  'i=0',
  `while [ ! -f ${PREVIEW_SETTINGS_PATH} ]; do i=$((i+1)); if [ "$i" -gt 600 ]; then exit 70; fi; sleep 0.2; done`,
  'exec "$@"',
].join('; ')

export function webContainer(
  spec: PreviewRuntimeSpec,
  network: NetworkPlace,
  extraHosts: string[],
): Docker.ContainerCreateOptions {
  const web = spec.recipe.web
  const names = previewNames(spec.previewId)
  return labelled(
    {
      name: names.container('web'),
      Image: spec.images.web,
      User: web.user,
      Entrypoint: ['/bin/sh', '-c', WAIT_FOR_SETTINGS, 'raditi-preview-web'],
      Cmd: [...web.command],
      Env: Object.entries(web.env).map(([name, value]) => `${name}=${value}`),
      WorkingDir: web.docroot,
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(spec.limits, spec.runtime),
        NetworkMode: network.id,
        ExtraHosts: extraHosts,
        Mounts: [
          {
            Type: 'volume',
            Source: names.filesVolume,
            Target: web.docroot,
            ReadOnly: false,
            VolumeOptions: noCopy,
          },
        ],
        Tmpfs: {
          ...Object.fromEntries(web.tmpfs.map((path) => [path, tmpfs(web.user, '64m')])),
          [SETTINGS_DIR]: tmpfs(web.user, '1m'),
        },
      },
      NetworkingConfig: {
        EndpointsConfig: fixedAddress(
          network.id,
          subnetAddress(network.subnet, previewAddresses.web),
        ),
      },
    },
    identityOf(spec),
    'web',
    spec.expiresAt,
    // The CLI containers copy the rest of their options from this one.
    { [CLI_IMAGE_LABEL]: spec.images.cli, [HOSTNAME_LABEL]: spec.hostname },
    // The server reads its configuration at start only: another one is another container.
    web.configFiles,
  )
}

/**
 * The passwords of the database as files of its tmpfs (owner's answer of 19.10.2026: from Vault,
 * never in the container's environment, where `docker inspect` shows them): the image's
 * entrypoint reads them through `MARIADB_*_PASSWORD_FILE` and unsets them before the server.
 */
export const DATABASE_SECRET_DIR = '/run/raditi/db'
export const DATABASE_SECRET_FILES = Object.freeze({
  user: `${DATABASE_SECRET_DIR}/user`,
  root: `${DATABASE_SECRET_DIR}/root`,
})
/**
 * Which passwords the database was made with: a hash, so that a call with others is a CONFLICT
 * at once — the users live in the volume and would refuse them — and never the passwords.
 */
export const DATABASE_SECRET_LABEL = `${PREVIEW_LABEL}db-secret`
export const databaseSecretMark = (passwords: PreviewDatabasePasswords): string =>
  createHash('sha256')
    .update(`raditi-preview-db\0${passwords.user}\0${passwords.root}`)
    .digest('hex')

/**
 * The image's entrypoint starts once `ensure` wrote both password files into the tmpfs — at the
 * first start and after any restart, which empties it: a fixed script of the image's /bin/sh.
 */
export const WAIT_FOR_DATABASE_SECRETS = [
  'i=0',
  `while [ ! -f ${DATABASE_SECRET_FILES.user} ] || [ ! -f ${DATABASE_SECRET_FILES.root} ]; do i=$((i+1)); if [ "$i" -gt 600 ]; then exit 70; fi; sleep 0.2; done`,
  'exec "$@"',
].join('; ')

export function databaseContainer(
  spec: PreviewRuntimeSpec,
  network: NetworkPlace,
  passwords: PreviewDatabasePasswords,
): Docker.ContainerCreateOptions {
  const names = previewNames(spec.previewId)
  return labelled(
    {
      name: names.container('db'),
      Image: spec.images.db!,
      User: DATABASE_USER,
      // The image's own entrypoint and command (an official MariaDB image), after the wait.
      Entrypoint: ['/bin/sh', '-c', WAIT_FOR_DATABASE_SECRETS, 'raditi-preview-db'],
      Cmd: ['docker-entrypoint.sh', 'mariadbd'],
      Env: [
        `MARIADB_DATABASE=${PREVIEW_DATABASE.name}`,
        `MARIADB_USER=${PREVIEW_DATABASE.user}`,
        `MARIADB_PASSWORD_FILE=${DATABASE_SECRET_FILES.user}`,
        `MARIADB_ROOT_PASSWORD_FILE=${DATABASE_SECRET_FILES.root}`,
        // Root only on the container's own socket: the PHP of the preview gets the user above.
        'MARIADB_ROOT_HOST=localhost',
      ],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(spec.limits, spec.runtime),
        NetworkMode: network.id,
        // Copied up on first mount: the data folder belongs to the image's database user.
        Mounts: [{ Type: 'volume', Source: names.databaseVolume, Target: '/var/lib/mysql' }],
        Tmpfs: {
          '/run/mysqld': tmpfs(DATABASE_USER, '4m').replace('mode=0700', 'mode=0755'),
          '/tmp': tmpfs(DATABASE_USER, '256m'),
          [DATABASE_SECRET_DIR]: tmpfs(DATABASE_USER, '1m'),
        },
      },
      NetworkingConfig: {
        EndpointsConfig: fixedAddress(
          network.id,
          subnetAddress(network.subnet, previewAddresses.db),
        ),
      },
    },
    identityOf(spec),
    'db',
    spec.expiresAt,
    { [DATABASE_SECRET_LABEL]: databaseSecretMark(passwords) },
  )
}

/**
 * The entry forwarder: on the default bridge (Docker publishes no port of an internal network)
 * and on the preview's network, from PREVIEW_UPSTREAM_HOST:<random> to the PHP container. Its
 * port is the preview's only while this container lives: Docker hands it to another preview once
 * it stops, so the forwarder answers 421 to a request for any host but the preview's own
 * (infra/preview/forward.mjs, `--http-host`).
 */
export function forwarderContainer(
  spec: PreviewRuntimeSpec,
  network: NetworkPlace,
): Docker.ContainerCreateOptions {
  const target = `${subnetAddress(network.subnet, previewAddresses.web)}:${spec.recipe.web.port}`
  return labelled(
    {
      name: previewNames(spec.previewId).container('forwarder'),
      Image: spec.images.forwarder,
      User: SERVICE_USER,
      Entrypoint: node('forward.mjs'),
      Cmd: [`--http-host=${spec.hostname}`, `0.0.0.0:${FORWARD_PORT}=${target}`],
      Env: [],
      ExposedPorts: { [`${FORWARD_PORT}/tcp`]: {} },
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(previewServiceLimits.forwarder),
        NetworkMode: 'bridge',
        PortBindings: { [`${FORWARD_PORT}/tcp`]: [{ HostIp: spec.upstreamHost, HostPort: '' }] },
        Tmpfs: { [posix.dirname(FORWARD_READY_FILE)]: tmpfs(SERVICE_USER, '1m') },
        Sysctls: serviceSysctls,
      },
    },
    identityOf(spec),
    'forwarder',
    spec.expiresAt,
  )
}

/**
 * The egress proxy slot (Р13): its image is the allow-listing proxy (infra/sandbox/client-egress
 * .mjs, the `client-egress` target of infra/sandbox/Dockerfile, slice R10), which listens on
 * LISTEN_HOST:LISTEN_PORT of the preview's network, lets through only `ALLOWED_HOSTS` (a JSON
 * array of `host:port`) and never connects to REFUSED_SUBNETS. Its entrypoint is the image's.
 */
export function egressContainer(
  spec: PreviewRuntimeSpec,
  network: NetworkPlace,
  refusedSubnets: readonly string[] = [],
): Docker.ContainerCreateOptions {
  return labelled(
    {
      name: previewNames(spec.previewId).container('egress'),
      Image: spec.images.egress!,
      User: SERVICE_USER,
      Env: [
        `LISTEN_HOST=${subnetAddress(network.subnet, previewAddresses.egress)}`,
        `LISTEN_PORT=${EGRESS_PORT}`,
        `ALLOWED_HOSTS=${JSON.stringify(spec.egress)}`,
        ...(refusedSubnets.length ? [`REFUSED_SUBNETS=${refusedSubnets.join(',')}`] : []),
      ],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(previewServiceLimits.forwarder),
        NetworkMode: 'bridge',
        Tmpfs: { '/tmp': tmpfs(SERVICE_USER, '16m') },
        Sysctls: serviceSysctls,
      },
    },
    identityOf(spec),
    'egress',
    spec.expiresAt,
  )
}

/** Short-lived helpers sleep until their exec is done; the runtime removes them after it. */
const sleeper = (seconds: number) => ['/usr/bin/tini', '--', 'sleep', String(Math.ceil(seconds))]

/**
 * The files helper: the docroot volume and nothing else — no network, no other mount. `root`
 * prepares a new volume once (its owner becomes the PHP user); every write runs as that user.
 */
export function filesHelperContainer(input: {
  identity: PreviewIdentity
  deadline: number
  image: string
  runtime: PreviewRuntimeKind
  user: string
  root: boolean
  seconds: number
  suffix: string
}): Docker.ContainerCreateOptions {
  return labelled(
    {
      name: previewNames(input.identity.previewId).container('files-helper', input.suffix),
      Image: input.image,
      User: input.root ? '0:0' : input.user,
      Entrypoint: sleeper(input.seconds),
      Cmd: [],
      Env: [],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(previewServiceLimits.helper, input.runtime),
        // Only to give a new, empty volume to the PHP user: no DAC_OVERRIDE, nothing else.
        ...(input.root ? { CapAdd: ['CHOWN'] } : {}),
        NetworkMode: 'none',
        Mounts: [
          {
            Type: 'volume',
            Source: previewNames(input.identity.previewId).filesVolume,
            Target: FILES_ROOT,
            ReadOnly: false,
            VolumeOptions: noCopy,
          },
        ],
        Tmpfs: { '/tmp': tmpfs(input.root ? '0:0' : input.user, '16m') },
      },
    },
    input.identity,
    'files-helper',
    input.deadline,
  )
}

/** A CLI container: the web container's mounts, user, network and limits, the CLI image. */
export function cliContainer(input: {
  web: Docker.ContainerInspectInfo
  identity: PreviewIdentity
  deadline: number
  image: string
  seconds: number
  suffix: string
}): Docker.ContainerCreateOptions {
  const host = input.web.HostConfig
  const user = input.web.Config.User
  const docroot = input.web.Mounts.find((mount) => mount.Type === 'volume')
  if (!docroot?.Name || !host.NetworkMode) throw new Error('Preview web container is incomplete')
  return labelled(
    {
      name: previewNames(input.identity.previewId).container('cli', input.suffix),
      Image: input.image,
      User: user,
      Entrypoint: ['sleep', String(Math.ceil(input.seconds))],
      Cmd: [],
      Env: [
        ...(input.web.Config.Env ?? []).filter((entry) => !entry.startsWith('HOME=')),
        'HOME=/tmp',
      ],
      WorkingDir: docroot.Destination,
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(
          {
            cpu: (host.NanoCpus ?? 1e9) / 1e9,
            memoryMiB: Math.round((host.Memory ?? 0) / 1024 / 1024),
            pids: host.PidsLimit ?? 256,
          },
          host.Runtime as PreviewRuntimeKind,
        ),
        NetworkMode: host.NetworkMode,
        ExtraHosts: host.ExtraHosts ?? [],
        Mounts: [
          {
            Type: 'volume',
            Source: docroot.Name,
            Target: docroot.Destination,
            ReadOnly: false,
            VolumeOptions: noCopy,
          },
        ],
        Tmpfs: { '/tmp': tmpfs(user, '256m'), [SETTINGS_DIR]: tmpfs(user, '1m') },
      },
    },
    input.identity,
    'cli',
    input.deadline,
  )
}

/**
 * The browser relay (Р21): on the default bridge and on the browser's network. It carries the
 * browser's proxy traffic to the gateway of the `preview` role and publishes the browser's
 * control port on the host loopback only.
 */
export function relayContainer(input: {
  identity: PreviewIdentity
  deadline: number
  image: string
  network: NetworkPlace
  gatewayHost: string
  gatewayPort: number
}): Docker.ContainerCreateOptions {
  const relay = subnetAddress(input.network.subnet, browserAddresses.relay)
  const browser = subnetAddress(input.network.subnet, browserAddresses.browser)
  return labelled(
    {
      name: previewNames(input.identity.previewId).container('relay'),
      Image: input.image,
      User: SERVICE_USER,
      Entrypoint: node('forward.mjs'),
      Cmd: [
        `${relay}:${RELAY_PROXY_PORT}=${input.gatewayHost}:${input.gatewayPort}`,
        `0.0.0.0:${BROWSER_CONTROL_PORT}=${browser}:${BROWSER_CONTROL_PORT}`,
      ],
      Env: [],
      ExposedPorts: { [`${BROWSER_CONTROL_PORT}/tcp`]: {} },
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(previewServiceLimits.forwarder),
        NetworkMode: 'bridge',
        ...(input.gatewayHost === 'host.docker.internal'
          ? { ExtraHosts: ['host.docker.internal:host-gateway'] }
          : {}),
        PortBindings: {
          [`${BROWSER_CONTROL_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }],
        },
        Tmpfs: { [posix.dirname(FORWARD_READY_FILE)]: tmpfs(SERVICE_USER, '1m') },
        Sysctls: serviceSysctls,
      },
    },
    input.identity,
    'relay',
    input.deadline,
  )
}

/** The browser (infra/preview/Dockerfile, target `browser`): its own network, the relay only. */
export function browserContainer(input: {
  identity: PreviewIdentity
  deadline: number
  image: string
  runtime: PreviewRuntimeKind
  network: NetworkPlace
  hostname: string
}): Docker.ContainerCreateOptions {
  const relay = subnetAddress(input.network.subnet, browserAddresses.relay)
  const browser = subnetAddress(input.network.subnet, browserAddresses.browser)
  const limits = previewServiceLimits.browser
  return labelled(
    {
      name: previewNames(input.identity.previewId).container('browser'),
      Image: input.image,
      User: SERVICE_USER,
      Entrypoint: ['/usr/bin/tini', '--', '/usr/bin/node', `${TOOLS}/browser/server.mjs`],
      Cmd: [
        `--host=${browser}`,
        `--port=${BROWSER_CONTROL_PORT}`,
        `--proxy=http://${relay}:${RELAY_PROXY_PORT}`,
      ],
      Env: ['HOME=/tmp'],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(limits, input.runtime),
        NetworkMode: input.network.id,
        ShmSize: limits.shmMiB * 1024 * 1024,
        Tmpfs: {
          '/tmp': tmpfs(SERVICE_USER, '512m').replace('noexec,', ''),
          [BROWSER_STATE_DIR]: tmpfs(SERVICE_USER, '1m'),
        },
      },
      NetworkingConfig: { EndpointsConfig: fixedAddress(input.network.id, browser) },
    },
    input.identity,
    'browser',
    input.deadline,
    { [HOSTNAME_LABEL]: input.hostname },
  )
}

/**
 * The lease: created, never started. Labels cannot change, so a later deadline is a new lease;
 * the watchdog keeps a preview while any of its resources' deadlines is ahead.
 */
export function leaseContainer(input: {
  identity: PreviewIdentity
  deadline: number
  image: string
}): Docker.ContainerCreateOptions {
  return labelled(
    {
      name: previewNames(input.identity.previewId).container('lease', String(input.deadline)),
      Image: input.image,
      User: SERVICE_USER,
      Entrypoint: ['/bin/false'],
      Cmd: [],
      Env: [],
      HostConfig: { ...hardened(previewServiceLimits.forwarder), NetworkMode: 'none' },
    },
    input.identity,
    'lease',
    input.deadline,
  )
}

/** host-firewall.mjs in the host network namespace: runc, NET_ADMIN only, no Docker socket. */
export function firewallContainer(input: {
  identity: PreviewIdentity
  image: string
  args: string[]
  suffix: string
}): Docker.ContainerCreateOptions {
  return hostFirewallOptions({
    name: previewNames(input.identity.previewId).container('firewall', input.suffix),
    image: input.image,
    args: input.args,
    labels: previewLabels(input.identity, 'firewall', Date.now() + 60_000),
  })
}

/** The host firewall helper under any name and labels: the browser sessions run it too. */
export function hostFirewallOptions(input: {
  name: string
  image: string
  args: string[]
  labels: Record<string, string>
}): Docker.ContainerCreateOptions {
  return {
    name: input.name,
    Image: input.image,
    User: '0:0',
    Entrypoint: ['tini', '--', '/usr/local/bin/node', `${TOOLS}/host-firewall.mjs`],
    Cmd: input.args,
    Labels: input.labels,
    HostConfig: {
      Runtime: 'runc',
      NetworkMode: 'host',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: ['NET_ADMIN'],
      SecurityOpt: ['no-new-privileges'],
      NanoCpus: 250_000_000,
      Memory: 64 * 1024 * 1024,
      MemorySwap: 64 * 1024 * 1024,
      PidsLimit: 16,
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      LogConfig: logConfig,
      Tmpfs: { '/run': 'rw,noexec,nosuid,nodev,size=1m,mode=0755' },
    },
  }
}
