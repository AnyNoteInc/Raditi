import { Buffer } from 'node:buffer'
import { Duplex } from 'node:stream'

import type { BrowserSessionRuntimeSpec } from '@repo/domain'
import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import {
  BROWSER_READY_FILE,
  BROWSER_SECRET_FILE,
  FORWARD_READY_FILE,
} from '../preview/containers.ts'
import type { DockerBrowserSessionConfig } from './config.ts'
import { browserSessionBridge } from './resources.ts'
import { createDockerBrowserSessionRuntime, localSiteRoute } from './runtime.ts'

const image = (name: string) => `registry.local:3300/raditi/${name}@sha256:${'0'.repeat(63)}1`
const sessionId = '0196abcd-0000-7000-8000-0000000000a1'
const deadline = 1_900_000_000_000
const role = (options: Docker.ContainerCreateOptions) =>
  options.Labels?.['io.raditi.browser.role'] ?? 'other'

function spec(patch: Partial<BrowserSessionRuntimeSpec> = {}): BrowserSessionRuntimeSpec {
  return {
    sessionId,
    taskId: '0196abcd-0000-7000-8000-0000000000a2',
    siteId: '0196abcd-0000-7000-8000-0000000000a3',
    allowedHosts: ['news.example.ru:443', 'www.news.example.ru:443'],
    localSites: [],
    deadline,
    ...patch,
  }
}

const config = (patch: Partial<DockerBrowserSessionConfig> = {}): DockerBrowserSessionConfig => ({
  appEnv: 'test',
  runtime: 'runc',
  images: { browser: image('browser'), forwarder: image('tools'), egress: image('egress') },
  refusedSubnets: ['84.201.128.0/18'],
  ...patch,
})

interface FakeContainer {
  id: string
  name: string
  options: Docker.ContainerCreateOptions
  running: boolean
  networks: Record<string, { NetworkID: string; IPAddress: string }>
  ports: Record<string, { HostIp: string; HostPort: string }[]>
  files: Map<string, Buffer>
}
type ExecCall = { role: string; argv: string[]; stdin: Buffer }

const missing = () => Object.assign(new Error('missing'), { statusCode: 404 })
const matchesLabels = (labels: Record<string, string> | undefined, filter?: string[]) =>
  (filter ?? []).every((entry) => {
    const [key, value] = entry.split('=')
    return labels?.[key!] === value
  })
const frame = (stream: 1 | 2, value: Buffer) => {
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(value.length, 4)
  return Buffer.concat([header, value])
}

/**
 * An in-memory Docker daemon: enough of dockerode for the runtime. A start empties a container's
 * tmpfs, as Docker does; `exits` makes a container stop as soon as it starts.
 */
function daemon(
  options: {
    runtimes?: Record<string, object>
    missingImages?: string[]
    exits?: (container: FakeContainer) => boolean
  } = {},
) {
  let serial = 0
  const id = () => (++serial).toString(16).padStart(64, '0')
  const containers = new Map<string, FakeContainer>()
  const networks = new Map<string, Docker.NetworkInspectInfo & { Labels: Record<string, string> }>()
  const events: string[] = []
  const execs: ExecCall[] = []

  const answer = (container: FakeContainer, call: ExecCall) => {
    const [command, ...args] = call.argv
    if (command === 'test') return { code: container.files.has(args[1]!) ? 0 : 1 }
    if (command === 'cat') {
      const file = container.files.get(args[0]!)
      return file ? { code: 0, stdout: file.toString() } : { code: 1 }
    }
    if (command === '/bin/sh' && args[2] === 'raditi') {
      container.files.set(args[3]!, call.stdin)
      // The browser server reads its secret and becomes ready.
      if (args[3] === BROWSER_SECRET_FILE)
        container.files.set(BROWSER_READY_FILE, Buffer.from('ready'))
      return { code: 0 }
    }
    // The egress proxy's check: it listens.
    return { code: 0 }
  }

  const containerApi = (container: FakeContainer) => ({
    id: container.id,
    inspect: async () => {
      if (!containers.has(container.id)) throw missing()
      return {
        Id: container.id,
        Name: `/${container.name}`,
        State: { Running: container.running },
        Config: {
          User: container.options.User,
          Env: container.options.Env ?? [],
          Labels: container.options.Labels ?? {},
          Image: container.options.Image,
        },
        HostConfig: structuredClone(container.options.HostConfig ?? {}),
        Mounts: [],
        NetworkSettings: {
          Networks: structuredClone(container.networks),
          Ports: structuredClone(container.ports),
        },
      }
    },
    start: async () => {
      if (!containers.has(container.id)) throw missing()
      container.files.clear()
      container.running = !options.exits?.(container)
      events.push(`start:${role(container.options)}`)
      for (const [port, bindings] of Object.entries(
        container.options.HostConfig?.PortBindings ?? {},
      ))
        container.ports[port] = (bindings as { HostIp: string }[]).map((binding) => ({
          HostIp: binding.HostIp,
          HostPort: String(40_000 + serial),
        }))
      if ([container.options.Entrypoint ?? []].flat().some((part) => part.endsWith('forward.mjs')))
        container.files.set(FORWARD_READY_FILE, Buffer.from('ready'))
    },
    wait: async () => ({ StatusCode: 0 }),
    remove: async () => {
      if (!containers.delete(container.id)) throw missing()
      events.push(`remove:${role(container.options)}`)
    },
    exec: async (request: Docker.ExecCreateOptions) => {
      const call: ExecCall = {
        role: role(container.options),
        argv: request.Cmd ?? [],
        stdin: Buffer.alloc(0),
      }
      let result: { code: number; stdout?: string } = { code: 0 }
      return {
        start: async () => {
          const chunks: Buffer[] = []
          return new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              chunks.push(Buffer.from(chunk))
              callback()
            },
            final(callback) {
              call.stdin = Buffer.concat(chunks)
              execs.push(call)
              result = answer(container, call)
              this.push(frame(1, Buffer.from(result.stdout ?? '')))
              this.push(null)
              callback()
            },
          })
        },
        inspect: async () => ({ Running: false, ExitCode: result.code }),
      }
    },
  })

  const client = {
    info: async () => ({ Runtimes: options.runtimes ?? { runc: { path: 'runc' } } }),
    getImage: (ref: string) => ({
      inspect: async () => {
        if (options.missingImages?.includes(ref)) throw missing()
        return { Config: {} }
      },
    }),
    createContainer: async (request: Docker.ContainerCreateOptions) => {
      if ([...containers.values()].some((item) => item.name === request.name))
        throw Object.assign(new Error('conflict'), { statusCode: 409 })
      const container: FakeContainer = {
        id: id(),
        name: request.name!,
        options: request,
        running: false,
        networks: {},
        ports: {},
        files: new Map(),
      }
      const mode = request.HostConfig?.NetworkMode
      const network = [...networks.values()].find((item) => item.Id === mode)
      if (network)
        container.networks[network.Name] = {
          NetworkID: network.Id,
          IPAddress:
            request.NetworkingConfig?.EndpointsConfig?.[network.Id]?.IPAMConfig?.IPv4Address ??
            '172.30.0.9',
        }
      if (mode === 'bridge')
        container.networks.bridge = { NetworkID: 'bridge', IPAddress: `172.17.0.${serial}` }
      containers.set(container.id, container)
      events.push(`create:${role(request)}`)
      return containerApi(container)
    },
    getContainer: (containerId: string) => {
      const container = containers.get(containerId)
      if (!container)
        return {
          inspect: async () => Promise.reject(missing()),
          remove: async () => Promise.reject(missing()),
        }
      return containerApi(container)
    },
    listContainers: async (request: { filters: { label?: string[]; name?: string[] } }) =>
      [...containers.values()]
        .filter((item) => matchesLabels(item.options.Labels, request.filters.label))
        .filter((item) => !request.filters.name || request.filters.name[0] === `^/${item.name}$`)
        .map((item) => ({
          Id: item.id,
          Names: [`/${item.name}`],
          Labels: item.options.Labels,
          State: item.running ? 'running' : 'exited',
        })),
    createNetwork: async (request: Docker.NetworkCreateOptions) => {
      const info = {
        Id: id(),
        Name: request.Name,
        Driver: request.Driver,
        Internal: request.Internal,
        EnableIPv6: request.EnableIPv6,
        Options: request.Options,
        Labels: request.Labels ?? {},
        IPAM: { Config: [{ Subnet: `172.${30 + networks.size}.0.0/24` }] },
      } as unknown as Docker.NetworkInspectInfo & { Labels: Record<string, string> }
      networks.set(info.Id, info)
      events.push('network:create')
      return client.getNetwork(info.Id)
    },
    getNetwork: (networkId: string) => ({
      id: networkId,
      inspect: async () => {
        const info = networks.get(networkId)
        if (!info) throw missing()
        return structuredClone(info)
      },
      remove: async () => {
        if (!networks.delete(networkId)) throw missing()
        events.push('network:remove')
      },
      connect: async (request: { Container: string; EndpointConfig: Docker.EndpointSettings }) => {
        const info = networks.get(networkId)!
        const container = containers.get(request.Container)!
        container.networks[info.Name] = {
          NetworkID: networkId,
          IPAddress: request.EndpointConfig.IPAMConfig!.IPv4Address!,
        }
        events.push(`network:connect:${role(container.options)}`)
      },
    }),
    listNetworks: async (request: { filters: { label: string[] } }) =>
      [...networks.values()]
        .filter((info) => matchesLabels(info.Labels, request.filters.label))
        .map((info) => ({ Id: info.Id, Name: info.Name, Labels: info.Labels })),
  }
  const byRole = (wanted: string) =>
    [...containers.values()].filter((item) => role(item.options) === wanted)
  return { client: client as unknown as Docker, containers, networks, events, execs, byRole }
}

describe('Docker browser session runtime', () => {
  it('builds the network, the egress proxy, the forwarder and Chromium; answers a loopback endpoint', async () => {
    const fake = daemon()
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    const { endpoint } = await runtime.start(spec())
    const url = new URL(endpoint)
    expect(url.protocol).toBe('ws:')
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname).toMatch(/^\/[A-Za-z0-9_-]{43}$/)
    expect(fake.events.filter((event) => !event.startsWith('start'))).toEqual([
      'network:create',
      'create:egress',
      'network:connect:egress',
      'create:forwarder',
      'network:connect:forwarder',
      'create:browser',
    ])
    // A hostless internal bridge, the name the host firewall knows.
    const [network] = [...fake.networks.values()]
    expect(network).toMatchObject({
      Name: `raditi-browser-${sessionId}`,
      Internal: true,
      Options: { 'com.docker.network.bridge.name': browserSessionBridge(sessionId) },
    })
    // Dual-homed at fixed addresses; Chromium on the session's network alone.
    expect(fake.byRole('egress')[0]!.networks[network!.Name]!.IPAddress).toBe('172.30.0.2')
    expect(fake.byRole('forwarder')[0]!.networks[network!.Name]!.IPAddress).toBe('172.30.0.4')
    expect(Object.values(fake.byRole('browser')[0]!.networks)).toEqual([
      { NetworkID: network!.Id, IPAddress: '172.30.0.3' },
    ])
    // The secret path lives in Chromium's tmpfs and in the endpoint, nowhere Docker shows.
    const shown = JSON.stringify([...fake.containers.values()].map((item) => item.options))
    expect(shown).not.toContain(url.pathname)
    expect(fake.byRole('browser')[0]!.files.get(BROWSER_SECRET_FILE)?.toString()).toBe(url.pathname)
    expect(await runtime.list()).toEqual([sessionId])
  })

  it('keeps a healthy session as it is: the same endpoint, nothing created', async () => {
    const fake = daemon()
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    const first = await runtime.start(spec())
    const created = fake.events.length
    expect(await runtime.start(spec())).toEqual(first)
    expect(fake.events.slice(created).filter((event) => !event.startsWith('start'))).toEqual([])
  })

  it('replaces only the egress proxy when the hosts change; the browser and its sign-in stay', async () => {
    const fake = daemon()
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    const first = await runtime.start(spec())
    const browser = fake.byRole('browser')[0]!.id
    const before = fake.events.length
    const again = await runtime.start(spec({ allowedHosts: ['news.example.ru:443'] }))
    expect(again).toEqual(first)
    expect(fake.events.slice(before)).toEqual([
      'remove:egress',
      'create:egress',
      'network:connect:egress',
      'start:egress',
    ])
    expect(fake.byRole('browser')[0]!.id).toBe(browser)
    expect(fake.byRole('egress')[0]!.options.Env).toContain('ALLOWED_HOSTS=["news.example.ru:443"]')
  })

  it('starts a stopped browser again under a new secret path', async () => {
    const fake = daemon()
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    const first = await runtime.start(spec())
    fake.byRole('browser')[0]!.running = false
    const again = await runtime.start(spec())
    expect(new URL(again.endpoint).port).toBe(new URL(first.endpoint).port)
    expect(new URL(again.endpoint).pathname).not.toBe(new URL(first.endpoint).pathname)
  })

  it('builds a broken session anew, from nothing', async () => {
    const dying = new Set<string>()
    const fake = daemon({ exits: (container) => dying.has(container.id) })
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    await runtime.start(spec())
    // The kept browser stopped and does not come back when started again.
    const old = fake.byRole('browser')[0]!
    old.running = false
    dying.add(old.id)
    const before = fake.events.length
    const { endpoint } = await runtime.start(spec())
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}$/)
    expect(fake.byRole('browser').map((item) => item.id)).not.toContain(old.id)
    expect(fake.events.slice(before)).toEqual(
      expect.arrayContaining([
        'remove:browser',
        'remove:egress',
        'remove:forwarder',
        'network:remove',
        'network:create',
      ]),
    )
    expect(fake.byRole('browser')[0]!.running).toBe(true)
  })

  it('leaves nothing of a new session that does not come up, and says nothing of its path', async () => {
    const fake = daemon({ exits: (container) => container.name.endsWith('-browser') })
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    const error = await runtime.start(spec()).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(fake.containers.size).toBe(0)
    expect(fake.networks.size).toBe(0)
    expect(await runtime.list()).toEqual([])
    const secret = fake.execs.find((call) => call.argv.includes(BROWSER_SECRET_FILE))
    if (secret?.stdin.length) expect(String(error)).not.toContain(secret.stdin.toString())
  })

  it('refuses a session of another task or site; builds one of another deadline anew', async () => {
    const fake = daemon()
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    await runtime.start(spec())
    await expect(
      runtime.start(spec({ taskId: '0196abcd-0000-7000-8000-0000000000ff' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      runtime.start(spec({ siteId: '0196abcd-0000-7000-8000-0000000000ff' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const before = fake.events.length
    await runtime.start(spec({ deadline: deadline + 60_000 }))
    expect(fake.events.slice(before)).toEqual(
      expect.arrayContaining(['remove:browser', 'network:remove', 'network:create']),
    )
    expect(
      [...fake.containers.values()].every(
        (item) => item.options.Labels?.['io.raditi.browser.deadline'] === String(deadline + 60_000),
      ),
    ).toBe(true)
  })

  it('stops whole and twice, and lists nothing after', async () => {
    const fake = daemon()
    const runtime = createDockerBrowserSessionRuntime(config(), { client: fake.client })
    await runtime.start(spec())
    await runtime.stop(sessionId)
    expect(fake.containers.size).toBe(0)
    expect(fake.networks.size).toBe(0)
    await runtime.stop(sessionId)
    expect(await runtime.list()).toEqual([])
    await expect(runtime.stop('../etc')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses specs that are not a session’s', async () => {
    const runtime = createDockerBrowserSessionRuntime(config(), { client: daemon().client })
    for (const bad of [
      spec({ sessionId: 'session-1' }),
      spec({ taskId: sessionId.toUpperCase() }),
      spec({ deadline: Date.now() - 1 }),
      spec({ allowedHosts: ['news.example.ru'] }),
      spec({ allowedHosts: ['NEWS.example.ru:443'] }),
      spec({ allowedHosts: ['10.0.0.1:443'] }),
      spec({ allowedHosts: ['wp.localhost:443'] }),
      spec({ allowedHosts: ['news.example.ru:443', 'news.example.ru:443'] }),
      spec({ allowedHosts: [] }),
      // Local sites are refused where the configuration does not allow them.
      spec({ localSites: [{ origin: 'http://wp.localhost:8080', target: '127.0.0.1:8080' }] }),
    ])
      await expect(runtime.start(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('gives local sites to the egress proxy only where allowed, plain http and by name', async () => {
    const fake = daemon()
    const runtime = createDockerBrowserSessionRuntime(config({ localSites: true }), {
      client: fake.client,
    })
    await runtime.start(
      spec({
        allowedHosts: [],
        localSites: [{ origin: 'http://wp.localhost:8080', target: 'host.docker.internal:18080' }],
      }),
    )
    const egress = fake.byRole('egress')[0]!.options
    expect(egress.Env).toEqual(
      expect.arrayContaining([
        'APP_ENV=test',
        'ALLOWED_HOSTS=[]',
        'LOCAL_HTTP_ROUTES={"wp.localhost:8080":"host.docker.internal:18080"}',
        'RADITI_EGRESS_LOCAL_ROUTES=1',
      ]),
    )
    expect(egress.HostConfig?.ExtraHosts).toEqual(['host.docker.internal:host-gateway'])
    for (const site of [
      { origin: 'https://wp.localhost:8443', target: '127.0.0.1:8443' },
      { origin: 'http://127.0.0.1:8080', target: '127.0.0.1:8080' },
      { origin: 'http://wp.localhost:8080/', target: '127.0.0.1:8080' },
      { origin: 'http://wp.localhost:8080', target: '127.0.0.1' },
      { origin: 'http://wp.localhost:8080', target: 'http://127.0.0.1:8080' },
      { origin: 'http://wp.localhost:8080', target: '999.1.1.1:8080' },
      { origin: 'http://wp.localhost:8080', target: 'wp..internal:8080' },
      { origin: 'http://wp.localhost:8080', target: '-wp.internal:8080' },
      { origin: 'http://wp.10:8080', target: '127.0.0.1:8080' },
    ])
      await expect(
        runtime.start(spec({ allowedHosts: [], localSites: [site] })),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(localSiteRoute({ origin: 'http://wordpress', target: '10.0.0.7:80' })).toEqual([
      'wordpress:80',
      '10.0.0.7:80',
    ])
  })

  it('tells the egress proxy where it runs, and never takes local sites in production', async () => {
    const fake = daemon({ runtimes: { runsc: { path: '/usr/local/bin/runsc' } } })
    const production = config({ appEnv: 'production', runtime: 'runsc', firewallImage: image('g') })
    await createDockerBrowserSessionRuntime(production, { client: fake.client }).start(spec())
    // The proxy's own refusal of LOCAL_HTTP_ROUTES (client-egress.mjs) needs APP_ENV to fire.
    expect(fake.byRole('egress')[0]!.options.Env).toContain('APP_ENV=production')
    expect(() =>
      createDockerBrowserSessionRuntime(
        { ...production, localSites: true },
        { client: fake.client },
      ),
    ).toThrow(/production/)
    // APP_ENV is never defaulted: without it the production checks could not fire.
    const { appEnv: _omitted, ...unnamed } = config()
    expect(() =>
      createDockerBrowserSessionRuntime(unnamed as DockerBrowserSessionConfig, {
        client: fake.client,
      }),
    ).toThrow()
  })

  it('guards the bridge on the host before Chromium joins it under runsc, and sweeps after', async () => {
    const fake = daemon({ runtimes: { runsc: { path: '/usr/local/bin/runsc' } } })
    const runtime = createDockerBrowserSessionRuntime(
      config({ runtime: 'runsc', firewallImage: image('guard') }),
      { client: fake.client },
    )
    await runtime.start(spec())
    const order = fake.events.filter((event) => event.startsWith('create:'))
    expect(order.indexOf('create:firewall')).toBeLessThan(order.indexOf('create:browser'))
    expect(fake.byRole('browser')[0]!.options.HostConfig?.Runtime).toBe('runsc')
    // The helpers are gone once they ran.
    expect(fake.byRole('firewall')).toEqual([])
    const before = fake.events.length
    await runtime.stop(sessionId)
    expect(fake.events.slice(before)).toContain('create:firewall')
    expect(() =>
      createDockerBrowserSessionRuntime(config({ runtime: 'runsc' }), { client: fake.client }),
    ).toThrow(/firewall/)
  })

  it('never pulls an image and needs its runtime', async () => {
    const pulled = daemon({ missingImages: [image('browser')] })
    await expect(
      createDockerBrowserSessionRuntime(config(), { client: pulled.client }).start(spec()),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(pulled.containers.size).toBe(0)
    const noRunsc = daemon()
    await expect(
      createDockerBrowserSessionRuntime(config({ runtime: 'runsc', firewallImage: image('g') }), {
        client: noRunsc.client,
      }).start(spec()),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
  })
})
