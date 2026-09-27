import { Buffer } from 'node:buffer'
import {
  assertSandboxSpec,
  badRequest,
  conflict,
  DIGEST_PINNED_IMAGE,
  MAX_SANDBOX_RESOURCES,
  MAX_SANDBOX_TURN_MS,
  networkPolicySchema,
  notImplemented,
  SANDBOX_SECRETS_DIR,
  SANDBOX_SECRETS_TMPFS_BYTES,
  sandboxCommandFailed,
  sandboxLabelsSchema,
  type NetworkPolicy,
  type SandboxLabels,
  type SandboxProvider,
  type SandboxSpec,
} from '@repo/domain'
import type Docker from 'dockerode'

import type { SandboxConfig } from './config.ts'
import {
  bounded,
  commandError,
  createOwned,
  hasStatus,
  HELPER_ENV,
  helperCommand,
  isMissing,
  localDocker,
  SANDBOX_USER,
} from './docker-api.ts'
import { DockerSandbox } from './docker-sandbox.ts'
import type { DockerGatewayManager } from './gateway-types.ts'
import { createDockerGatewayManager } from './gateway/manager.ts'

const PREFIX = 'io.raditi.sandbox.'
const OWNER = 'raditi'
const PROTOCOL = '1'
// Every exec resets these for the trusted helper, so container-wide values never reach the agent.
const helperEnvNames = new Set(HELPER_ENV.map((entry) => entry.slice(0, entry.indexOf('='))))
const labelNames = ['workspaceId', 'siteId', 'taskId', 'sessionId', 'turn', 'leaseEpoch'] as const
const tmpfs = {
  '/workspace': 'rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700',
  '/agent-home': 'rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700',
  '/tmp': 'rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700',
  [SANDBOX_SECRETS_DIR]: `rw,noexec,nosuid,nodev,size=${SANDBOX_SECRETS_TMPFS_BYTES / 1024}k,uid=10001,gid=10001,mode=0700`,
  '/run/raditi/exec': 'rw,noexec,nosuid,nodev,size=192m,uid=10001,gid=10001,mode=0700',
  '/run/raditi/control': 'rw,noexec,nosuid,nodev,size=1m,uid=0,gid=0,mode=0755',
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const labelsOf = (
  labels: SandboxLabels,
  deadline: number,
  policy: NetworkPolicy,
  gatewayId?: string,
) => ({
  ...Object.fromEntries(
    labelNames
      .filter((key) => labels[key] !== undefined)
      .map((key) => [`${PREFIX}${key}`, String(labels[key])]),
  ),
  [`${PREFIX}owner`]: OWNER,
  [`${PREFIX}protocol`]: PROTOCOL,
  [`${PREFIX}deadline`]: String(deadline),
  [`${PREFIX}network`]: JSON.stringify(policy),
  ...(gatewayId ? { [`${PREFIX}gatewayId`]: gatewayId } : {}),
})

/**
 * Daemon flags for runsc (spec §8): gVisor keeps its own netstack (`network=sandbox`), refuses
 * raw sockets and ignores per-container flag overrides. Defaults are safe; overrides are not.
 */
export function safeRunscArgs(args: unknown = []): boolean {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return false
  return args.every((arg: string, index) => {
    const [, name, value] = /^--?([A-Za-z0-9-]+)(?:=(.*))?$/.exec(arg) ?? []
    if (name === 'net-raw' || name === 'allow-flag-override') return value === 'false'
    if (name === 'network') return (value ?? args[index + 1]) === 'sandbox'
    return true
  })
}

/**
 * The daemon must run the runsc binary directly: a containerd shim (`runtimeType`, `options`)
 * reads its flags from a config file that `docker info` does not report.
 */
export function safeRunscRuntime(runtime: unknown): boolean {
  if (typeof runtime !== 'object' || runtime === null) return false
  const { path, runtimeArgs, runtimeType, options } = runtime as Record<string, unknown>
  return (
    runtimeType === undefined &&
    options === undefined &&
    typeof path === 'string' &&
    path.split('/').pop() === 'runsc' &&
    safeRunscArgs(runtimeArgs)
  )
}

function identity(info: Docker.ContainerInspectInfo): {
  labels: SandboxLabels
  deadline: number
  policy: NetworkPolicy
  gatewayId: string | undefined
} | null {
  const raw = info.Config?.Labels
  if (!raw || raw[`${PREFIX}owner`] !== OWNER || raw[`${PREFIX}protocol`] !== PROTOCOL) return null
  const parsed = sandboxLabelsSchema.safeParse(
    Object.fromEntries(
      labelNames
        .filter((key) => raw[`${PREFIX}${key}`] !== undefined)
        .map((key) => [
          key,
          key === 'turn' || key === 'leaseEpoch'
            ? Number(raw[`${PREFIX}${key}`])
            : raw[`${PREFIX}${key}`],
        ]),
    ),
  )
  if (!parsed.success) return null
  const deadline = Number(raw[`${PREFIX}deadline`])
  if (!Number.isSafeInteger(deadline) || deadline < 1) return null
  let policy: NetworkPolicy
  try {
    policy = networkPolicySchema.parse(JSON.parse(raw[`${PREFIX}network`] ?? ''))
  } catch {
    return null
  }
  const gatewayId = raw[`${PREFIX}gatewayId`]
  if (
    policy.mode === 'gateway'
      ? !/^[A-Za-z0-9_-]{1,128}$/.test(gatewayId ?? '')
      : gatewayId !== undefined
  )
    return null
  const expected = labelsOf(parsed.data, deadline, policy, gatewayId)
  const own = Object.fromEntries(Object.entries(raw).filter(([key]) => key.startsWith(PREFIX)))
  if (
    Object.keys(own).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => own[key] !== value)
  )
    return null
  if (info.Name !== `/raditi-turn-${parsed.data.taskId}-${parsed.data.turn}`) return null
  return { labels: parsed.data, deadline, policy, gatewayId }
}

export function createDockerSandboxProvider(
  config: SandboxConfig,
  /** Injection is trusted infrastructure, used by tests. */
  options: { client?: Docker; gateway?: DockerGatewayManager } = {},
): SandboxProvider {
  const docker = options.client ?? localDocker(config.socketPath)
  const gateway =
    options.gateway ??
    (config.gateway && createDockerGatewayManager(config.gateway, docker, config.runtime))

  const inspectSafe = async (info: Docker.ContainerInspectInfo) => {
    const meta = identity(info)
    if (!meta) return null
    const host = info.HostConfig
    const createdAt = new Date(info.Created)
    if (
      !Number.isFinite(createdAt.getTime()) ||
      meta.deadline > createdAt.getTime() + MAX_SANDBOX_TURN_MS ||
      meta.deadline < createdAt.getTime() - 30_000
    )
      return null
    if (
      info.Config.User !== SANDBOX_USER ||
      !DIGEST_PINNED_IMAGE.test(info.Config.Image) ||
      !same(info.Config.Entrypoint, ['tini', '--']) ||
      !same(info.Config.Cmd, ['sleep', 'infinity']) ||
      info.Config.Tty ||
      info.Config.OpenStdin ||
      !host.ReadonlyRootfs ||
      host.Privileged ||
      host.Runtime !== config.runtime ||
      !same(host.CapDrop, ['ALL']) ||
      (host.CapAdd?.length ?? 0) !== 0 ||
      !host.SecurityOpt?.includes('no-new-privileges') ||
      host.SecurityOpt.length !== 1 ||
      (host.Binds?.length ?? 0) !== 0 ||
      (host.Devices?.length ?? 0) !== 0 ||
      host.NetworkMode === 'host' ||
      host.PidMode ||
      host.IpcMode === 'host' ||
      host.PublishAllPorts ||
      Object.keys(host.PortBindings ?? {}).length ||
      Object.keys(info.Config.Volumes ?? {}).length ||
      (info.Mounts?.some((mount) => mount.Type !== 'tmpfs' || !(mount.Destination in tmpfs)) ??
        false)
    )
      return null
    if (
      !(
        typeof host.Memory === 'number' &&
        host.Memory > 0 &&
        host.Memory <= MAX_SANDBOX_RESOURCES.memoryMiB * 1024 * 1024
      ) ||
      host.MemorySwap !== host.Memory ||
      !(
        typeof host.NanoCpus === 'number' &&
        host.NanoCpus > 0 &&
        host.NanoCpus <= MAX_SANDBOX_RESOURCES.cpu * 1e9
      ) ||
      !(
        host.PidsLimit !== undefined &&
        host.PidsLimit !== null &&
        host.PidsLimit > 0 &&
        host.PidsLimit <= MAX_SANDBOX_RESOURCES.pids
      )
    )
      return null
    if (
      Object.keys(host.Tmpfs ?? {}).length !== Object.keys(tmpfs).length ||
      Object.entries(tmpfs).some(([path, value]) => host.Tmpfs?.[path] !== value)
    )
      return null
    if (
      host.RestartPolicy?.Name !== 'no' ||
      host.AutoRemove ||
      host.LogConfig?.Type !== 'local' ||
      host.LogConfig.Config?.['max-size'] !== '1m' ||
      host.LogConfig.Config?.['max-file'] !== '1' ||
      host.LogConfig.Config?.compress !== 'false'
    )
      return null
    if (meta.policy.mode === 'none') {
      if (host.NetworkMode !== 'none' || (host.ExtraHosts?.length ?? 0) !== 0) return null
    } else if (
      !gateway ||
      !(await gateway.validate({
        resourceId: meta.gatewayId!,
        labels: meta.labels,
        deadline: meta.deadline,
        policy: meta.policy,
        sandbox: info,
      }))
    )
      return null
    return { ...meta, createdAt }
  }

  const wrap = (
    container: Docker.Container,
    info: Docker.ContainerInspectInfo,
    meta: NonNullable<Awaited<ReturnType<typeof inspectSafe>>>,
  ) => {
    const originalLabels = info.Config.Labels
    // Verified above: present exactly for gateway policies, and immutable with the labels.
    const { gatewayId } = meta
    return new DockerSandbox(container, docker, meta.labels, meta.deadline, {
      assertOwned: async () => {
        const current = await bounded(container.inspect())
        if (
          current.Id !== info.Id ||
          !identity(current) ||
          !same(current.Config.Labels, originalLabels)
        )
          throw badRequest('Container ownership changed; refusing removal')
      },
      release: async () => {
        if (gatewayId !== undefined) await gateway!.release(gatewayId)
      },
    })
  }

  return {
    kind: 'docker',
    async create(value, signal) {
      const spec: SandboxSpec = assertSandboxSpec(value)
      const reset = Object.keys(spec.env).filter((name) => helperEnvNames.has(name))
      if (reset.length)
        throw badRequest(
          `Sandbox env ${reset.join(', ')} is reset for every exec: pass it through ExecSpec.env`,
        )
      if (signal?.aborted) throw commandError()
      if (spec.runtime !== config.runtime)
        throw badRequest(
          `Sandbox runtime ${spec.runtime} differs from SANDBOX_RUNTIME=${config.runtime}`,
        )
      if (spec.network.mode === 'gateway' && !gateway)
        throw notImplemented('Sandbox gateway requires a trusted network manager')
      const daemon = await bounded(docker.info(), 10_000, signal)
      const runtime: unknown = daemon.Runtimes?.[spec.runtime]
      // Daemon configuration is infrastructure, not client input: fail as a sandbox fault.
      if (!runtime) throw sandboxCommandFailed('Configured sandbox runtime is not available')
      if (spec.runtime === 'runsc' && !safeRunscRuntime(runtime))
        throw sandboxCommandFailed(
          'runsc must be the plain binary with its own network stack and no raw sockets',
        )
      const image = await bounded(docker.getImage(spec.image).inspect(), 10_000, signal)
      if (Object.keys(image.Config?.Volumes ?? {}).length)
        throw badRequest('Sandbox images must not declare volumes')
      const deadline = Date.now() + spec.hardTimeoutMs
      const name = `raditi-turn-${spec.labels.taskId}-${spec.labels.turn}`
      const network =
        spec.network.mode === 'gateway'
          ? await gateway!.prepare({ labels: spec.labels, policy: spec.network, deadline }, signal)
          : undefined
      let container: Docker.Container | undefined
      try {
        if (signal?.aborted) throw commandError()
        // A late daemon response cleans up its exact returned id, never the shared turn name.
        container = await createOwned(
          docker.createContainer({
            name,
            Image: spec.image,
            User: SANDBOX_USER,
            Entrypoint: ['tini', '--'],
            Cmd: ['sleep', 'infinity'],
            WorkingDir: '/workspace',
            Tty: false,
            OpenStdin: false,
            Env: Object.entries({ LANG: 'C.UTF-8', HOME: '/agent-home', ...spec.env }).map(
              ([key, value]) => `${key}=${value}`,
            ),
            Labels: labelsOf(spec.labels, deadline, spec.network, network?.resourceId),
            HostConfig: {
              Runtime: spec.runtime,
              ReadonlyRootfs: true,
              Privileged: false,
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges'],
              NanoCpus: Math.round(spec.resources.cpu * 1e9),
              Memory: spec.resources.memoryMiB * 1024 * 1024,
              MemorySwap: spec.resources.memoryMiB * 1024 * 1024,
              PidsLimit: spec.resources.pids,
              NetworkMode: network?.networkMode ?? 'none',
              ...(network?.extraHosts.length ? { ExtraHosts: network.extraHosts } : {}),
              RestartPolicy: { Name: 'no' },
              AutoRemove: false,
              Tmpfs: { ...tmpfs },
              LogConfig: {
                Type: 'local',
                Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' },
              },
            },
            ...(network?.endpoints
              ? { NetworkingConfig: { EndpointsConfig: network.endpoints } }
              : {}),
          }),
          (created) => created.remove({ force: true, v: true }),
          signal,
        )
        await bounded(container.start(), 10_000, signal)
        await helperCommand(container, ['bootstrap'], { signal, bootstrap: true })
        const ready = await helperCommand(container, ['ready'], { signal })
        if (ready.toString('utf8') !== '{"protocol":1}') throw commandError()
        const info = await bounded(container.inspect(), 10_000, signal)
        const meta = await inspectSafe(info)
        if (!meta) throw commandError()
        const sandbox = wrap(container, info, meta)
        try {
          for (const secret of spec.secrets)
            await sandbox.fs.write(secret.path, Buffer.from(secret.value), { mode: 0o600 })
        } catch {
          await sandbox.destroy('failed')
          throw commandError()
        }
        if (signal?.aborted || Date.now() >= deadline) {
          await sandbox.destroy('cancelled')
          throw commandError()
        }
        return sandbox
      } catch (error) {
        if (container)
          await bounded(container.remove({ force: true, v: true })).catch((e) => {
            if (!isMissing(e)) throw commandError()
          })
        if (network) await gateway!.release(network.resourceId)
        if (hasStatus(error, 409)) throw conflict('A container already exists for this turn')
        throw commandError()
      }
    },
    async get(id) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw badRequest('Invalid sandbox identifier')
      const container = docker.getContainer(id)
      let info: Docker.ContainerInspectInfo
      try {
        info = await bounded(container.inspect())
      } catch (error) {
        if (isMissing(error)) return null
        throw commandError()
      }
      const meta = await inspectSafe(info)
      return meta ? wrap(container, info, meta) : null
    },
    async list(filter = {}) {
      const parsed = sandboxLabelsSchema.partial().safeParse(filter)
      if (!parsed.success) throw badRequest('Invalid sandbox label filter')
      const labels = [
        `${PREFIX}owner=${OWNER}`,
        `${PREFIX}protocol=${PROTOCOL}`,
        ...Object.entries(parsed.data).map(([key, value]) => `${PREFIX}${key}=${value}`),
      ]
      const containers = await bounded(
        docker.listContainers({ all: true, filters: { label: labels } }),
      )
      const result = []
      for (const row of containers) {
        const info = await bounded(docker.getContainer(row.Id).inspect()).catch(
          (error: unknown) => {
            if (isMissing(error)) return null
            throw commandError()
          },
        )
        if (!info) continue
        const meta = await inspectSafe(info)
        if (
          meta &&
          Object.entries(parsed.data).every(
            ([key, value]) => meta.labels[key as keyof SandboxLabels] === value,
          )
        )
          result.push({ id: info.Id, labels: meta.labels, createdAt: meta.createdAt })
      }
      return result
    },
  }
}
