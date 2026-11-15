import type Docker from 'dockerode'

import { commandError } from '../docker-api.ts'

/**
 * What the containers of a browser session share (docs/plan/57-browser-tasks.md, Б10, Б11): the
 * paths and ports of the tools and browser images (infra/preview/Dockerfile), the hardening of
 * every container and the bridge without a host address. Kept from the runtime of previews, which
 * went with projects (docs/plan/83-remove-projects.md).
 */

/** The tools image (infra/preview/Dockerfile, target `tools`): forwarders and the files helper. */
export const TOOLS = '/usr/local/lib/raditi'
/** The egress proxy of a browser session (containers.ts). */
export const EGRESS_PORT = 3128
export const BROWSER_CONTROL_PORT = 9333
export const BROWSER_STATE_DIR = '/run/raditi/browser'
export const BROWSER_SECRET_FILE = `${BROWSER_STATE_DIR}/ws-path`
export const BROWSER_READY_FILE = `${BROWSER_STATE_DIR}/ready`
export const FORWARD_READY_FILE = '/run/raditi-forward/ready'
export const SERVICE_USER = '10001:10001'

/** The limits of the containers of a session. */
export const serviceLimits = Object.freeze({
  /** The egress proxy and the forwarder of the control port. */
  forwarder: { cpu: 0.25, memoryMiB: 128, pids: 64 },
  browser: { cpu: 1, memoryMiB: 1536, pids: 512, shmMiB: 256 },
})

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
 * sentry), not the processes inside it: below this the sandbox dies at a busy moment. Measured
 * 17.10.2026 (Colima, 4 vCPU, runsc systrap): with 32, five of eight execs of Node in a fresh
 * container ended in `WaitPID failed: EOF`; from 48 up, none.
 */
export const RUNSC_MIN_PIDS = 128

/** What every container of a session shares: no privilege, no writable root, bounded. */
export function hardened(limits: Limits, runtime?: 'runc' | 'runsc'): Docker.HostConfig {
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

export interface NetworkPlace {
  id: string
  subnet: string
}

/** host-firewall.mjs in the host network namespace: runc, NET_ADMIN only, no Docker socket. */
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

/**
 * Fail closed on what Docker built, not on the options it was asked for: a bridge of a browser
 * session has no host address at all (spec §8), so nothing on it reaches the host's services or
 * the internet.
 */
export function isHostlessBridge(network: Docker.NetworkInspectInfo, bridge: string): boolean {
  const configs = network.IPAM?.Config ?? []
  const options = network.Options ?? {}
  return (
    network.Driver === 'bridge' &&
    network.Internal &&
    !network.EnableIPv6 &&
    options['com.docker.network.bridge.name'] === bridge &&
    options['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated' &&
    options['com.docker.network.bridge.gateway_mode_ipv6'] === 'isolated' &&
    configs.length === 1 &&
    !configs[0]!.Gateway
  )
}

/** The create options of a hostless bridge. */
export const hostlessBridge = (
  name: string,
  bridge: string,
  labels: Record<string, string>,
): Docker.NetworkCreateOptions => ({
  Name: name,
  Driver: 'bridge',
  Internal: true,
  EnableIPv6: false,
  Labels: labels,
  Options: {
    'com.docker.network.bridge.name': bridge,
    'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
    'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
  },
})

/**
 * Fixed addresses on a subnet Docker picked (Docker Engine ≥ 29.1): `offset` from the network
 * address. Without a gateway Docker hands out `.1` and up to the containers it addresses itself,
 * so the fixed ones are asked for before those exist.
 */
export function subnetAddress(cidr: string, offset: number): string {
  const [host, prefix] = cidr.split('/')
  const octets = host?.split('.').map(Number)
  if (
    !octets ||
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    !prefix ||
    !/^\d+$/.test(prefix) ||
    +prefix < 8 ||
    +prefix > 28
  )
    throw commandError()
  const number = octets.reduce((value, part) => value * 256 + part, 0)
  const block = 2 ** (32 - +prefix)
  if (number % block !== 0 || offset < 1 || offset >= block - 1) throw commandError()
  return [24, 16, 8, 0].map((shift) => ((number + offset) >>> shift) & 255).join('.')
}
