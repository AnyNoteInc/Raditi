import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import Docker from 'dockerode'

import { bounded, commandError, isMissing, startDetachedExec } from '../docker-api.ts'
import type { DockerGatewayManager } from '../gateway-types.ts'
import { gatewayConfigSchema, type GatewayConfig } from './config.ts'

const PREFIX = 'io.raditi.gateway.'
const MAIN = 'io.raditi.sandbox.'
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const scopes = ['workspaceId', 'siteId', 'taskId', 'sessionId', 'turn', 'leaseEpoch'] as const
const ownLabels = (resourceId: string) => [
  `${PREFIX}owner=raditi`,
  `${PREFIX}protocol=1`,
  `${PREFIX}resourceId=${resourceId}`,
]
const labelsMatch = (
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
) => actual !== undefined && Object.entries(expected).every(([key, value]) => actual[key] === value)

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

/** A late daemon response must clean up only the resource created by this attempt. */
async function createOwned<T>(
  operation: Promise<T>,
  remove: (value: T) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<T> {
  let abandoned = false
  try {
    return await bounded(
      operation.then(async (value) => {
        if (abandoned || signal?.aborted) {
          await remove(value)
          throw commandError()
        }
        return value
      }),
      30_000,
      signal,
    )
  } catch (error) {
    abandoned = true
    throw error
  }
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

export function createDockerGatewayManager(
  configValue: GatewayConfig,
  options: { socketPath?: string; client?: Docker } = {},
): DockerGatewayManager {
  const config = gatewayConfigSchema.parse(configValue)
  const socketPath = options.socketPath ?? '/var/run/docker.sock'
  if (!socketPath.startsWith('/') || /[\0\r\n]/.test(socketPath)) throw commandError()
  const docker = options.client ?? new Docker({ socketPath })

  const releaseId = async (resourceId: string) => {
    if (!uuid.test(resourceId)) throw commandError()
    const containers = await bounded(
      docker.listContainers({ all: true, filters: { label: ownLabels(resourceId) } }),
    )
    const results = await Promise.allSettled(
      containers.map(async (item) => {
        if (
          !labelsMatch(item.Labels, {
            [`${PREFIX}resourceId`]: resourceId,
            [`${PREFIX}owner`]: 'raditi',
            [`${PREFIX}protocol`]: '1',
          })
        )
          throw commandError()
        try {
          await bounded(docker.getContainer(item.Id).remove({ force: true, v: true }))
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }),
    )
    if (results.some((result) => result.status === 'rejected')) throw commandError()
    const networks = await bounded(
      docker.listNetworks({ filters: { label: ownLabels(resourceId) } }),
    )
    for (const network of networks) {
      if (
        !labelsMatch(network.Labels, {
          [`${PREFIX}resourceId`]: resourceId,
          [`${PREFIX}owner`]: 'raditi',
          [`${PREFIX}protocol`]: '1',
        })
      )
        throw commandError()
      try {
        await bounded(docker.getNetwork(network.Id).remove())
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
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
    LogConfig: { Type: 'local', Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' } },
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
        [`${PREFIX}owner`]: 'raditi',
        [`${PREFIX}protocol`]: '1',
        [`${PREFIX}resourceId`]: resourceId,
        [`${PREFIX}role`]: role,
        [`${PREFIX}deadline`]: String(input.deadline),
        [`${PREFIX}policy`]: JSON.stringify(input.policy),
        ...Object.fromEntries(
          scopes
            .filter((key) => input.labels[key] !== undefined)
            .map((key) => [`${PREFIX}${key}`, String(input.labels[key])]),
        ),
      })
      try {
        if (
          signal?.aborted ||
          input.deadline <= Date.now() ||
          input.deadline > Date.now() + 20 * 60_000
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
              'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
              'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
            },
          }),
          (created) => created.remove(),
          signal,
        )
        const networkInfo = await bounded(network.inspect(), 10_000, signal)
        const ips = addresses(networkInfo.IPAM?.Config?.[0]?.Subnet ?? '')
        const endpoint = (ip: string) => ({
          EndpointsConfig: { [network.id]: { IPAMConfig: { IPv4Address: ip } } },
        })
        const proxy = await createOwned(
          docker.createContainer({
            name: `raditi-gateway-proxy-${resourceId}`,
            Image: config.image,
            User: '10001:10001',
            Entrypoint: ['tini', '--', '/usr/local/bin/node', '/usr/local/lib/raditi/gateway.mjs'],
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
            NetworkingConfig: endpoint(ips.gateway),
          }),
          (created) => created.remove({ force: true, v: true }),
          signal,
        )
        await bounded(docker.getNetwork('bridge').connect({ Container: proxy.id }), 10_000, signal)
        await bounded(proxy.start(), 10_000, signal)
        await ready(proxy, '/run/raditi-gateway/ready', input.deadline, signal)
        const guard = await createOwned(
          docker.createContainer({
            name: `raditi-gateway-guard-${resourceId}`,
            Image: config.guardImage,
            User: '0:0',
            Entrypoint: [
              'tini',
              '--',
              '/usr/local/bin/node',
              '/usr/local/lib/raditi/network-guard.mjs',
            ],
            Cmd: [],
            Labels: label('guard'),
            Env: [`GATEWAY_IPV4=${ips.gateway}`, 'GATEWAY_PORT=8080'],
            HostConfig: {
              ...serviceHost(network.id, true),
              ExtraHosts: [`sandbox-gw:${ips.gateway}`],
            },
            NetworkingConfig: endpoint(ips.client),
          }),
          (created) => created.remove({ force: true, v: true }),
          signal,
        )
        await bounded(guard.start(), 10_000, signal)
        await ready(guard, '/run/raditi-guard/ready', input.deadline, signal)
        return {
          networkMode: `container:${guard.id}`,
          resourceId,
          release: () => releaseId(resourceId),
        }
      } catch {
        await releaseId(resourceId)
        throw commandError()
      }
    },
    async validate(main, policy) {
      const resourceId = main.Config.Labels?.[`${MAIN}gatewayId`] ?? ''
      if (!uuid.test(resourceId)) return false
      try {
        const expected = {
          [`${PREFIX}resourceId`]: resourceId,
          [`${PREFIX}owner`]: 'raditi',
          [`${PREFIX}protocol`]: '1',
          [`${PREFIX}deadline`]: main.Config.Labels[`${MAIN}deadline`]!,
          [`${PREFIX}policy`]: JSON.stringify(policy),
          ...Object.fromEntries(
            scopes
              .filter((key) => main.Config.Labels[`${MAIN}${key}`] !== undefined)
              .map((key) => [`${PREFIX}${key}`, main.Config.Labels[`${MAIN}${key}`]!]),
          ),
        }
        const resources = await bounded(
          docker.listContainers({ all: true, filters: { label: ownLabels(resourceId) } }),
        )
        if (resources.length !== 2) return false
        const guardId = resources.find((item) => item.Labels[`${PREFIX}role`] === 'guard')?.Id
        const proxyId = resources.find((item) => item.Labels[`${PREFIX}role`] === 'proxy')?.Id
        if (!guardId || !proxyId || main.HostConfig.NetworkMode !== `container:${guardId}`)
          return false
        const [guard, proxy] = await Promise.all([
          bounded(docker.getContainer(guardId).inspect()),
          bounded(docker.getContainer(proxyId).inspect()),
        ])
        const networks = await bounded(
          docker.listNetworks({ filters: { label: ownLabels(resourceId) } }),
        )
        if (networks.length !== 1) return false
        const network = await bounded(docker.getNetwork(networks[0]!.Id).inspect())
        if (
          !labelsMatch(network.Labels, expected) ||
          !network.Internal ||
          network.EnableIPv6 ||
          network.Driver !== 'bridge' ||
          network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated'
        )
          return false
        const ips = addresses(network.IPAM?.Config?.[0]?.Subnet ?? '')
        for (const [info, isGuard] of [
          [guard, true],
          [proxy, false],
        ] as const) {
          const host = info.HostConfig
          if (
            !info.State.Running ||
            !labelsMatch(info.Config.Labels, {
              ...expected,
              [`${PREFIX}role`]: isGuard ? 'guard' : 'proxy',
            }) ||
            info.Config.Image !== (isGuard ? config.guardImage : config.image) ||
            info.Config.User !== (isGuard ? '0:0' : '10001:10001') ||
            !host.ReadonlyRootfs ||
            host.Privileged ||
            host.PidMode ||
            host.IpcMode === 'host' ||
            (host.Binds?.length ?? 0) ||
            host.CapDrop?.join() !== 'ALL' ||
            (host.CapAdd?.join() ?? '') !== (isGuard ? 'NET_ADMIN' : '') ||
            host.SecurityOpt?.join() !== 'no-new-privileges' ||
            Object.keys(host.PortBindings ?? {}).length ||
            host.PublishAllPorts ||
            host.Sysctls?.['net.ipv4.ip_forward'] !== '0' ||
            host.Sysctls?.['net.ipv6.conf.all.disable_ipv6'] !== '1'
          )
            return false
          const attached = Object.values(info.NetworkSettings.Networks)
          if (
            attached.length !== (isGuard ? 1 : 2) ||
            attached.find((entry) => entry.NetworkID === network.Id)?.IPAddress !==
              (isGuard ? ips.client : ips.gateway)
          )
            return false
          if (!isGuard && !info.NetworkSettings.Networks.bridge) return false
          const program = isGuard ? 'network-guard' : 'gateway'
          if (
            JSON.stringify(info.Config.Entrypoint) !==
              JSON.stringify([
                'tini',
                '--',
                '/usr/local/bin/node',
                `/usr/local/lib/raditi/${program}.mjs`,
              ]) ||
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
        return true
      } catch {
        return false
      }
    },
    async release(main) {
      await releaseId(main.Config.Labels?.[`${MAIN}gatewayId`] ?? '')
    },
  }
}
