import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import {
  PREVIEW_SETTINGS_PATH,
  type PreviewDatabasePasswords,
  type PreviewRuntimeKind,
  type PreviewRuntimeSpec,
} from '@repo/domain'
import type Docker from 'dockerode'

import { previewRuntimeLimits, previewServiceLimits } from './config.ts'
import {
  browserAddresses,
  previewLabels,
  previewNames,
  PREVIEW_LABEL,
  subnetAddress,
  type PreviewIdentity,
  type PreviewRole,
} from './resources.ts'

/**
 * Create options of a preview's containers (docs/plan/53-chat-preview-release.md, Р18; docs/plan/58):
 * pure, so every hardening flag is visible in one place and checked by tests. The preview itself,
 * the files helper and the browser run the preview's runtime (gVisor in production); the
 * platform's relay of the browser, which parses nothing, runs the daemon's default like
 * sandbox-gw.
 */

export const SETTINGS_DIR = posix.dirname(PREVIEW_SETTINGS_PATH)
/** The tools image (infra/preview/Dockerfile, target `tools`): forwarders and the files helper. */
export const TOOLS = '/usr/local/lib/raditi'
export const FORWARD_PORT = 8080
/** The egress proxy of a browser session of a task (browser-session/containers.ts). */
export const EGRESS_PORT = 3128
export const RELAY_PROXY_PORT = 3128
export const BROWSER_CONTROL_PORT = 9333
export const BROWSER_STATE_DIR = '/run/raditi/browser'
export const BROWSER_SECRET_FILE = `${BROWSER_STATE_DIR}/ws-path`
export const BROWSER_READY_FILE = `${BROWSER_STATE_DIR}/ready`
export const FORWARD_READY_FILE = '/run/raditi-forward/ready'
/** Where the files helper mounts the docroot volume (infra/preview/files.mjs ROOT). */
export const FILES_ROOT = '/files'
/** The database the preview's container runs: one per preview, on its loopback (docs/plan/58). */
export const PREVIEW_DATABASE = Object.freeze({
  name: 'preview',
  user: 'preview',
  host: '127.0.0.1',
  port: 3306,
})
/** The official MariaDB image runs as `mysql`; its data folder is that user's on first mount. */
export const DATABASE_USER = '999:999'
export const SERVICE_USER = '10001:10001'
export const CONFIG_LABEL = `${PREVIEW_LABEL}config`
export const HOSTNAME_LABEL = `${PREVIEW_LABEL}hostname`
/** The PHP user of a preview's container: the files helper writes the docroot as that user. */
export const WEB_USER_LABEL = `${PREVIEW_LABEL}web-user`
/** The image of the platform's tools a preview was built with: its helpers and relay take it. */
export const TOOLS_IMAGE_LABEL = `${PREVIEW_LABEL}tools-image`

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

/**
 * Where the services of the preview's container keep their state (infra/preview/init.sh,
 * docs/plan/58, «Договор срезов»): each a tmpfs of its own user, emptied by a restart, so `ensure`
 * writes the settings and the passwords again after one.
 */
export const DATABASE_SECRET_DIR = '/run/raditi/db'
export const DATABASE_SECRET_FILES = Object.freeze({
  user: `${DATABASE_SECRET_DIR}/user`,
  root: `${DATABASE_SECRET_DIR}/root`,
})
/**
 * The staging database of a dump (staging.ts) runs the official MariaDB image: its entrypoint
 * starts once both password files are in the tmpfs — a fixed script of the image's /bin/sh.
 */
export const WAIT_FOR_DATABASE_SECRETS = [
  'i=0',
  `while [ ! -f ${DATABASE_SECRET_FILES.user} ] || [ ! -f ${DATABASE_SECRET_FILES.root} ]; do i=$((i+1)); if [ "$i" -gt 600 ]; then exit 70; fi; sleep 0.2; done`,
  'exec "$@"',
].join('; ')
export const READY_DIR = '/run/raditi/ready'
/** init.sh writes it once the database answers. */
export const DATABASE_READY_FILE = `${READY_DIR}/db`
/** init.sh runs a command of the platform as a user: `run-as.sh <uid:gid> <seconds> -- argv…`. */
export const RUN_AS = `${TOOLS}/run-as.sh`
/** The capabilities init needs to start each service as its own user, and only at the start. */
export const PREVIEW_START_CAPS = ['SETUID', 'SETGID', 'SETPCAP'] as const

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
 * The preview (docs/plan/58): one container of the site's server, its database and its entry
 * gateway, each service under a user of its own (infra/preview/init.sh). Its own bridge, which is
 * not internal — a port is published from it, and its internet is open (owner's answer of
 * 26.10.2026) — with the host rules that close the host, the private networks and the platform
 * (host-firewall.mjs) put before it starts. The port of the gateway is the preview's only while
 * this container lives: the gateway answers 421 to a request for any host but the preview's own
 * (infra/preview/forward.mjs, `--http-host`).
 */
export function previewContainer(input: {
  spec: PreviewRuntimeSpec
  network: NetworkPlace
  dnsServers: readonly string[]
  passwords: PreviewDatabasePasswords | null
}): Docker.ContainerCreateOptions {
  const { spec, network } = input
  const web = spec.recipe.web
  const names = previewNames(spec.previewId)
  const database = spec.database && input.passwords !== null
  return labelled(
    {
      name: names.container('preview'),
      Image: spec.images.preview,
      // init starts each service as its own user and keeps no capability itself.
      User: '0:0',
      Entrypoint: ['/usr/bin/tini', '--', `${TOOLS}/init.sh`],
      Cmd: [...web.command],
      Env: [
        ...Object.entries(web.env).map(([name, value]) => `${name}=${value}`),
        `RADITI_HTTP_HOST=${spec.hostname}`,
        `RADITI_WEB_PORT=${web.port}`,
        `RADITI_DATABASE=${database ? '1' : '0'}`,
        // The servers the forwarder of names inside asks (infra/preview/dns.mjs): it listens on
        // 127.0.0.11:53, where /etc/resolv.conf points — gVisor never reaches Docker's resolver
        // there, and a read-only root file system keeps that file as Docker wrote it (docs/plan/58).
        `RADITI_DNS_SERVERS=${input.dnsServers.join(',')}`,
      ],
      WorkingDir: web.docroot,
      ExposedPorts: { [`${FORWARD_PORT}/tcp`]: {} },
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(spec.limits, spec.runtime),
        CapAdd: [...PREVIEW_START_CAPS],
        NetworkMode: network.id,
        // Under runc Docker's resolver answers at 127.0.0.11 before the forwarder: these are the
        // servers it asks, so both runtimes resolve by the same ones.
        Dns: [...input.dnsServers],
        PortBindings: { [`${FORWARD_PORT}/tcp`]: [{ HostIp: spec.upstreamHost, HostPort: '' }] },
        Mounts: [
          {
            Type: 'volume',
            Source: names.filesVolume,
            Target: web.docroot,
            ReadOnly: false,
            VolumeOptions: noCopy,
          },
          ...(database
            ? [{ Type: 'volume' as const, Source: names.databaseVolume, Target: '/var/lib/mysql' }]
            : []),
        ],
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,nodev,size=256m,mode=1777',
          [SETTINGS_DIR]: tmpfs(web.user, previewRuntimeLimits.settingsTmpfs),
          [DATABASE_SECRET_DIR]: tmpfs(DATABASE_USER, '1m'),
          // The socket and the database's temporary files (init.sh: /run/mysqld/tmp, 0700).
          '/run/mysqld': tmpfs(DATABASE_USER, '256m').replace('mode=0700', 'mode=0755'),
          [posix.dirname(FORWARD_READY_FILE)]: tmpfs(SERVICE_USER, '1m'),
          [READY_DIR]: 'rw,noexec,nosuid,nodev,size=1m,mode=0755',
        },
        Sysctls: {
          'net.ipv6.conf.all.disable_ipv6': '1',
          // The forwarder of names, uid 10001 with no capability, binds port 53 of its loopback.
          'net.ipv4.ip_unprivileged_port_start': '0',
        },
      },
    },
    identityOf(spec),
    'preview',
    spec.expiresAt,
    {
      [HOSTNAME_LABEL]: spec.hostname,
      [WEB_USER_LABEL]: web.user,
      [TOOLS_IMAGE_LABEL]: spec.images.tools,
      ...(database && input.passwords
        ? { [DATABASE_SECRET_LABEL]: databaseSecretMark(input.passwords) }
        : {}),
    },
    // The server reads its configuration at start only: another one is another container.
    web.configFiles,
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
