import { createHash } from 'node:crypto'

import type Docker from 'dockerode'

import { commandError } from '../docker-api.ts'

/**
 * Names, labels and addresses of a preview's Docker resources (docs/plan/53-chat-preview-release.md,
 * Р18). Everything a preview owns carries `io.raditi.preview.{owner,protocol,id,site,task,deadline,
 * role}`; the host watchdog (infra/sandbox/watchdog.mjs) reads the same labels and the same names.
 */
export const PREVIEW_LABEL = 'io.raditi.preview.'
export const PREVIEW_OWNER = 'raditi'
/**
 * 2 — the preview of one container (docs/plan/58). The runtime still reads protocol 1, the
 * preview of several containers on an internal bridge: `ensure` destroys such a preview and builds
 * it anew, `destroy` and `list` see it, the watchdog removes it by its deadline.
 */
export const PREVIEW_PROTOCOL = '2'
export const previewProtocols = ['1', PREVIEW_PROTOCOL] as const

export const previewRoles = [
  'network',
  'browser-network',
  'files',
  'database',
  'lease',
  'preview',
  'files-helper',
  'relay',
  'browser',
  'firewall',
  // Protocol 1 only: the containers the preview's own replaced.
  'web',
  'db',
  'forwarder',
  'egress',
  'cli',
] as const
export type PreviewRole = (typeof previewRoles)[number]

/** The roles of protocol 1 whose presence says the preview has to be built anew. */
export const legacyPreviewRoles: readonly PreviewRole[] = [
  'web',
  'db',
  'forwarder',
  'egress',
  'cli',
]

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
export const isPreviewId = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value)

export interface PreviewIdentity {
  previewId: string
  siteId: string
  taskId: string
}

/** The labels of one resource; `deadline` is epoch milliseconds. */
export function previewLabels(
  identity: PreviewIdentity,
  role: PreviewRole,
  deadline: number,
): Record<string, string> {
  return {
    [`${PREVIEW_LABEL}owner`]: PREVIEW_OWNER,
    [`${PREVIEW_LABEL}protocol`]: PREVIEW_PROTOCOL,
    [`${PREVIEW_LABEL}id`]: identity.previewId,
    [`${PREVIEW_LABEL}site`]: identity.siteId,
    [`${PREVIEW_LABEL}task`]: identity.taskId,
    [`${PREVIEW_LABEL}deadline`]: String(deadline),
    [`${PREVIEW_LABEL}role`]: role,
  }
}

/**
 * The Docker label filter of everything of one preview, or of every preview, of either protocol:
 * `ownedIdentity` then tells them apart.
 */
export function previewFilter(previewId?: string, role?: PreviewRole) {
  return {
    label: [
      `${PREVIEW_LABEL}owner=${PREVIEW_OWNER}`,
      ...(previewId ? [`${PREVIEW_LABEL}id=${previewId}`] : []),
      ...(role ? [`${PREVIEW_LABEL}role=${role}`] : []),
    ],
  }
}

/** Ours: owner, a protocol the runtime reads and id as asked; null for anything else. */
export function ownedIdentity(
  labels: Record<string, string> | undefined,
): (PreviewIdentity & { role: PreviewRole; deadline: number; protocol: string }) | null {
  const protocol = labels?.[`${PREVIEW_LABEL}protocol`]
  if (
    !labels ||
    labels[`${PREVIEW_LABEL}owner`] !== PREVIEW_OWNER ||
    !(previewProtocols as readonly (string | undefined)[]).includes(protocol)
  )
    return null
  const previewId = labels[`${PREVIEW_LABEL}id`]
  const siteId = labels[`${PREVIEW_LABEL}site`]
  const taskId = labels[`${PREVIEW_LABEL}task`]
  const role = labels[`${PREVIEW_LABEL}role`] as PreviewRole
  const deadline = Number(labels[`${PREVIEW_LABEL}deadline`])
  if (
    !isPreviewId(previewId) ||
    !isPreviewId(siteId) ||
    !isPreviewId(taskId) ||
    !previewRoles.includes(role) ||
    !Number.isSafeInteger(deadline) ||
    deadline < 1
  )
    return null
  return { previewId, siteId, taskId, role, deadline, protocol: protocol! }
}

/**
 * 12 hex of SHA-256 of the id, not of the id itself: a preview id is a UUIDv7, whose first 48
 * bits are its creation time, so two previews of one millisecond would share a bridge name, and
 * Docker refuses the second network for as long as the first one lives.
 */
const compact = (previewId: string) =>
  createHash('sha256').update(previewId).digest('hex').slice(0, 12)

/** Linux bridges (≤ 15 bytes): the host firewall rule under runsc is keyed by these names. */
export const previewBridge = (previewId: string): string => `rpv${compact(previewId)}`
export const browserBridge = (previewId: string): string => `rpb${compact(previewId)}`

export const previewNames = (previewId: string) => ({
  network: `raditi-preview-${previewId}`,
  browserNetwork: `raditi-preview-${previewId}-browser`,
  filesVolume: `rpv-${previewId}-files`,
  databaseVolume: `rpv-${previewId}-db`,
  container: (role: PreviewRole, suffix?: string) =>
    `raditi-preview-${previewId}-${role}${suffix ? `-${suffix}` : ''}`,
})

/**
 * The preview's own bridge (docs/plan/58): not internal — Docker publishes no port of an internal
 * network, and the preview's internet is open — one container on it, no IPv6. What it reaches of
 * the host, the private networks and the platform is closed by host-firewall.mjs before the
 * container starts. Checked on what Docker built, not on the options it was asked for.
 */
export function isPreviewBridge(network: Docker.NetworkInspectInfo, bridge: string): boolean {
  const configs = network.IPAM?.Config ?? []
  const options = network.Options ?? {}
  return (
    network.Driver === 'bridge' &&
    !network.Internal &&
    !network.EnableIPv6 &&
    options['com.docker.network.bridge.name'] === bridge &&
    options['com.docker.network.bridge.enable_icc'] === 'false' &&
    configs.length === 1
  )
}

/** The create options of a preview's own bridge. */
export const previewBridgeOptions = (
  name: string,
  bridge: string,
  labels: Record<string, string>,
): Docker.NetworkCreateOptions => ({
  Name: name,
  Driver: 'bridge',
  Internal: false,
  EnableIPv6: false,
  Labels: labels,
  Options: {
    'com.docker.network.bridge.name': bridge,
    // One container on it; nothing else that joins talks to it on the bridge itself.
    'com.docker.network.bridge.enable_icc': 'false',
  },
})

/**
 * Fail closed on what Docker built, not on the options it was asked for: a bridge of the agent's
 * browser has no host address at all (spec §8), so nothing on it reaches the host's services or
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

/** The create options of a hostless preview bridge. */
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

/** Offsets of the fixed addresses on the network of the agent's browser. */
export const browserAddresses = Object.freeze({ relay: 2, browser: 3 })
