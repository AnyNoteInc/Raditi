import { Buffer } from 'node:buffer'
import { Duplex } from 'node:stream'

import { PREVIEW_SETTINGS_PATH, previewSettingsSchema, type PreviewRuntimeSpec } from '@repo/domain'
import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import { previewRuntimeLimits } from './config.ts'
import {
  BROWSER_READY_FILE,
  BROWSER_SECRET_FILE,
  DATABASE_READY_FILE,
  FORWARD_READY_FILE,
} from './containers.ts'
import { browserBridge, previewBridge } from './resources.ts'
import { createDockerPreviewRuntime } from './runtime.ts'

// The preview of one container (docs/plan/58): the site's server, its database and its entry
// gateway in one container on a bridge of its own, the host rules of that bridge before it starts.

const image = (name: string) => `registry.local:3300/raditi/${name}@sha256:${'0'.repeat(63)}1`
const previewId = '0196abcd-0000-7000-8000-00000000000a'
const hostname = 'site-0f3a9c1b-chat-a1b2c3.localhost'
const secretValue = 'client-api-key-value-123'
/** The deadline label: `expiresAt` plus the grace the watchdog leaves core. */
const label = (expiresAt: number) => String(expiresAt + previewRuntimeLimits.deadlineGraceMs)

function spec(patch: Partial<PreviewRuntimeSpec> = {}): PreviewRuntimeSpec {
  return {
    previewId,
    siteId: '0196abcd-0000-7000-8000-00000000000b',
    taskId: '0196abcd-0000-7000-8000-00000000000c',
    runtime: 'runc',
    images: { preview: image('site'), tools: image('tools') },
    database: true,
    recipe: {
      runtime: 'php',
      runtimeVersions: ['8.3'],
      database: 'mysql',
      requiredPaths: [],
      generatedFiles: [],
      settings: { DEBUG: false },
      healthPath: '/',
      web: {
        command: ['apache2-foreground', '-f', '/run/raditi/preview/apache2.conf'],
        env: { APACHE_RUN_DIR: '/tmp/apache2/run' },
        port: 8081,
        user: '33:33',
        docroot: '/var/www/html',
        tmpfs: ['/tmp'],
        configFiles: [{ name: 'apache2.conf', content: 'Listen 127.0.0.1:8081' }],
      },
    },
    limits: { cpu: 2, memoryMiB: 2048, pids: 512 },
    upstreamHost: '127.0.0.1',
    hostname,
    origin: `http://${hostname}:8090`,
    productionOrigin: 'https://shop.example.ru',
    expiresAt: 1_900_000_000_000,
    ...patch,
  }
}

interface FakeContainer {
  id: string
  name: string
  options: Docker.ContainerCreateOptions
  running: boolean
  networks: Record<string, { NetworkID: string; IPAddress: string }>
  ports: Record<string, { HostIp: string; HostPort: string }[]>
  files: Map<string, Buffer>
}
interface ExecCall {
  role: string
  argv: string[]
  user: string
  env: string[]
  stdin: Buffer
}
type ExecAnswer = { code: number; stdout?: string; stderr?: string }

const missing = () => Object.assign(new Error('missing'), { statusCode: 404 })
const roleOf = (options: Docker.ContainerCreateOptions) =>
  options.Labels?.['io.raditi.preview.role'] ?? 'other'
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

/** An in-memory Docker daemon: enough of dockerode for the preview runtime. */
function daemon(
  options: {
    images?: Record<string, { Config: { Volumes?: Record<string, object> } }>
    runtimes?: Record<string, object>
    answer?: (call: ExecCall) => ExecAnswer | undefined
    hostedNetwork?: boolean
  } = {},
) {
  let serial = 0
  const id = () => (++serial).toString(16).padStart(64, '0')
  const containers = new Map<string, FakeContainer>()
  const networks = new Map<string, Docker.NetworkInspectInfo & { Labels: Record<string, string> }>()
  const volumes = new Map<string, { Name: string; Labels: Record<string, string> }>()
  const events: string[] = []
  const execs: ExecCall[] = []
  const created: Docker.ContainerCreateOptions[] = []

  const answer = (container: FakeContainer, call: ExecCall): ExecAnswer => {
    const custom = options.answer?.(call)
    if (custom) return custom
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
    return { code: 0, stdout: '{"ok":true}' }
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
          WorkingDir: container.options.WorkingDir ?? '',
          Entrypoint: container.options.Entrypoint,
          Cmd: container.options.Cmd,
        },
        HostConfig: structuredClone(container.options.HostConfig ?? {}),
        Mounts: (container.options.HostConfig?.Mounts ?? []).map((mount) => ({
          Type: mount.Type,
          Name: mount.Source,
          Destination: mount.Target,
        })),
        NetworkSettings: {
          Networks: structuredClone(container.networks),
          Ports: structuredClone(container.ports),
        },
      }
    },
    start: async () => {
      if (!containers.has(container.id)) throw missing()
      container.running = true
      events.push(`start:${roleOf(container.options)}`)
      for (const [port, bindings] of Object.entries(
        container.options.HostConfig?.PortBindings ?? {},
      ))
        container.ports[port] = (bindings as { HostIp: string }[]).map((binding) => ({
          HostIp: binding.HostIp,
          HostPort: String(40_000 + serial),
        }))
      const entrypoint = [container.options.Entrypoint ?? []].flat()
      if (entrypoint.some((part) => part.endsWith('forward.mjs')))
        container.files.set(FORWARD_READY_FILE, Buffer.from('ready'))
      // The init of a preview starts its gateway and, with a database, writes that it answers.
      if (entrypoint.some((part) => part.endsWith('init.sh'))) {
        container.files.set(FORWARD_READY_FILE, Buffer.from('ready'))
        if (container.options.Env?.includes('RADITI_DATABASE=1'))
          container.files.set(DATABASE_READY_FILE, Buffer.from('ready'))
      }
    },
    stop: async () => {
      container.running = false
      events.push(`stop:${roleOf(container.options)}`)
    },
    wait: async () => ({ StatusCode: 0 }),
    remove: async () => {
      if (!containers.delete(container.id)) throw missing()
      events.push(`remove:${roleOf(container.options)}`)
    },
    exec: async (request: Docker.ExecCreateOptions) => {
      const call: ExecCall = {
        role: roleOf(container.options),
        argv: request.Cmd ?? [],
        user: request.User ?? '',
        env: request.Env ?? [],
        stdin: Buffer.alloc(0),
      }
      let result: ExecAnswer = { code: 0 }
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
              if (result.stderr) this.push(frame(2, Buffer.from(result.stderr)))
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
        const known = options.images?.[ref]
        if (known) return known
        // The official PHP images declare the docroot a volume; the runtime mounts it.
        if (ref.includes('/site')) return { Config: { Volumes: { '/var/www/html': {} } } }
        return { Config: {} }
      },
    }),
    createContainer: async (request: Docker.ContainerCreateOptions) => {
      if ([...containers.values()].some((item) => item.name === request.name))
        throw Object.assign(new Error('conflict'), { statusCode: 409 })
      created.push(request)
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
            '172.23.0.1',
        }
      if (mode === 'bridge')
        container.networks.bridge = { NetworkID: 'bridge', IPAddress: `172.17.0.${serial}` }
      containers.set(container.id, container)
      events.push(`create:${roleOf(request)}`)
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
      const index = networks.size
      const info = {
        Id: id(),
        Name: request.Name,
        Driver: request.Driver,
        Internal: request.Internal,
        EnableIPv6: request.EnableIPv6,
        Options: request.Options,
        Labels: request.Labels ?? {},
        IPAM: {
          Config: [
            {
              Subnet: `172.${23 + index}.0.0/16`,
              ...(options.hostedNetwork ? { Gateway: `172.${23 + index}.0.1` } : {}),
            },
          ],
        },
      } as unknown as Docker.NetworkInspectInfo & { Labels: Record<string, string> }
      networks.set(info.Id, info)
      events.push(`network:create:${request.Labels?.['io.raditi.preview.role']}`)
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
        const info = networks.get(networkId)
        if (!info) throw missing()
        networks.delete(networkId)
        events.push(`network:remove:${info.Labels['io.raditi.preview.role']}`)
      },
      connect: async (request: { Container: string; EndpointConfig: Docker.EndpointSettings }) => {
        const info = networks.get(networkId)!
        const container = containers.get(request.Container)!
        container.networks[info.Name] = {
          NetworkID: networkId,
          IPAddress: request.EndpointConfig.IPAMConfig!.IPv4Address!,
        }
        events.push(`network:connect:${roleOf(container.options)}`)
      },
    }),
    listNetworks: async (request: { filters: { label: string[] } }) =>
      [...networks.values()]
        .filter((info) => matchesLabels(info.Labels, request.filters.label))
        .map((info) => ({ Id: info.Id, Name: info.Name, Labels: info.Labels })),
    createVolume: async (request: { Name: string; Labels: Record<string, string> }) => {
      volumes.set(request.Name, { Name: request.Name, Labels: request.Labels })
      events.push(`volume:create:${request.Labels['io.raditi.preview.role']}`)
    },
    getVolume: (name: string) => ({
      inspect: async () => volumes.get(name) ?? Promise.reject(missing()),
      remove: async () => {
        if (!volumes.delete(name)) throw missing()
        events.push(`volume:remove:${name.split('-').at(-1)}`)
      },
    }),
    listVolumes: async (request: { filters: { label: string[] } }) => ({
      Volumes: [...volumes.values()].filter((volume) =>
        matchesLabels(volume.Labels, request.filters.label),
      ),
    }),
  }
  const byRole = (role: string) =>
    [...containers.values()].filter((item) => roleOf(item.options) === role)
  return {
    client: client as unknown as Docker,
    containers,
    networks,
    volumes,
    events,
    execs,
    created,
    byRole,
    one: (role: string) => {
      const found = byRole(role)
      expect(found).toHaveLength(1)
      return found[0]!
    },
  }
}

const runtimeOn = (fake: ReturnType<typeof daemon>, patch: object = {}) =>
  createDockerPreviewRuntime(
    {
      runtime: 'runc',
      gatewayPort: 8090,
      firewallImage: image('guard'),
      dnsServers: ['77.88.8.8', '77.88.8.1'],
      ...patch,
    },
    { client: fake.client },
  )

async function* archive() {
  yield Buffer.from('tar bytes')
}

/** The database passwords core keeps in Vault, and the client's variables. */
const passwords = { user: 'u'.repeat(32), root: 'r'.repeat(32) }
const secrets = (env: Record<string, string> = {}) => ({ env, database: passwords })
const firewallCalls = (fake: ReturnType<typeof daemon>) =>
  fake.created
    .filter((item) => item.Labels?.['io.raditi.preview.role'] === 'firewall')
    .map((item) => item.Cmd)

describe('Docker preview runtime: ensure', () => {
  it('builds one container on a bridge of its own, hardened, and returns the port of its gateway', async () => {
    const fake = daemon()
    const upstream = await runtimeOn(fake).ensure(spec(), secrets({ API_KEY: secretValue }))

    const [network] = [...fake.networks.values()]
    expect(network).toMatchObject({
      Name: `raditi-preview-${previewId}`,
      Internal: false,
      EnableIPv6: false,
      Options: {
        'com.docker.network.bridge.name': previewBridge(previewId),
        'com.docker.network.bridge.enable_icc': 'false',
      },
    })
    const preview = fake.one('preview')
    expect(preview.options).toMatchObject({
      name: `raditi-preview-${previewId}-preview`,
      Image: image('site'),
      User: '0:0',
      Entrypoint: ['/usr/bin/tini', '--', '/usr/local/lib/raditi/init.sh'],
      Cmd: ['apache2-foreground', '-f', '/run/raditi/preview/apache2.conf'],
      Env: [
        'APACHE_RUN_DIR=/tmp/apache2/run',
        `RADITI_HTTP_HOST=${hostname}`,
        'RADITI_WEB_PORT=8081',
        'RADITI_DATABASE=1',
        'RADITI_DNS_SERVERS=77.88.8.8,77.88.8.1',
      ],
      WorkingDir: '/var/www/html',
    })
    expect(preview.options.HostConfig).toMatchObject({
      Runtime: 'runc',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      // init starts each service as its own user, and only at the start (docs/plan/58).
      CapAdd: ['SETUID', 'SETGID', 'SETPCAP'],
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: 'no' },
      NetworkMode: network!.Id,
      Dns: ['77.88.8.8', '77.88.8.1'],
      // The forwarder of names inside binds 127.0.0.11:53 as 10001 (infra/preview/dns.mjs).
      Sysctls: {
        'net.ipv6.conf.all.disable_ipv6': '1',
        'net.ipv4.ip_unprivileged_port_start': '0',
      },
      NanoCpus: 2e9,
      Memory: 2048 * 1024 * 1024,
      MemorySwap: 2048 * 1024 * 1024,
      PidsLimit: 512,
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      Mounts: [
        {
          Type: 'volume',
          Source: `rpv-${previewId}-files`,
          Target: '/var/www/html',
          VolumeOptions: { NoCopy: true },
        },
        { Type: 'volume', Source: `rpv-${previewId}-db`, Target: '/var/lib/mysql' },
      ],
    })
    expect(preview.options.HostConfig?.Binds).toBeUndefined()
    expect(preview.options.HostConfig?.ExtraHosts).toBeUndefined()
    expect(Object.keys(preview.options.HostConfig!.Tmpfs!).sort()).toEqual([
      '/run/mysqld',
      '/run/raditi-forward',
      '/run/raditi/db',
      '/run/raditi/preview',
      '/run/raditi/ready',
      '/tmp',
    ])
    expect(preview.options.HostConfig!.Tmpfs!['/run/raditi/preview']).toMatch(/uid=33,gid=33/)
    expect(preview.options.HostConfig!.Tmpfs!['/run/raditi/db']).toMatch(
      /uid=999,gid=999,mode=0700$/,
    )
    expect(Object.keys(preview.networks)).toEqual([network!.Name])
    expect(upstream).toEqual({
      host: '127.0.0.1',
      port: Number(preview.ports['8080/tcp']![0]!.HostPort),
    })
    // One running container; the lease is created and never started.
    expect(
      [...fake.containers.values()]
        .filter((item) => item.running)
        .map((item) => roleOf(item.options)),
    ).toEqual(['preview'])
    for (const role of ['web', 'db', 'forwarder', 'egress', 'cli'])
      expect(fake.byRole(role)).toEqual([])

    expect([...fake.volumes.keys()].sort()).toEqual([
      `rpv-${previewId}-db`,
      `rpv-${previewId}-files`,
    ])
    // Every resource carries the identity, the protocol and the deadline the watchdog reads.
    for (const item of fake.containers.values())
      expect(item.options.Labels).toMatchObject({
        'io.raditi.preview.owner': 'raditi',
        'io.raditi.preview.protocol': '2',
        'io.raditi.preview.id': previewId,
        'io.raditi.preview.deadline': label(1_900_000_000_000),
      })
  })

  it('closes the host and the platform on the bridge before the container starts, under any runtime', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake, { refusedSubnets: ['84.201.128.0/18', '10.200.0.0/16'] })
    await runtime.ensure(spec(), secrets())
    expect(firewallCalls(fake)).toEqual([
      ['install', previewBridge(previewId), '--refuse', '84.201.128.0/18,10.200.0.0/16'],
    ])
    const firewall = fake.created.find(
      (item) => item.Labels?.['io.raditi.preview.role'] === 'firewall',
    )!
    expect(firewall).toMatchObject({
      Image: image('guard'),
      HostConfig: { Runtime: 'runc', NetworkMode: 'host', CapAdd: ['NET_ADMIN'], CapDrop: ['ALL'] },
    })
    const order = fake.events.filter((event) => event.startsWith('start:'))
    expect(order.indexOf('start:firewall')).toBeLessThan(order.indexOf('start:files-helper'))
    expect(order.indexOf('start:firewall')).toBeLessThan(order.indexOf('start:preview'))
    // Every build puts them again: a rule lost meanwhile comes back.
    await runtime.ensure(spec(), secrets())
    expect(firewallCalls(fake)).toHaveLength(2)
    // A helper that fails leaves no preview to start.
    const failing = daemon()
    const client = failing.client as unknown as {
      createContainer: (request: Docker.ContainerCreateOptions) => Promise<unknown>
    }
    const create = client.createContainer
    client.createContainer = async (request) => {
      const created = (await create(request)) as { wait: () => Promise<unknown> }
      if (request.Labels?.['io.raditi.preview.role'] === 'firewall')
        created.wait = async () => ({ StatusCode: 1 })
      return created
    }
    await expect(runtimeOn(failing).ensure(spec(), secrets())).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
    })
    expect(failing.byRole('preview')).toHaveLength(0)
    expect(() =>
      createDockerPreviewRuntime({
        runtime: 'runc',
        gatewayPort: 8090,
        dnsServers: ['77.88.8.8'],
      } as never),
    ).toThrow(/firewallImage/)
  })

  it('checks the rules of a running preview again with the same subnets, and nothing of a stopped one', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake, { refusedSubnets: ['84.201.128.0/18'] })
    await runtime.checkBoundary(previewId)
    expect(firewallCalls(fake)).toEqual([])
    await runtime.ensure(spec(), secrets())
    await runtime.checkBoundary(previewId)
    expect(firewallCalls(fake).at(-1)).toEqual([
      'check',
      previewBridge(previewId),
      '--refuse',
      '84.201.128.0/18',
    ])
    await runtime.stop(previewId)
    const helpers = firewallCalls(fake).length
    await runtime.checkBoundary(previewId)
    expect(firewallCalls(fake)).toHaveLength(helpers)
    await expect(runtime.checkBoundary('../etc')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // Rules that are not whole: the helper fails, and so does the check.
    const broken = daemon()
    const client = broken.client as unknown as {
      createContainer: (request: Docker.ContainerCreateOptions) => Promise<unknown>
    }
    const create = client.createContainer
    let checks = 0
    client.createContainer = async (request) => {
      const created = (await create(request)) as { wait: () => Promise<unknown> }
      if (
        request.Labels?.['io.raditi.preview.role'] === 'firewall' &&
        (request.Cmd as string[] | undefined)?.[0] === 'check'
      ) {
        checks++
        created.wait = async () => ({ StatusCode: 1 })
      }
      return created
    }
    const brokenRuntime = runtimeOn(broken)
    await brokenRuntime.ensure(spec(), secrets())
    await expect(brokenRuntime.checkBoundary(previewId)).rejects.toMatchObject({
      code: 'SANDBOX_COMMAND_FAILED',
    })
    expect(checks).toBe(1)
  })

  it('gives the docroot to the PHP user from a helper with that volume alone, on every build', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    const init = fake.created.find(
      (item) => item.Labels?.['io.raditi.preview.role'] === 'files-helper',
    )!
    expect(init).toMatchObject({
      Image: image('tools'),
      User: '0:0',
      HostConfig: {
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN'],
        NetworkMode: 'none',
        Mounts: [
          { Source: `rpv-${previewId}-files`, Target: '/files', VolumeOptions: { NoCopy: true } },
        ],
      },
    })
    expect(fake.execs.find((call) => call.role === 'files-helper')!.argv).toEqual([
      '/usr/local/bin/node',
      '/usr/local/lib/raditi/files.mjs',
      'init',
      '33:33',
    ])
    expect(fake.byRole('files-helper')).toHaveLength(0)
    await runtime.ensure(spec(), secrets())
    expect(
      fake.execs.filter((call) => call.role === 'files-helper' && call.argv.includes('init')),
    ).toHaveLength(2)
    expect(fake.byRole('files-helper')).toHaveLength(0)
  })

  it('answers a docroot of another user with a conflict and keeps a volume it did not create', async () => {
    const fake = daemon({
      answer: (call) =>
        call.argv.includes('init') ? { code: 3, stderr: 'refused: root_owner\n' } : undefined,
    })
    const runtime = runtimeOn(fake)
    await expect(runtime.ensure(spec(), secrets())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.volumes.has(`rpv-${previewId}-files`)).toBe(false)
    fake.volumes.set(`rpv-${previewId}-files`, {
      Name: `rpv-${previewId}-files`,
      Labels: { ...fake.byRole('lease')[0]!.options.Labels!, 'io.raditi.preview.role': 'files' },
    })
    await expect(runtime.ensure(spec(), secrets())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.volumes.has(`rpv-${previewId}-files`)).toBe(true)
    expect(fake.byRole('preview')).toHaveLength(0)
  })

  it('writes the passwords, the configuration and the settings init waits for, and secrets nowhere else', async () => {
    const fake = daemon()
    await runtimeOn(fake).ensure(spec(), secrets({ API_KEY: secretValue }))
    const writes = fake.execs.filter(
      (call) => call.role === 'preview' && call.argv[0] === '/bin/sh',
    )
    expect(writes.map((call) => [call.argv.at(-1), call.user])).toEqual([
      ['/run/raditi/db/user', '999:999'],
      ['/run/raditi/db/root', '999:999'],
      ['/run/raditi/preview/apache2.conf', '33:33'],
      [PREVIEW_SETTINGS_PATH, '33:33'],
    ])
    expect(writes[0]!.stdin.toString()).toBe(passwords.user)
    expect(writes[1]!.stdin.toString()).toBe(passwords.root)
    const settings = previewSettingsSchema.parse(JSON.parse(writes[3]!.stdin.toString()))
    expect(settings).toEqual({
      v: 2,
      hostname,
      origin: `http://${hostname}:8090`,
      productionOrigin: 'https://shop.example.ru',
      database: {
        engine: 'mysql',
        host: '127.0.0.1',
        port: 3306,
        name: 'preview',
        user: 'preview',
        password: passwords.user,
      },
      settings: { DEBUG: false },
      env: { API_KEY: secretValue },
    })
    // Never in a label, an argument or the environment of a container or a command.
    const visible = JSON.stringify([fake.created, fake.execs.map((call) => [call.argv, call.env])])
    expect(visible).not.toContain(secretValue)
    expect(JSON.stringify(fake.created)).not.toContain(passwords.user)
    expect(JSON.stringify(fake.created)).not.toContain(passwords.root)
    // The build waited for the database and the gateway, then for the server on the loopback.
    const checks = fake.execs.filter(
      (call) => call.role === 'preview' && call.argv[0] !== '/bin/sh',
    )
    expect(checks.map((call) => call.argv.slice(0, 3))).toEqual([
      ['test', '-f', DATABASE_READY_FILE],
      ['test', '-f', FORWARD_READY_FILE],
      ['/usr/local/bin/node', '-e', expect.stringContaining('"127.0.0.1"')],
    ])
    expect(checks.at(-1)!.argv.at(-1)).toBe('8081')
  })

  it('refuses a database made with other passwords, and a build without them', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    const other = { env: {}, database: { user: 'x'.repeat(32), root: 'y'.repeat(32) } }
    await expect(runtime.ensure(spec(), other)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.ensure(spec(), { env: {}, database: null })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('runs a preview without a database: no volume, no passwords, init told so', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    await runtime.ensure(spec({ database: false }), { env: {}, database: null })
    const preview = fake.one('preview')
    expect(preview.options.Env).toContain('RADITI_DATABASE=0')
    expect(preview.options.HostConfig!.Mounts).toHaveLength(1)
    expect(fake.volumes.has(`rpv-${previewId}-db`)).toBe(false)
    const settings = JSON.parse(preview.files.get(PREVIEW_SETTINGS_PATH)!.toString()) as {
      database: unknown
    }
    expect(settings.database).toBeNull()
  })

  it('is idempotent and moves the deadline only forward, with a new lease', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    const first = await runtime.ensure(spec(), secrets())
    // Only the helpers come again: the docroot's and the host rules'.
    const lasting = () =>
      fake.created.filter(
        (item) =>
          !['files-helper', 'firewall'].includes(item.Labels?.['io.raditi.preview.role'] ?? ''),
      ).length
    const before = lasting()
    expect(await runtime.ensure(spec(), secrets())).toEqual(first)
    expect(lasting()).toBe(before)
    await runtime.ensure(spec({ expiresAt: 1_900_000_000_000 - 1 }), secrets())
    expect(lasting()).toBe(before)
    await runtime.ensure(spec({ expiresAt: 1_900_000_100_000 }), secrets())
    const leases = fake.byRole('lease')
    expect(leases.map((item) => item.options.Labels!['io.raditi.preview.deadline'])).toEqual([
      label(1_900_000_100_000),
    ])
    expect(leases[0]!.running).toBe(false)
    expect(lasting()).toBe(before + 1)
  })

  it('extends a preview without a build, its image and identity from the lease', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await expect(runtime.extend(previewId, 1_900_000_000_000)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await runtime.ensure(spec(), secrets())
    const before = fake.created.length
    const writes = fake.execs.filter((call) => call.argv[0] === '/bin/sh').length
    await runtime.extend(previewId, 1_900_000_000_000 - 1)
    expect(fake.created.length).toBe(before)
    await runtime.extend(previewId, 1_900_000_200_000)
    const [lease] = fake.byRole('lease')
    expect(lease!.options).toMatchObject({
      Image: image('tools'),
      Labels: {
        'io.raditi.preview.site': spec().siteId,
        'io.raditi.preview.task': spec().taskId,
        'io.raditi.preview.deadline': label(1_900_000_200_000),
      },
    })
    expect(
      fake.created.slice(before).map((item) => item.Labels?.['io.raditi.preview.role']),
    ).toEqual(['lease'])
    expect(fake.execs.filter((call) => call.argv[0] === '/bin/sh')).toHaveLength(writes)
    for (const value of [Date.now() - 1, 1.5, Number.MAX_SAFE_INTEGER])
      await expect(runtime.extend(previewId, value)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(runtime.extend('../etc', 1_900_000_300_000)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('replaces the container when its desired state changed, and writes its passwords again', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    const first = fake.one('preview')
    await runtime.ensure(
      spec({ images: { ...spec().images, preview: image('site84') } }),
      secrets(),
    )
    const second = fake.one('preview')
    expect(second.id).not.toBe(first.id)
    expect(second.options.Image).toBe(image('site84'))
    expect(second.files.get('/run/raditi/db/user')!.toString()).toBe(passwords.user)
    // The server reads its configuration at start: a new one is a new container.
    const recipe = spec().recipe
    await runtime.ensure(
      spec({
        recipe: {
          ...recipe,
          web: { ...recipe.web, configFiles: [{ name: 'apache2.conf', content: 'Listen 8082' }] },
        },
      }),
      secrets(),
    )
    expect(fake.one('preview').id).not.toBe(second.id)
    expect(fake.one('preview').files.get('/run/raditi/preview/apache2.conf')!.toString()).toBe(
      'Listen 8082',
    )
  })

  it('builds anew a preview of protocol 1: its containers, bridge and volumes go first', async () => {
    const fake = daemon()
    const old = (role: string) => ({
      'io.raditi.preview.owner': 'raditi',
      'io.raditi.preview.protocol': '1',
      'io.raditi.preview.id': previewId,
      'io.raditi.preview.site': spec().siteId,
      'io.raditi.preview.task': spec().taskId,
      'io.raditi.preview.deadline': label(1_900_000_000_000),
      'io.raditi.preview.role': role,
    })
    const client = fake.client as unknown as {
      createNetwork: (request: Docker.NetworkCreateOptions) => Promise<unknown>
      createContainer: (request: Docker.ContainerCreateOptions) => Promise<unknown>
      createVolume: (request: { Name: string; Labels: Record<string, string> }) => Promise<unknown>
    }
    await client.createNetwork({
      Name: `raditi-preview-${previewId}`,
      Driver: 'bridge',
      Internal: true,
      EnableIPv6: false,
      Labels: old('network'),
      Options: {
        'com.docker.network.bridge.name': previewBridge(previewId),
        'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
        'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
      },
    })
    for (const role of ['web', 'db', 'forwarder'])
      await client.createContainer({
        name: `raditi-preview-${previewId}-${role}`,
        Image: image(role),
        Labels: old(role),
      })
    await client.createVolume({ Name: `rpv-${previewId}-db`, Labels: old('database') })
    await client.createVolume({ Name: `rpv-${previewId}-files`, Labels: old('files') })

    // What it holds is no preview here: the caller writes the whole tree after the build.
    expect(await runtimeOn(fake).inspect(previewId)).toBeNull()
    const upstream = await runtimeOn(fake).ensure(spec(), secrets())
    expect(upstream.port).toBeGreaterThan(0)
    for (const role of ['web', 'db', 'forwarder']) expect(fake.byRole(role)).toEqual([])
    expect(fake.one('preview').options.Labels!['io.raditi.preview.protocol']).toBe('2')
    const [network] = [...fake.networks.values()]
    expect(network).toMatchObject({ Internal: false })
    expect(network!.Labels['io.raditi.preview.protocol']).toBe('2')
    for (const name of [`rpv-${previewId}-db`, `rpv-${previewId}-files`])
      expect(fake.volumes.get(name)!.Labels['io.raditi.preview.protocol']).toBe('2')
    // The old preview served nothing this runtime knows.
    expect(fake.events.indexOf('remove:web')).toBeLessThan(fake.events.indexOf('create:preview'))
  })

  it('refuses what it cannot run safely', async () => {
    const wrongRuntime = daemon()
    await expect(
      runtimeOn(wrongRuntime).ensure(spec({ runtime: 'runsc' }), secrets()),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      runtimeOn(daemon()).ensure({ ...spec(), hostname: 'x' }, secrets()),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      runtimeOn(daemon()).ensure(spec(), secrets({ PATH: '/tmp' })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // Past its deadline the watchdog would take it at once.
    const expired = daemon()
    await expect(
      runtimeOn(expired).ensure(spec({ expiresAt: Date.now() - 1 }), secrets()),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(expired.created).toHaveLength(0)
    // An image that declares a volume the runtime does not mount would leave an anonymous one.
    const volume = daemon({ images: { [image('site')]: { Config: { Volumes: { '/data': {} } } } } })
    await expect(runtimeOn(volume).ensure(spec(), secrets())).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(volume.created).toHaveLength(0)
    // The image's database is MariaDB: another engine is refused before anything is created.
    const postgres = daemon()
    await expect(
      runtimeOn(postgres).ensure(
        spec({ recipe: { ...spec().recipe, database: 'postgres' } }),
        secrets(),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(postgres.created).toHaveLength(0)
    const runsc = daemon({
      runtimes: { runsc: { path: '/usr/bin/runsc', runtimeArgs: ['--net-raw'] } },
    })
    await expect(
      runtimeOn(runsc, { runtime: 'runsc' }).ensure(spec({ runtime: 'runsc' }), secrets()),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
  })

  it('never builds on an internal bridge or one of the wrong shape, and leaves none behind', async () => {
    const fake = daemon()
    const client = fake.client as unknown as {
      createNetwork: (request: Docker.NetworkCreateOptions) => Promise<unknown>
    }
    const create = client.createNetwork
    client.createNetwork = (request) => create({ ...request, Options: {} })
    await expect(runtimeOn(fake).ensure(spec(), secrets())).rejects.toThrow()
    expect(fake.networks.size).toBe(0)
    expect(fake.byRole('preview')).toHaveLength(0)
  })

  it('does not take over a preview of another site, nor a database whose container is gone', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    await expect(
      runtime.ensure(spec({ siteId: '0196abcd-0000-7000-8000-0000000000ff' }), secrets()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    fake.containers.delete(fake.one('preview').id)
    await expect(runtime.ensure(spec(), secrets())).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('under runsc runs the preview and its helpers in gVisor, with room for the sandbox kernel', async () => {
    const fake = daemon({ runtimes: { runsc: { path: '/usr/bin/runsc', runtimeArgs: [] } } })
    const runtime = runtimeOn(fake, { runtime: 'runsc' })
    await runtime.ensure(
      spec({ runtime: 'runsc', limits: { cpu: 2, memoryMiB: 2048, pids: 64 } }),
      secrets(),
    )
    const of = (role: string) =>
      fake.created.find((item) => item.Labels?.['io.raditi.preview.role'] === role)!.HostConfig!
    expect(of('preview')).toMatchObject({ Runtime: 'runsc', PidsLimit: 128 })
    expect(of('files-helper')).toMatchObject({ Runtime: 'runsc', PidsLimit: 128 })
    // The host rules' helper runs in the host's network namespace, never in gVisor.
    expect(of('firewall').Runtime).toBe('runc')
    const runc = daemon()
    await runtimeOn(runc).ensure(spec({ limits: { cpu: 2, memoryMiB: 2048, pids: 64 } }), secrets())
    expect(runc.one('preview').options.HostConfig!.PidsLimit).toBe(64)
  })
})

describe('Docker preview runtime: files, database, commands', () => {
  it('writes files through a helper with the docroot alone and reports a refusal by its reason', async () => {
    const fake = daemon({
      answer: (call) =>
        call.argv.includes('write') && call.stdin.includes(Buffer.from('bad'))
          ? { code: 3, stderr: 'refused: path_conflict\n' }
          : undefined,
    })
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    await runtime.writeFiles(previewId, { archive: archive(), deletes: ['old.php'], replace: true })
    const write = fake.execs.find((call) => call.argv.includes('write'))!
    expect(write.user).toBe('33:33')
    const length = write.stdin.readUInt32BE(0)
    expect(JSON.parse(write.stdin.subarray(4, 4 + length).toString())).toEqual({
      replace: true,
      deletes: ['old.php'],
    })
    expect(write.stdin.subarray(4 + length).toString()).toBe('tar bytes')
    const helper = fake.created
      .filter((item) => item.Labels?.['io.raditi.preview.role'] === 'files-helper')
      .at(-1)!
    expect(helper).toMatchObject({
      Image: image('tools'),
      User: '33:33',
      HostConfig: { NetworkMode: 'none', Runtime: 'runc' },
    })
    expect(helper.HostConfig?.CapAdd).toBeUndefined()
    expect(fake.byRole('files-helper')).toHaveLength(0)
    await expect(
      runtime.writeFiles(previewId, {
        archive: (async function* () {
          yield Buffer.from('bad')
        })(),
        deletes: [],
        replace: false,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('path_conflict'),
    })
    expect(fake.byRole('files-helper')).toHaveLength(0)
  })

  it('loads a seed as data only, inside the preview, the password in the command’s environment alone', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    await runtime.loadDatabase(previewId, archive(), passwords)
    const [drop, load] = fake.execs
      .filter((call) => call.role === 'preview' && call.argv[0] === 'mariadb')
      .slice(-2)
    expect(drop!.argv.at(-1)).toBe(
      '--execute=DROP DATABASE IF EXISTS `preview`; CREATE DATABASE `preview`',
    )
    expect(load!.argv).toEqual(
      expect.arrayContaining([
        '--host=127.0.0.1',
        '--binary-mode',
        '--sandbox',
        '--local-infile=0',
        '--database=preview',
      ]),
    )
    expect(load!.user).toBe('999:999')
    expect(load!.stdin.toString()).toBe('tar bytes')
    expect(load!.env).toEqual([`MYSQL_PWD=${passwords.user}`])
    expect(load!.argv.join(' ')).not.toContain(passwords.user)
    await expect(
      runtime.loadDatabase(previewId, archive(), { user: 'short', root: passwords.root }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // A preview without a database has none to load.
    await runtime.ensure(spec({ database: false }), { env: {}, database: null })
    await expect(runtime.loadDatabase(previewId, archive(), passwords)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('runs a command inside the preview as its PHP user, in a session run-as.sh ends', async () => {
    const fake = daemon({
      answer: (call) =>
        call.argv[4] === 'wp' ? { code: 2, stdout: 'out', stderr: 'err' } : undefined,
    })
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets({ API_KEY: secretValue }))
    const created = fake.created.length
    const result = await runtime.exec(previewId, {
      argv: ['wp', 'option', 'get', 'home'],
      timeoutMs: 5_000,
    })
    expect(Buffer.from(result.stdout).toString()).toBe('out')
    expect(Buffer.from(result.stderr).toString()).toBe('err')
    expect(result.code).toBe(2)
    const call = fake.execs.at(-1)!
    expect(call).toMatchObject({
      role: 'preview',
      user: '0:0',
      argv: ['/usr/local/lib/raditi/run-as.sh', '33:33', '5', '--', 'wp', 'option', 'get', 'home'],
      env: ['HOME=/nonexistent'],
    })
    // No container of its own: the command runs where the settings and the database are.
    expect(fake.created.length).toBe(created)
    expect(JSON.stringify(call)).not.toContain(secretValue)
    await expect(runtime.exec(previewId, { argv: [], timeoutMs: 5_000 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await runtime.stop(previewId)
    await expect(
      runtime.exec(previewId, { argv: ['wp', 'option', 'get', 'home'], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('fails a command whose output is over its limit', async () => {
    const fake = daemon({
      answer: (call) =>
        call.argv[4] === 'wp' ? { code: 0, stdout: 'x'.repeat(16 * 1024 * 1024 + 1) } : undefined,
    })
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    await expect(
      runtime.exec(previewId, { argv: ['wp', 'db', 'export', '-'], timeoutMs: 5_000 }),
    ).rejects.toThrow()
  })
})

describe('Docker preview runtime: browser and lifecycle', () => {
  it('starts the browser on its own network behind a relay, its control port on loopback only', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    const endpoint = await runtime.startBrowser(previewId, { image: image('browser'), hostname })
    const network = [...fake.networks.values()].find((item) => item.Name.endsWith('-browser'))!
    expect(network).toMatchObject({
      Internal: true,
      Options: { 'com.docker.network.bridge.name': browserBridge(previewId) },
    })
    const relay = fake.one('relay')
    expect(relay.options).toMatchObject({
      Image: image('tools'),
      Cmd: ['172.24.0.2:3128=host.docker.internal:8090', '0.0.0.0:9333=172.24.0.3:9333'],
      HostConfig: {
        NetworkMode: 'bridge',
        ExtraHosts: ['host.docker.internal:host-gateway'],
        PortBindings: { '9333/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
      },
    })
    const browser = fake.one('browser')
    expect(browser.options).toMatchObject({
      Image: image('browser'),
      Cmd: ['--host=172.24.0.3', '--port=9333', '--proxy=http://172.24.0.2:3128'],
      HostConfig: {
        Runtime: 'runc',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        NetworkMode: network.Id,
      },
    })
    expect(browser.options.HostConfig?.PortBindings).toBeUndefined()
    expect(browser.options.HostConfig?.ExtraHosts).toBeUndefined()
    expect(Object.keys(browser.networks)).toEqual([network.Name])
    const secret = browser.files.get(BROWSER_SECRET_FILE)!.toString()
    expect(secret).toMatch(/^\/[A-Za-z0-9_-]{43}$/)
    expect(endpoint.wsEndpoint).toBe(
      `ws://127.0.0.1:${relay.ports['9333/tcp']![0]!.HostPort}${secret}`,
    )
    expect(JSON.stringify(fake.created)).not.toContain(secret)
    expect(await runtime.startBrowser(previewId, { image: image('browser'), hostname })).toEqual(
      endpoint,
    )
    expect(fake.byRole('browser')).toHaveLength(1)

    await runtime.stopBrowser(previewId)
    expect(fake.byRole('browser')).toHaveLength(0)
    expect(fake.byRole('relay')).toHaveLength(0)
    expect([...fake.networks.values()].some((item) => item.Name.endsWith('-browser'))).toBe(false)
  })

  it('sends the browser to a gateway named by address when host-gateway is another machine', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake, { gatewayHost: '172.17.0.1' })
    await runtime.ensure(spec(), secrets())
    await runtime.startBrowser(previewId, { image: image('browser'), hostname })
    const relay = fake.one('relay').options
    expect(relay.Cmd![0]).toBe('172.24.0.2:3128=172.17.0.1:8090')
    expect(relay.HostConfig?.ExtraHosts).toBeUndefined()
    expect(() =>
      createDockerPreviewRuntime({
        runtime: 'runc',
        gatewayPort: 8090,
        gatewayHost: 'gw.local',
        firewallImage: image('guard'),
        dnsServers: ['77.88.8.8'],
      }),
    ).toThrow()
  })

  it('stops, inspects, lists and destroys: containers, then networks and rules, then volumes', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    expect(await runtime.inspect(previewId)).toBeNull()
    const upstream = await runtime.ensure(spec(), secrets())
    expect(await runtime.inspect(previewId)).toEqual({
      previewId,
      runtime: 'runc',
      running: true,
      upstream,
    })
    expect(await runtime.list()).toEqual([previewId])
    await runtime.stop(previewId)
    expect(await runtime.inspect(previewId)).toMatchObject({ running: false, upstream: null })
    expect(fake.volumes.size).toBe(2)
    fake.events.length = 0
    await runtime.destroy(previewId)
    // The helper of the host rules comes and goes after the bridge, to sweep its rules.
    const kinds = fake.events
      .filter((event) => !event.endsWith(':firewall'))
      .map((event) => event.split(':')[0])
    expect(kinds.lastIndexOf('remove')).toBeLessThan(kinds.indexOf('network'))
    expect(kinds.lastIndexOf('network')).toBeLessThan(kinds.indexOf('volume'))
    // The rules of the bridge that is gone are swept.
    expect(firewallCalls(fake).at(-1)).toEqual(['sweep'])
    expect(fake.containers.size + fake.networks.size + fake.volumes.size).toBe(0)
    expect(await runtime.list()).toEqual([])
    await runtime.destroy(previewId)
  })

  it('answers a missing preview with a conflict, a malformed id with a bad request', async () => {
    const runtime = runtimeOn(daemon())
    await expect(
      runtime.writeFiles(previewId, { archive: archive(), deletes: [], replace: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.loadDatabase(previewId, archive(), passwords)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      runtime.startBrowser(previewId, { image: image('browser'), hostname }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      runtime.exec(previewId, { argv: ['wp', 'option', 'get', 'home'], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.stop('../etc')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('Docker preview runtime: the platform files of the stack (R5b, R5c)', () => {
  const platform = [{ path: 'wp-config.php', content: '<?php // platform' }]

  it('gives them back before a whole tree replaces the docroot and writes them after it', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    await runtime.writeFiles(previewId, {
      archive: archive(),
      deletes: [],
      replace: true,
      platform,
    })
    const steps = fake.execs
      .filter((call) => call.role === 'files-helper' && !call.argv.includes('init'))
      .map((call) => [
        call.argv.find((arg) => ['release', 'write', 'platform'].includes(arg)),
        call.user,
      ])
    expect(steps).toEqual([
      ['release', '0:0'],
      ['write', '33:33'],
      ['platform', '0:0'],
    ])
    const written = fake.execs.find((call) => call.argv.includes('platform'))!
    expect(written.argv.at(-1)).toBe('33:33')
    const length = written.stdin.readUInt32BE(0)
    expect(JSON.parse(written.stdin.subarray(4, 4 + length).toString())).toEqual({
      files: platform,
    })
    const helpers = fake.created.filter(
      (item) => item.Labels?.['io.raditi.preview.role'] === 'files-helper' && item.User === '0:0',
    )
    for (const helper of helpers) expect(helper.HostConfig?.CapAdd).toEqual(['CHOWN'])
  })

  it('leaves them alone over a difference and refuses files of another shape', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), secrets())
    await runtime.writeFiles(previewId, { archive: archive(), deletes: [], replace: false })
    expect(fake.execs.some((call) => call.argv.includes('release'))).toBe(false)
    expect(fake.execs.some((call) => call.argv.includes('platform'))).toBe(false)
    await expect(
      runtime.writeFiles(previewId, {
        archive: archive(),
        deletes: [],
        replace: false,
        platform: [{ path: '../wp-config.php', content: '' }],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
