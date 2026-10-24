import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import {
  badRequest,
  browserLocalSiteOrigin,
  conflict,
  formatEgressHost,
  isDomainError,
  parseEgressHost,
  sandboxCommandFailed,
  type BrowserLocalSite,
  type BrowserSessionRuntime,
  type BrowserSessionRuntimeSpec,
} from '@repo/domain'
import type Docker from 'dockerode'

import { bounded, commandError, createOwned, isMissing, localDocker } from '../docker-api.ts'
import { safeRunscRuntime } from '../docker.ts'
import {
  BROWSER_CONTROL_PORT,
  BROWSER_READY_FILE,
  BROWSER_SECRET_FILE,
  EGRESS_PORT,
  FORWARD_READY_FILE,
  SERVICE_USER,
  type NetworkPlace,
} from '../preview/containers.ts'
import { execChecked, execIn } from '../preview/exec.ts'
import { hostlessBridge, isHostlessBridge } from '../preview/resources.ts'
import {
  browserSessionRuntimeLimits,
  dockerBrowserSessionConfigSchema,
  type DockerBrowserSessionConfig,
} from './config.ts'
import {
  browserContainer,
  CONFIG_LABEL,
  egressContainer,
  firewallContainer,
  forwarderContainer,
  sessionAddresses,
  type BrowserSessionPlace,
} from './containers.ts'
import {
  BROWSER_LABEL,
  browserSessionBridge,
  browserSessionFilter,
  browserSessionLabels,
  browserSessionNames,
  isSessionUuid,
  ownedBrowserResource,
  type BrowserSessionIdentity,
  type BrowserSessionRole,
} from './resources.ts'

type Listed = { Id: string; Names?: string[]; Labels?: Record<string, string>; State?: string }

/** A write of the secret path: a fixed script of /bin/sh, the path as $1. */
const WRITE_FILE = ['/bin/sh', '-c', 'umask 077 && cat > "$1.tmp" && mv -f "$1.tmp" "$1"', 'raditi']
const WS_PATH = /^\/[A-Za-z0-9_-]{43,128}$/
/** A name of a local site as BROWSER_LOCAL_SITES gives it: never an address. */
const LOCAL_NAME =
  /^(?=.*[a-z][a-z0-9-]*$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const TARGET_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const suffix = () => randomBytes(4).toString('hex')
const addressOn = (info: Docker.ContainerInspectInfo, network: NetworkPlace) =>
  Object.values(info.NetworkSettings?.Networks ?? {}).find(
    (endpoint) => endpoint.NetworkID === network.id,
  )?.IPAddress

/** `host:port` of a local site's origin and of its fixed target; null for anything else. */
export function localSiteRoute(site: BrowserLocalSite): [string, string] | null {
  if (typeof site?.origin !== 'string' || typeof site.target !== 'string') return null
  if (browserLocalSiteOrigin(site.origin) !== site.origin) return null
  const url = new URL(site.origin)
  // Plain http only: the proxy reads what goes to a local site — a request, or the first one in a
  // tunnel of the request API — and TLS it could not read.
  if (url.protocol !== 'http:' || !LOCAL_NAME.test(url.hostname)) return null
  const at = site.target.lastIndexOf(':')
  const host = site.target.slice(0, at)
  const port = Number(site.target.slice(at + 1))
  if (
    at < 1 ||
    !/^[1-9]\d{0,4}$/.test(site.target.slice(at + 1)) ||
    port > 65_535 ||
    // An address, or a name the proxy's container resolves: never one a resolver reads as one.
    !(isIPv4(host) || (TARGET_NAME.test(host) && /[a-z]/.test(host.split('.').at(-1)!)))
  )
    return null
  return [`${url.hostname}:${url.port === '' ? 80 : url.port}`, site.target]
}

/** The spec as the containers take it; BAD_REQUEST for anything else. */
function parseSpec(value: BrowserSessionRuntimeSpec, localSitesAllowed: boolean) {
  const { sessionId, taskId, siteId, deadline } = value ?? {}
  if (!isSessionUuid(sessionId) || !isSessionUuid(taskId) || !isSessionUuid(siteId))
    throw badRequest('Invalid browser session ids')
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now())
    throw badRequest('Invalid browser session deadline')
  const hosts = Array.isArray(value.allowedHosts) ? value.allowedHosts : null
  if (
    !hosts ||
    hosts.length > browserSessionRuntimeLimits.hosts ||
    new Set(hosts).size !== hosts.length ||
    hosts.some((host) => {
      const parsed = typeof host === 'string' ? parseEgressHost(host) : null
      return parsed === null || formatEgressHost(parsed) !== host
    })
  )
    throw badRequest('Invalid browser session hosts')
  const sites = Array.isArray(value.localSites) ? value.localSites : null
  if (!sites || sites.length > browserSessionRuntimeLimits.localSites)
    throw badRequest('Invalid browser local sites')
  if (sites.length > 0 && !localSitesAllowed)
    throw badRequest('Local sites are not allowed for browser sessions here')
  const routes: Record<string, string> = {}
  for (const site of sites) {
    const route = localSiteRoute(site)
    if (!route || route[0] in routes) throw badRequest('Invalid browser local sites')
    routes[route[0]] = route[1]
  }
  if (hosts.length === 0 && sites.length === 0) throw badRequest('A browser session goes nowhere')
  return {
    identity: { sessionId, taskId, siteId } satisfies BrowserSessionIdentity,
    deadline,
    allowedHosts: [...hosts],
    localRoutes: routes,
  }
}

/**
 * The Docker runtime of browser sessions (docs/plan/57-browser-tasks.md, Б10, Б11, Б18): one local
 * daemon, each session on a hostless internal network of its own with three containers — the
 * egress proxy, the forwarder of the control port and Chromium. It keeps no state: everything is
 * found by its labels, so a worker that restarts finds the sessions it left.
 */
export function createDockerBrowserSessionRuntime(
  configValue: DockerBrowserSessionConfig,
  /** Injection is trusted infrastructure, used by tests. */
  options: { client?: Docker } = {},
): BrowserSessionRuntime {
  const config = dockerBrowserSessionConfigSchema.parse(configValue)
  const docker = options.client ?? localDocker(config.socketPath)
  const runsc = config.runtime === 'runsc'

  // --- discovery ------------------------------------------------------------------------------

  const listContainers = async (sessionId?: string, role?: BrowserSessionRole) =>
    (
      (await bounded(
        docker.listContainers({ all: true, filters: browserSessionFilter(sessionId, role) }),
      )) as Listed[]
    ).filter((item) => {
      const owned = ownedBrowserResource(item.Labels)
      return (
        owned && (!sessionId || owned.sessionId === sessionId) && (!role || owned.role === role)
      )
    })

  const listNetworks = async (sessionId?: string) =>
    (
      (await bounded(
        docker.listNetworks({ filters: browserSessionFilter(sessionId, 'network') }),
      )) as Listed[]
    ).filter((item) => {
      const owned = ownedBrowserResource(item.Labels)
      return owned?.role === 'network' && (!sessionId || owned.sessionId === sessionId)
    })

  const inspectContainer = async (id: string) => {
    try {
      return await bounded(docker.getContainer(id).inspect())
    } catch (error) {
      if (isMissing(error)) return null
      throw commandError()
    }
  }

  const removeContainer = async (id: string) => {
    try {
      await bounded(docker.getContainer(id).remove({ force: true, v: true }), 30_000)
    } catch (error) {
      if (!isMissing(error)) throw commandError()
    }
  }

  const portOf = (info: Docker.ContainerInspectInfo, port: number): number | null => {
    const binding = info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0]
    const value = Number(binding?.HostPort)
    return binding?.HostIp === '127.0.0.1' && Number.isInteger(value) && value > 0 && value < 65_536
      ? value
      : null
  }

  // --- checks ---------------------------------------------------------------------------------

  const checkRuntime = async (signal?: AbortSignal) => {
    const daemon = await bounded(docker.info(), 10_000, signal)
    const runtime: unknown = daemon.Runtimes?.[config.runtime]
    if (!runtime) throw sandboxCommandFailed('Configured browser runtime is not available')
    if (runsc && !safeRunscRuntime(runtime))
      throw sandboxCommandFailed(
        'runsc must be the plain binary with its own network stack and no raw sockets',
      )
  }

  /** Never pulled; an image that declares a volume would leave an anonymous one behind. */
  const checkImage = async (image: string, signal?: AbortSignal) => {
    let info: Docker.ImageInspectInfo
    try {
      info = await bounded(docker.getImage(image).inspect(), 10_000, signal)
    } catch (error) {
      if (isMissing(error))
        throw sandboxCommandFailed('A browser session image is not present on this host')
      throw commandError()
    }
    if (Object.keys(info.Config?.Volumes ?? {}).length)
      throw badRequest('A browser session image declares a volume')
  }

  // --- host firewall (runsc) ------------------------------------------------------------------

  const hostFirewall = async (
    identity: BrowserSessionIdentity,
    args: string[],
    signal?: AbortSignal,
  ) => {
    const helper = await createOwned(
      docker.createContainer(
        firewallContainer({
          identity,
          image: config.firewallImage!,
          args,
          suffix: `${args[0]}-${suffix()}`,
        }),
      ),
      (created) => created.remove({ force: true, v: true }),
      signal,
    )
    let status: unknown
    try {
      await bounded(helper.start(), 10_000, signal)
      status = ((await bounded(helper.wait(), 20_000, signal)) as { StatusCode?: unknown })
        .StatusCode
    } finally {
      await removeContainer(helper.id)
    }
    if (status !== 0) throw commandError()
  }

  /** Drops host rules of bridges that are gone; a failed sweep is retried by the next install. */
  const sweepFirewall = (identity: BrowserSessionIdentity) =>
    hostFirewall(identity, ['sweep']).catch(() =>
      process.emitWarning('Browser session host firewall sweep failed', {
        code: 'RADITI_BROWSER_FIREWALL_SWEEP',
      }),
    )

  // --- the network ----------------------------------------------------------------------------

  const findNetwork = async (sessionId: string) => {
    const rows = await listNetworks(sessionId)
    if (rows.length > 1) throw commandError()
    if (!rows[0]) return null
    const info = await bounded(docker.getNetwork(rows[0].Id).inspect())
    if (
      info.Name !== browserSessionNames(sessionId).network ||
      !isHostlessBridge(info, browserSessionBridge(sessionId))
    )
      throw commandError()
    return info
  }

  const ensureNetwork = async (
    place: Omit<BrowserSessionPlace, 'network'>,
    signal?: AbortSignal,
  ): Promise<NetworkPlace> => {
    const { sessionId } = place.identity
    const bridge = browserSessionBridge(sessionId)
    let info = await findNetwork(sessionId)
    if (!info) {
      const network = await createOwned(
        docker.createNetwork(
          hostlessBridge(
            browserSessionNames(sessionId).network,
            bridge,
            browserSessionLabels(place.identity, 'network', place.deadline),
          ),
        ),
        (created) => created.remove(),
        signal,
      )
      info = await bounded(network.inspect(), 10_000, signal)
      if (!isHostlessBridge(info, bridge)) {
        await bounded(network.remove()).catch(() => {})
        throw commandError()
      }
    }
    // Before Chromium joins the bridge; idempotent, so a lost rule comes back.
    if (runsc) await hostFirewall(place.identity, ['install', bridge], signal)
    const subnet = info.IPAM?.Config?.[0]?.Subnet
    if (!subnet) throw commandError()
    return { id: info.Id, subnet }
  }

  // --- containers -----------------------------------------------------------------------------

  /** Unchanged since it was created as asked: same labels and desired state, still hardened. */
  const matches = (info: Docker.ContainerInspectInfo, desired: Docker.ContainerCreateOptions) => {
    const host = info.HostConfig
    const labels = info.Config.Labels ?? {}
    return (
      labels[CONFIG_LABEL] === desired.Labels?.[CONFIG_LABEL] &&
      ['session', 'task', 'site', 'role', 'deadline'].every(
        (key) => labels[`${BROWSER_LABEL}${key}`] === desired.Labels?.[`${BROWSER_LABEL}${key}`],
      ) &&
      info.Name === `/${desired.name}` &&
      host.ReadonlyRootfs === true &&
      !host.Privileged &&
      host.CapDrop?.join() === 'ALL' &&
      (host.Binds?.length ?? 0) === 0 &&
      !host.PidMode &&
      host.IpcMode !== 'host'
    )
  }

  /**
   * The container as desired: kept when it matches and is attached as asked (started again when
   * it stopped), replaced otherwise. `attach` joins the session's network at a fixed address
   * before the start: the egress proxy and the forwarder live on the default bridge as well.
   */
  const ensureContainer = async (
    desired: Docker.ContainerCreateOptions,
    attach: { network: NetworkPlace; address: string } | null,
    signal?: AbortSignal,
  ): Promise<Docker.ContainerInspectInfo> => {
    const [row] = (await bounded(
      docker.listContainers({ all: true, filters: { name: [`^/${desired.name}$`] } }),
    )) as Listed[]
    if (row) {
      const info = await inspectContainer(row.Id)
      const attached = !attach || (info && addressOn(info, attach.network) === attach.address)
      if (info && matches(info, desired) && attached) {
        if (!info.State.Running) await bounded(docker.getContainer(info.Id).start(), 10_000, signal)
        return (await inspectContainer(info.Id)) ?? Promise.reject(commandError())
      }
      // Ours by labels or by name: anything else under the name is never touched.
      if (info && !ownedBrowserResource(info.Config.Labels))
        throw conflict('A foreign container holds a browser session name')
      if (info) await removeContainer(info.Id)
    }
    const container = await createOwned(
      docker.createContainer(desired),
      (created) => created.remove({ force: true, v: true }),
      signal,
    )
    try {
      if (attach)
        await bounded(
          docker.getNetwork(attach.network.id).connect({
            Container: container.id,
            EndpointConfig: { IPAMConfig: { IPv4Address: attach.address } },
          }),
          10_000,
          signal,
        )
      await bounded(container.start(), 10_000, signal)
      return (await inspectContainer(container.id)) ?? Promise.reject(commandError())
    } catch (error) {
      await removeContainer(container.id)
      throw isDomainError(error) ? error : commandError()
    }
  }

  /** Polls a check until it passes, the container stops or the time is up. */
  const waitFor = async (
    container: Docker.ContainerInspectInfo,
    check: () => Promise<boolean>,
    signal?: AbortSignal,
  ) => {
    const until = Date.now() + browserSessionRuntimeLimits.readyMs
    while (Date.now() < until) {
      if (signal?.aborted) throw commandError()
      const state = await inspectContainer(container.Id)
      if (!state?.State.Running) throw sandboxCommandFailed('A browser session container stopped')
      if (await check().catch(() => false)) return
      await delay(200)
    }
    throw sandboxCommandFailed('A browser session container did not become ready')
  }

  const fileExists = (info: Docker.ContainerInspectInfo, path: string) => () =>
    execIn(docker.getContainer(info.Id), {
      argv: ['test', '-f', path],
      user: info.Config.User,
      stdoutBytes: 1024,
      stderrBytes: 1024,
      timeoutMs: 5_000,
    }).then((outcome) => outcome.code === 0)

  /** The proxy accepts connections on its address of the session's network. */
  const egressListens = (info: Docker.ContainerInspectInfo, address: string) => () =>
    execIn(docker.getContainer(info.Id), {
      argv: [
        '/usr/local/bin/node',
        '-e',
        'require("net").connect(+process.argv[2],process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))',
        address,
        String(EGRESS_PORT),
      ],
      user: SERVICE_USER,
      stdoutBytes: 1024,
      stderrBytes: 1024,
      timeoutMs: 5_000,
    }).then((outcome) => outcome.code === 0)

  /**
   * The control path of a running browser: the one in its tmpfs (the server may have read it
   * already), or a new random one written there. It goes nowhere but the endpoint answered.
   */
  const secretPathOf = async (browser: Docker.ContainerInspectInfo, signal?: AbortSignal) => {
    const container = docker.getContainer(browser.Id)
    const user = browser.Config.User
    if (await fileExists(browser, BROWSER_SECRET_FILE)()) {
      const value = (
        await execChecked(container, {
          argv: ['cat', BROWSER_SECRET_FILE],
          user,
          stdoutBytes: 1024,
          stderrBytes: 1024,
          timeoutMs: 5_000,
          ...(signal ? { signal } : {}),
        })
      )
        .toString('utf8')
        .trim()
      if (!WS_PATH.test(value)) throw commandError()
      return value
    }
    const value = `/${randomBytes(32).toString('base64url')}`
    await execChecked(container, {
      argv: [...WRITE_FILE, BROWSER_SECRET_FILE],
      user,
      stdin: Buffer.from(value),
      stdinBytes: 1024,
      stdoutBytes: 1024,
      stderrBytes: 4096,
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    })
    return value
  }

  /** Everything of a session as asked: created, kept or replaced; the endpoint once all answer. */
  const build = async (
    spec: ReturnType<typeof parseSpec>,
    signal?: AbortSignal,
  ): Promise<{ endpoint: string }> => {
    const network = await ensureNetwork(
      { identity: spec.identity, deadline: spec.deadline },
      signal,
    )
    const place: BrowserSessionPlace = { identity: spec.identity, deadline: spec.deadline, network }
    const addresses = sessionAddresses(network)
    const egress = await ensureContainer(
      egressContainer({
        place,
        appEnv: config.appEnv,
        image: config.images.egress,
        limits: config.limits.service,
        allowedHosts: spec.allowedHosts,
        localRoutes: spec.localRoutes,
        refusedSubnets: config.refusedSubnets,
        maxTunnels: config.maxTunnels,
      }),
      { network, address: addresses.egress },
      signal,
    )
    const forwarder = await ensureContainer(
      forwarderContainer({ place, image: config.images.forwarder, limits: config.limits.service }),
      { network, address: addresses.forwarder },
      signal,
    )
    const browser = await ensureContainer(
      browserContainer({
        place,
        image: config.images.browser,
        runtime: config.runtime,
        limits: config.limits.browser,
      }),
      null,
      signal,
    )
    const wsPath = await secretPathOf(browser, signal)
    await waitFor(egress, egressListens(egress, addresses.egress), signal)
    await waitFor(forwarder, fileExists(forwarder, FORWARD_READY_FILE), signal)
    await waitFor(browser, fileExists(browser, BROWSER_READY_FILE), signal)
    const port = portOf((await inspectContainer(forwarder.Id))!, BROWSER_CONTROL_PORT)
    if (!port) throw commandError()
    return { endpoint: `ws://127.0.0.1:${port}${wsPath}` }
  }

  /** Containers first: the network goes only once nothing is attached to it. */
  const removeSession = async (sessionId: string) => {
    const containers = await listContainers(sessionId)
    const identity = containers
      .map((row) => ownedBrowserResource(row.Labels))
      .concat((await listNetworks(sessionId)).map((row) => ownedBrowserResource(row.Labels)))
      .find((owned) => owned !== null)
    const results = await Promise.allSettled(containers.map((row) => removeContainer(row.Id)))
    if (results.some((result) => result.status === 'rejected')) throw commandError()
    const network = await findNetwork(sessionId).catch(() => null)
    if (network)
      try {
        await bounded(docker.getNetwork(network.Id).remove())
      } catch (error) {
        if (!isMissing(error)) throw commandError()
      }
    if (runsc && identity) await sweepFirewall(identity)
  }

  return {
    async start(specValue, signal) {
      const spec = parseSpec(specValue, config.localSites)
      const { sessionId } = spec.identity
      await checkRuntime(signal)
      for (const image of Object.values(config.images)) await checkImage(image, signal)
      const existing = [...(await listContainers(sessionId)), ...(await listNetworks(sessionId))]
        .map((row) => ownedBrowserResource(row.Labels)!)
        .filter((owned) => owned.role !== 'firewall')
      if (existing.some((owned) => owned.taskId !== spec.identity.taskId))
        throw conflict('The browser session belongs to another task')
      if (existing.some((owned) => owned.siteId !== spec.identity.siteId))
        throw conflict('The browser session belongs to another site')
      // Labels cannot change: another deadline is a session built anew, never one kept under a
      // deadline the watchdog does not know.
      if (existing.some((owned) => owned.deadline !== spec.deadline)) await removeSession(sessionId)
      const reused = existing.length > 0 && existing.every((o) => o.deadline === spec.deadline)
      try {
        return await build(spec, signal)
      } catch (error) {
        // What was there and does not come up is broken: built once more, from nothing. What this
        // call made and could not finish is not left behind.
        if (reused && !signal?.aborted) {
          await removeSession(sessionId)
          try {
            return await build(spec, signal)
          } catch (again) {
            await removeSession(sessionId).catch(() => {})
            throw isDomainError(again) ? again : commandError()
          }
        }
        await removeSession(sessionId).catch(() => {})
        throw isDomainError(error) ? error : commandError()
      }
    },

    async stop(sessionId) {
      if (!isSessionUuid(sessionId)) throw badRequest('Invalid browser session id')
      await removeSession(sessionId)
    },

    async list() {
      const ids = new Set<string>()
      for (const row of [...(await listContainers()), ...(await listNetworks())]) {
        const owned = ownedBrowserResource(row.Labels)
        if (owned) ids.add(owned.sessionId)
      }
      return [...ids].sort()
    },
  }
}
