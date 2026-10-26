import { posix } from 'node:path'

import type { AppEnv, PreviewRuntimeKind } from '@repo/domain'
import type Docker from 'dockerode'

import {
  BROWSER_CONTROL_PORT,
  BROWSER_STATE_DIR,
  configHash,
  EGRESS_PORT,
  fixedAddress,
  FORWARD_READY_FILE,
  hardened,
  hostFirewallOptions,
  node,
  serviceSysctls,
  SERVICE_USER,
  tmpfs,
  TOOLS,
  type NetworkPlace,
} from '../preview/containers.ts'
import { subnetAddress } from '../preview/resources.ts'
import {
  BROWSER_LABEL,
  browserSessionAddresses,
  browserSessionLabels,
  browserSessionNames,
  type BrowserSessionIdentity,
  type BrowserSessionRole,
} from './resources.ts'

/**
 * Create options of a browser session's containers (docs/plan/57-browser-tasks.md, Б10, Б11):
 * pure, so every hardening flag is visible in one place and checked by tests. Chromium runs the
 * session's runtime (gVisor in production) on the session's internal network only; the egress
 * proxy and the forwarder, which are the platform's own and parse nothing of a page but a proxy
 * request, run the daemon's default like sandbox-gw, on the default bridge and on that network.
 */

export const CONFIG_LABEL = `${BROWSER_LABEL}config`
/** The egress proxy's own environment switch for local sites (infra/sandbox/client-egress.mjs). */
export const LOCAL_ROUTES_GUARD = 'RADITI_EGRESS_LOCAL_ROUTES'

export interface BrowserSessionPlace {
  identity: BrowserSessionIdentity
  deadline: number
  network: NetworkPlace
}

/** The fixed addresses of the session's network. */
export const sessionAddresses = (network: NetworkPlace) => ({
  egress: subnetAddress(network.subnet, browserSessionAddresses.egress),
  browser: subnetAddress(network.subnet, browserSessionAddresses.browser),
  forwarder: subnetAddress(network.subnet, browserSessionAddresses.forwarder),
})

/** A container's desired state as a label: an existing one with another value is replaced. */
function labelled(
  options: Docker.ContainerCreateOptions,
  place: BrowserSessionPlace,
  role: BrowserSessionRole,
): Docker.ContainerCreateOptions {
  return {
    ...options,
    Labels: {
      ...browserSessionLabels(place.identity, role, place.deadline),
      [CONFIG_LABEL]: configHash(options),
    },
  }
}

/**
 * The egress proxy (infra/sandbox/client-egress.mjs, the `client-egress` target of
 * infra/sandbox/Dockerfile): the browser's only way out. It listens on its address of the
 * session's network, takes requests of the browser's address alone, opens TLS tunnels to the
 * listed `host:port` only, with an ECH whose outer name is that host taken as its SNI, and never
 * to an address that is not public or of the platform. Local sites (outside production) are
 * plain-http routes to a fixed target; `host.docker.internal` names this host on Linux as on
 * Docker Desktop.
 */
export function egressContainer(input: {
  place: BrowserSessionPlace
  /** The proxy refuses LOCAL_HTTP_ROUTES in production itself: it must know where it runs. */
  appEnv: AppEnv
  image: string
  limits: { cpu: number; memoryMiB: number; pids: number }
  allowedHosts: readonly string[]
  /** `host:port` of a local site's origin → its fixed `host:port`. */
  localRoutes: Readonly<Record<string, string>>
  refusedSubnets: readonly string[]
  maxTunnels: number
}): Docker.ContainerCreateOptions {
  const addresses = sessionAddresses(input.place.network)
  const local = Object.keys(input.localRoutes).length > 0
  return labelled(
    {
      name: browserSessionNames(input.place.identity.sessionId).container('egress'),
      Image: input.image,
      User: SERVICE_USER,
      Env: [
        `APP_ENV=${input.appEnv}`,
        `LISTEN_HOST=${addresses.egress}`,
        `LISTEN_PORT=${EGRESS_PORT}`,
        `CLIENT_IPV4=${addresses.browser}`,
        `ALLOWED_HOSTS=${JSON.stringify(input.allowedHosts)}`,
        // Chromium sends ECH in every TLS handshake, with no flag to turn it off: a ClientHello
        // whose outer name is the listed host passes (owner's decision of 26.10.2026).
        'ECH_OUTER_NAME=1',
        `MAX_TUNNELS=${input.maxTunnels}`,
        ...(input.refusedSubnets.length
          ? [`REFUSED_SUBNETS=${input.refusedSubnets.join(',')}`]
          : []),
        ...(local
          ? [`LOCAL_HTTP_ROUTES=${JSON.stringify(input.localRoutes)}`, `${LOCAL_ROUTES_GUARD}=1`]
          : []),
      ],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(input.limits),
        NetworkMode: 'bridge',
        ...(local ? { ExtraHosts: ['host.docker.internal:host-gateway'] } : {}),
        Tmpfs: { '/tmp': tmpfs(SERVICE_USER, '16m') },
        Sysctls: serviceSysctls,
      },
    },
    input.place,
    'egress',
  )
}

/**
 * The forwarder of the control port (infra/preview/forward.mjs): on the default bridge and on
 * the session's network, it publishes Chromium's control port on the host loopback only. Whoever
 * reaches the port still needs the secret path.
 */
export function forwarderContainer(input: {
  place: BrowserSessionPlace
  image: string
  limits: { cpu: number; memoryMiB: number; pids: number }
}): Docker.ContainerCreateOptions {
  const addresses = sessionAddresses(input.place.network)
  return labelled(
    {
      name: browserSessionNames(input.place.identity.sessionId).container('forwarder'),
      Image: input.image,
      User: SERVICE_USER,
      Entrypoint: node('forward.mjs'),
      Cmd: [`0.0.0.0:${BROWSER_CONTROL_PORT}=${addresses.browser}:${BROWSER_CONTROL_PORT}`],
      Env: [],
      ExposedPorts: { [`${BROWSER_CONTROL_PORT}/tcp`]: {} },
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(input.limits),
        NetworkMode: 'bridge',
        PortBindings: {
          [`${BROWSER_CONTROL_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }],
        },
        Tmpfs: { [posix.dirname(FORWARD_READY_FILE)]: tmpfs(SERVICE_USER, '1m') },
        Sysctls: serviceSysctls,
      },
    },
    input.place,
    'forwarder',
  )
}

/**
 * Chromium (infra/preview/Dockerfile, target `browser`) behind Playwright's launchServer: the
 * session's network only, every request of a page to the egress proxy. Its control path is a
 * secret the runtime writes into the state tmpfs after start; a restart empties it.
 */
export function browserContainer(input: {
  place: BrowserSessionPlace
  image: string
  runtime: PreviewRuntimeKind
  limits: { cpu: number; memoryMiB: number; pids: number; shmMiB: number }
}): Docker.ContainerCreateOptions {
  const addresses = sessionAddresses(input.place.network)
  return labelled(
    {
      name: browserSessionNames(input.place.identity.sessionId).container('browser'),
      Image: input.image,
      User: SERVICE_USER,
      Entrypoint: ['/usr/bin/tini', '--', '/usr/bin/node', `${TOOLS}/browser/server.mjs`],
      Cmd: [
        `--host=${addresses.browser}`,
        `--port=${BROWSER_CONTROL_PORT}`,
        `--proxy=http://${addresses.egress}:${EGRESS_PORT}`,
      ],
      Env: ['HOME=/tmp'],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        ...hardened(input.limits, input.runtime),
        NetworkMode: input.place.network.id,
        ShmSize: input.limits.shmMiB * 1024 * 1024,
        Tmpfs: {
          // Chromium maps its own code there.
          '/tmp': tmpfs(SERVICE_USER, '512m').replace('noexec,', ''),
          [BROWSER_STATE_DIR]: tmpfs(SERVICE_USER, '1m'),
        },
      },
      NetworkingConfig: {
        EndpointsConfig: fixedAddress(input.place.network.id, addresses.browser),
      },
    },
    input.place,
    'browser',
  )
}

/** host-firewall.mjs for the session's bridge (runsc): labelled to be found and reaped. */
export function firewallContainer(input: {
  identity: BrowserSessionIdentity
  image: string
  args: string[]
  suffix: string
}): Docker.ContainerCreateOptions {
  return hostFirewallOptions({
    name: browserSessionNames(input.identity.sessionId).container('firewall', input.suffix),
    image: input.image,
    args: input.args,
    labels: browserSessionLabels(input.identity, 'firewall', Date.now() + 60_000),
  })
}
