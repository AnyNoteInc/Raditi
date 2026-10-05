import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  MAX_SANDBOX_TURN_MS,
  type NetworkPolicy,
  type SandboxLabels,
  type SandboxRuntime,
} from '@repo/domain'
import type Docker from 'dockerode'

import { bounded, commandError, createOwned, isMissing, startDetachedExec } from '../docker-api.ts'
import type { DockerGatewayManager } from '../gateway-types.ts'
import { gatewayConfigSchema, type GatewayConfig } from './config.ts'

const PREFIX = 'io.raditi.gateway.'
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const scopes = ['workspaceId', 'siteId', 'taskId', 'sessionId', 'turn', 'leaseEpoch'] as const
const SCRIPTS = '/usr/local/lib/raditi'
const logConfig = {
  Type: 'local',
  Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' },
}
const ownLabels = (resourceId: string): Record<string, string> => ({
  [`${PREFIX}owner`]: 'raditi',
  [`${PREFIX}protocol`]: '1',
  [`${PREFIX}resourceId`]: resourceId,
})
const ownFilter = (resourceId: string) => ({
  label: Object.entries(ownLabels(resourceId)).map(([key, value]) => `${key}=${value}`),
})
/** Every gateway object of one attempt carries these; containers and the network add a role. */
const gatewayLabels = (
  resourceId: string,
  deadline: number,
  policy: NetworkPolicy,
  labels: SandboxLabels,
) => ({
  ...ownLabels(resourceId),
  [`${PREFIX}deadline`]: String(deadline),
  [`${PREFIX}policy`]: JSON.stringify(policy),
  ...Object.fromEntries(
    scopes
      .filter((key) => labels[key] !== undefined)
      .map((key) => [`${PREFIX}${key}`, String(labels[key])]),
  ),
})
const labelsMatch = (
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
) => actual !== undefined && Object.entries(expected).every(([key, value]) => actual[key] === value)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const entrypoint = (program: string) => [
  'tini',
  '--',
  '/usr/local/bin/node',
  `${SCRIPTS}/${program}`,
]

/** Linux bridge of the attempt (≤ 15 bytes): the host firewall rule is keyed by this name. */
export const bridgeName = (resourceId: string): string =>
  `rdx${resourceId.replaceAll('-', '').slice(0, 12)}`

/**
 * Fail closed on what Docker built, not on the options it was asked for: an attempt bridge
 * must have no host address at all (spec §8), so the sandbox cannot reach host services.
 */
function hostless(network: Docker.NetworkInspectInfo, resourceId: string): boolean {
  const configs = network.IPAM?.Config ?? []
  const options = network.Options ?? {}
  return (
    network.Driver === 'bridge' &&
    network.Internal &&
    !network.EnableIPv6 &&
    options['com.docker.network.bridge.name'] === bridgeName(resourceId) &&
    options['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated' &&
    options['com.docker.network.bridge.gateway_mode_ipv6'] === 'isolated' &&
    configs.length === 1 &&
    !configs[0]!.Gateway
  )
}

function addresses(cidr: string): { gateway: string; client: string } {
  const [host, prefix] = cidr.split('/')
  const octets = host?.split('.').map(Number)
  if (
    !octets ||
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    !prefix ||
    !/^\d+$/.test(prefix) ||
    +prefix < 8 ||
    +prefix > 29
  )
    throw commandError()
  const number = octets.reduce((value, part) => value * 256 + part, 0)
  const block = 2 ** (32 - +prefix)
  if (number % block !== 0) throw commandError()
  const ip = (offset: number) =>
    [24, 16, 8, 0].map((shift) => ((number + offset) >>> shift) & 255).join('.')
  return { gateway: ip(2), client: ip(3) }
}

async function ready(
  container: Docker.Container,
  path: string,
  deadline: number,
  signal?: AbortSignal,
) {
  const until = Math.min(deadline, Date.now() + 15_000)
  while (Date.now() < until && !signal?.aborted) {
    const state = await bounded(container.inspect(), 3_000, signal)
    if (!state.State.Running) throw commandError()
    const exec = await bounded(
      container.exec({
        Cmd: ['/usr/bin/test', '-f', path],
        AttachStdout: false,
        AttachStderr: false,
      }),
      3_000,
      signal,
    )
    await startDetachedExec(exec, 3_000, signal)
    for (let attempt = 0; attempt < 10; attempt++) {
      const info = await bounded(exec.inspect(), 3_000, signal)
      if (!info.Running) {
        if (info.ExitCode === 0) return
        break
      }
      await delay(20)
    }
    await delay(100)
  }
  throw commandError()
}

/**
 * runc: the sandbox shares the netns of a guard container that drops everything but the gateway.
 * runsc: gVisor's netstack bypasses that netns filter, so the sandbox joins the hostless attempt
 * network directly and a host INPUT rule drops whatever its bridge sends to the host (spec §8).
 */
export function createDockerGatewayManager(
  configValue: GatewayConfig,
  docker: Docker,
  runtime: SandboxRuntime,
): DockerGatewayManager {
  const config = gatewayConfigSchema.parse(configValue)
  const runsc = runtime === 'runsc'

  /** host-firewall.mjs in the host netns: runc, NET_ADMIN only, no Docker socket, no network. */
  const hostFirewall = async (resourceId: string, args: string[], signal?: AbortSignal) => {
    const helper = await createOwned(
      docker.createContainer({
        // Unique: validations of one attempt may check its rule concurrently.
        name: `raditi-gateway-firewall-${resourceId}-${args[0]}-${randomUUID().slice(0, 8)}`,
        Image: config.guardImage,
        User: '0:0',
        Entrypoint: entrypoint('host-firewall.mjs'),
        Cmd: args,
        Labels: {
          ...ownLabels(resourceId),
          [`${PREFIX}role`]: 'firewall',
          [`${PREFIX}deadline`]: String(Date.now() + 60_000),
        },
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
      }),
      (created) => created.remove({ force: true, v: true }),
      signal,
    )
    let status: unknown
    try {
      await bounded(helper.start(), 10_000, signal)
      status = ((await bounded(helper.wait(), 20_000, signal)) as { StatusCode?: unknown })
        .StatusCode
    } finally {
      await bounded(helper.remove({ force: true, v: true })).catch((error: unknown) => {
        if (!isMissing(error)) throw commandError()
      })
    }
    if (status !== 0) throw commandError()
  }

  const releaseId = async (resourceId: string) => {
    if (!uuid.test(resourceId)) throw commandError()
    const own = ownLabels(resourceId)
    const filters = ownFilter(resourceId)
    type Owned = { Id: string; Labels?: Record<string, string> }
    // Containers first: the network can be removed only after nothing is attached to it.
    for (const [list, remove] of [
      [
        () => docker.listContainers({ all: true, filters }),
        (id: string) => docker.getContainer(id).remove({ force: true, v: true }),
      ],
      [() => docker.listNetworks({ filters }), (id: string) => docker.getNetwork(id).remove()],
    ] as [() => Promise<Owned[]>, (id: string) => Promise<unknown>][]) {
      const items = await bounded(list())
      const results = await Promise.allSettled(
        items.map(async (item) => {
          if (!labelsMatch(item.Labels, own)) throw commandError()
          try {
            await bounded(remove(item.Id))
          } catch (error) {
            if (!isMissing(error)) throw error
          }
        }),
      )
      if (results.some((result) => result.status === 'rejected')) throw commandError()
    }
    // The bridge is gone now; the sweep drops only rules whose bridge no longer exists. A failed
    // sweep is not a failed release: such a rule matches no interface, and the next install or
    // release sweeps it again.
    if (runsc)
      await hostFirewall(resourceId, ['sweep']).catch(() =>
        process.emitWarning('Sandbox host firewall sweep failed', {
          code: 'RADITI_SANDBOX_FIREWALL_SWEEP',
        }),
      )
  }

  const serviceHost = (networkMode: string, guard: boolean): Docker.HostConfig => ({
    NetworkMode: networkMode,
    ReadonlyRootfs: true,
    Privileged: false,
    CapDrop: ['ALL'],
    ...(guard ? { CapAdd: ['NET_ADMIN'] } : {}),
    SecurityOpt: ['no-new-privileges'],
    NanoCpus: 250_000_000,
    Memory: 128 * 1024 * 1024,
    MemorySwap: 128 * 1024 * 1024,
    PidsLimit: 32,
    RestartPolicy: { Name: 'no' },
    AutoRemove: false,
    LogConfig: logConfig,
    Tmpfs: {
      [guard ? '/run/raditi-guard' : '/run/raditi-gateway']:
        `rw,noexec,nosuid,nodev,size=1m,uid=${guard ? 0 : 10001},gid=${guard ? 0 : 10001},mode=0700`,
    },
    Sysctls: {
      'net.ipv6.conf.all.disable_ipv6': '1',
      'net.ipv6.conf.default.disable_ipv6': '1',
      'net.ipv4.ip_forward': '0',
    },
  })

  return {
    async prepare(input, signal) {
      const resourceId = randomUUID()
      const label = (role: string) => ({
        ...gatewayLabels(resourceId, input.deadline, input.policy, input.labels),
        [`${PREFIX}role`]: role,
      })
      try {
        if (
          signal?.aborted ||
          input.deadline <= Date.now() ||
          input.deadline > Date.now() + MAX_SANDBOX_TURN_MS
        )
          throw commandError()
        for (const image of [config.image, config.guardImage]) {
          const info = await bounded(docker.getImage(image).inspect(), 10_000, signal)
          if (Object.keys(info.Config?.Volumes ?? {}).length) throw commandError()
        }
        const network = await createOwned(
          docker.createNetwork({
            Name: `raditi-gateway-${resourceId}`,
            Driver: 'bridge',
            Internal: true,
            EnableIPv6: false,
            Labels: label('network'),
            Options: {
              'com.docker.network.bridge.name': bridgeName(resourceId),
              'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
              'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
            },
          }),
          (created) => created.remove(),
          signal,
        )
        const networkInfo = await bounded(network.inspect(), 10_000, signal)
        if (!hostless(networkInfo, resourceId)) throw commandError()
        const ips = addresses(networkInfo.IPAM!.Config![0]!.Subnet ?? '')
        // Before anything that runs code joins the bridge.
        if (runsc) await hostFirewall(resourceId, ['install', bridgeName(resourceId)], signal)
        // A fixed address on a subnet Docker picked needs Docker Engine 29.1: older engines
        // refuse it unless the subnet is user-configured, and the attempt fails right here.
        const endpoints = (ip: string): Docker.EndpointsConfig => ({
          [network.id]: { IPAMConfig: { IPv4Address: ip } },
        })
        const proxy = await createOwned(
          docker.createContainer({
            name: `raditi-gateway-proxy-${resourceId}`,
            Image: config.image,
            User: '10001:10001',
            Entrypoint: entrypoint('gateway.mjs'),
            Cmd: [],
            Labels: label('proxy'),
            Env: [
              `LISTEN_HOST=${ips.gateway}`,
              `CLIENT_IPV4=${ips.client}`,
              `ALLOWED_ROUTES=${JSON.stringify(input.policy.routes)}`,
              `LLM_UPSTREAM=${config.llmUpstream}`,
              `MCP_UPSTREAM=${config.mcpUpstream}`,
            ],
            HostConfig: {
              ...serviceHost(network.id, false),
              ExtraHosts: ['host.docker.internal:host-gateway'],
            },
            NetworkingConfig: { EndpointsConfig: endpoints(ips.gateway) },
          }),
          (created) => created.remove({ force: true, v: true }),
          signal,
        )
        await bounded(docker.getNetwork('bridge').connect({ Container: proxy.id }), 10_000, signal)
        await bounded(proxy.start(), 10_000, signal)
        await ready(proxy, '/run/raditi-gateway/ready', input.deadline, signal)
        const extraHosts = [`sandbox-gw:${ips.gateway}`]
        if (runsc)
          return {
            resourceId,
            networkMode: network.id,
            extraHosts,
            endpoints: endpoints(ips.client),
          }
        const guard = await createOwned(
          docker.createContainer({
            name: `raditi-gateway-guard-${resourceId}`,
            Image: config.guardImage,
            User: '0:0',
            Entrypoint: entrypoint('network-guard.mjs'),
            Cmd: [],
            Labels: label('guard'),
            Env: [`GATEWAY_IPV4=${ips.gateway}`, 'GATEWAY_PORT=8080'],
            HostConfig: { ...serviceHost(network.id, true), ExtraHosts: extraHosts },
            NetworkingConfig: { EndpointsConfig: endpoints(ips.client) },
          }),
          (created) => created.remove({ force: true, v: true }),
          signal,
        )
        await bounded(guard.start(), 10_000, signal)
        await ready(guard, '/run/raditi-guard/ready', input.deadline, signal)
        return { resourceId, networkMode: `container:${guard.id}`, extraHosts: [] }
      } catch {
        await releaseId(resourceId)
        throw commandError()
      }
    },
    async validate({ resourceId, labels, deadline, policy, sandbox }) {
      if (!uuid.test(resourceId)) return false
      try {
        const expected = gatewayLabels(resourceId, deadline, policy, labels)
        const filters = ownFilter(resourceId)
        // Short-lived firewall helpers of this attempt may be running; they never join its network.
        const resources = (await bounded(docker.listContainers({ all: true, filters }))).filter(
          (item) => item.Labels[`${PREFIX}role`] !== 'firewall',
        )
        const idOf = (role: string) =>
          resources.find((item) => item.Labels[`${PREFIX}role`] === role)?.Id
        const proxyId = idOf('proxy')
        const guardId = runsc ? undefined : idOf('guard')
        if (resources.length !== (runsc ? 1 : 2) || !proxyId || (!runsc && !guardId)) return false
        const networks = await bounded(docker.listNetworks({ filters }))
        if (networks.length !== 1) return false
        const network = await bounded(docker.getNetwork(networks[0]!.Id).inspect())
        if (!labelsMatch(network.Labels, expected) || !hostless(network, resourceId)) return false
        const ips = addresses(network.IPAM!.Config![0]!.Subnet ?? '')
        // Traffic inside the bridge is not filtered: only the sandbox side and its gateway attach.
        if (
          !same(
            Object.keys(network.Containers ?? {}).sort(),
            [runsc ? sandbox.Id : guardId, proxyId].sort(),
          )
        )
          return false
        const attached = Object.values(sandbox.NetworkSettings?.Networks ?? {})
        const host = sandbox.HostConfig
        if (
          runsc
            ? host.NetworkMode !== network.Id ||
              attached.length !== 1 ||
              attached[0]!.NetworkID !== network.Id ||
              attached[0]!.IPAddress !== ips.client ||
              !same(host.ExtraHosts, [`sandbox-gw:${ips.gateway}`])
            : host.NetworkMode !== `container:${guardId}` ||
              attached.length !== 0 ||
              (host.ExtraHosts?.length ?? 0) !== 0
        )
          return false
        for (const [id, isGuard] of [
          [proxyId, false],
          ...(guardId ? [[guardId, true] as const] : []),
        ] as const) {
          const info = await bounded(docker.getContainer(id).inspect())
          const service = info.HostConfig
          if (
            !info.State.Running ||
            !labelsMatch(info.Config.Labels, {
              ...expected,
              [`${PREFIX}role`]: isGuard ? 'guard' : 'proxy',
            }) ||
            info.Config.Image !== (isGuard ? config.guardImage : config.image) ||
            info.Config.User !== (isGuard ? '0:0' : '10001:10001') ||
            !service.ReadonlyRootfs ||
            service.Privileged ||
            service.PidMode ||
            service.IpcMode === 'host' ||
            (service.Binds?.length ?? 0) ||
            service.CapDrop?.join() !== 'ALL' ||
            (service.CapAdd?.join() ?? '') !== (isGuard ? 'NET_ADMIN' : '') ||
            service.SecurityOpt?.join() !== 'no-new-privileges' ||
            Object.keys(service.PortBindings ?? {}).length ||
            service.PublishAllPorts ||
            service.Sysctls?.['net.ipv4.ip_forward'] !== '0' ||
            service.Sysctls?.['net.ipv6.conf.all.disable_ipv6'] !== '1'
          )
            return false
          const joined = Object.values(info.NetworkSettings.Networks)
          if (
            joined.length !== (isGuard ? 1 : 2) ||
            joined.find((entry) => entry.NetworkID === network.Id)?.IPAddress !==
              (isGuard ? ips.client : ips.gateway)
          )
            return false
          if (!isGuard && !info.NetworkSettings.Networks.bridge) return false
          if (
            !same(
              info.Config.Entrypoint,
              entrypoint(isGuard ? 'network-guard.mjs' : 'gateway.mjs'),
            ) ||
            (info.Config.Cmd?.length ?? 0)
          )
            return false
          const environment = Object.fromEntries(
            (info.Config.Env ?? []).map((entry) => {
              const split = entry.indexOf('=')
              return [entry.slice(0, split), entry.slice(split + 1)]
            }),
          )
          const expectedEnv: Record<string, string> = isGuard
            ? { GATEWAY_IPV4: ips.gateway, GATEWAY_PORT: '8080' }
            : {
                LISTEN_HOST: ips.gateway,
                CLIENT_IPV4: ips.client,
                ALLOWED_ROUTES: JSON.stringify(policy.routes),
                LLM_UPSTREAM: config.llmUpstream,
                MCP_UPSTREAM: config.mcpUpstream,
              }
          if (
            !labelsMatch(environment, expectedEnv) ||
            ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].some(
              (key) => environment[key],
            )
          )
            return false
          await ready(
            docker.getContainer(info.Id),
            isGuard ? '/run/raditi-guard/ready' : '/run/raditi-gateway/ready',
            Date.now() + 3_000,
          )
        }
      } catch {
        return false
      }
      // Idempotent: puts back a rule that a firewalld reload or iptables-restore dropped since
      // prepare. Outside the try: a failed helper is an infrastructure fault, not a foreign
      // container, so callers see an error instead of a sandbox that silently vanished.
      if (runsc) await hostFirewall(resourceId, ['install', bridgeName(resourceId)])
      return true
    },
    release: releaseId,
  }
}
