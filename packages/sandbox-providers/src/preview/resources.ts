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
export const PREVIEW_PROTOCOL = '1'

export const previewRoles = [
  'network',
  'browser-network',
  'files',
  'database',
  'lease',
  'web',
  'db',
  'forwarder',
  'egress',
  'cli',
  'files-helper',
  'relay',
  'browser',
  'firewall',
] as const
export type PreviewRole = (typeof previewRoles)[number]

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

/** The Docker label filter of everything of one preview, or of every preview. */
export function previewFilter(previewId?: string, role?: PreviewRole) {
  return {
    label: [
      `${PREVIEW_LABEL}owner=${PREVIEW_OWNER}`,
      `${PREVIEW_LABEL}protocol=${PREVIEW_PROTOCOL}`,
      ...(previewId ? [`${PREVIEW_LABEL}id=${previewId}`] : []),
      ...(role ? [`${PREVIEW_LABEL}role=${role}`] : []),
    ],
  }
}

/** Ours: owner, protocol and id as asked; null for anything else. */
export function ownedIdentity(
  labels: Record<string, string> | undefined,
): (PreviewIdentity & { role: PreviewRole; deadline: number }) | null {
  if (
    !labels ||
    labels[`${PREVIEW_LABEL}owner`] !== PREVIEW_OWNER ||
    labels[`${PREVIEW_LABEL}protocol`] !== PREVIEW_PROTOCOL
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
  return { previewId, siteId, taskId, role, deadline }
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
 * Fail closed on what Docker built, not on the options it was asked for: a preview bridge has no
 * host address at all (spec §8), so nothing on it reaches the host's services or the internet.
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

/** Offsets of the fixed addresses on the preview's network and on its browser's network. */
export const previewAddresses = Object.freeze({ web: 2, db: 3, forwarder: 4, egress: 5 })
export const browserAddresses = Object.freeze({ relay: 2, browser: 3 })
