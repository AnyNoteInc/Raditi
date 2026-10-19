import { Buffer } from 'node:buffer'
import { Duplex } from 'node:stream'

import { PREVIEW_SETTINGS_PATH, previewSettingsSchema, type PreviewRuntimeSpec } from '@repo/domain'
import type Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import { previewRuntimeLimits } from './config.ts'
import { BROWSER_READY_FILE, BROWSER_SECRET_FILE, FORWARD_READY_FILE } from './containers.ts'
import { browserBridge, previewBridge } from './resources.ts'
import { createDockerPreviewRuntime } from './runtime.ts'

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
    images: {
      web: image('php'),
      db: image('mariadb'),
      cli: image('cli'),
      forwarder: image('tools'),
      egress: image('egress'),
    },
    recipe: {
      runtime: 'php',
      runtimeVersions: ['8.3'],
      database: 'mysql',
      requiredPaths: [],
      generatedFiles: [],
      settings: { DEBUG: false },
      healthPath: '/',
      web: {
        command: ['apache2', '-DFOREGROUND', '-f', '/run/raditi/preview/httpd.conf'],
        env: { APACHE_LOG_DIR: '/var/log/apache2' },
        port: 8080,
        user: '33:33',
        docroot: '/var/www/html',
        tmpfs: ['/run/apache2', '/tmp'],
        configFiles: [{ name: 'httpd.conf', content: 'Listen 8080' }],
      },
    },
    limits: { cpu: 1, memoryMiB: 1024, pids: 256 },
    egress: ['api.example.ru:443'],
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
      if ([container.options.Entrypoint ?? []].flat().some((part) => part.endsWith('forward.mjs')))
        container.files.set(FORWARD_READY_FILE, Buffer.from('ready'))
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
        if (ref.includes('/php@') || ref.includes('/cli@'))
          return { Config: { Volumes: { '/var/www/html': {} } } }
        if (ref.includes('/mariadb@')) return { Config: { Volumes: { '/var/lib/mysql': {} } } }
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
    { runtime: 'runc', gatewayPort: 8090, ...patch },
    { client: fake.client },
  )

async function* archive() {
  yield Buffer.from('tar bytes')
}

describe('Docker preview runtime: ensure', () => {
  it('builds the preview on a hostless network, hardened, and returns the entry port', async () => {
    const fake = daemon()
    const upstream = await runtimeOn(fake).ensure(spec(), { env: { API_KEY: secretValue } })

    const [network] = [...fake.networks.values()]
    expect(network).toMatchObject({
      Name: `raditi-preview-${previewId}`,
      Internal: true,
      EnableIPv6: false,
      Options: {
        'com.docker.network.bridge.name': previewBridge(previewId),
        'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
        'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
      },
    })
    const web = fake.one('web')
    expect(web.options).toMatchObject({
      Image: image('php'),
      User: '33:33',
      Entrypoint: ['/bin/sh', '-c', expect.stringContaining('exec "$@"'), 'raditi-preview-web'],
      Cmd: ['apache2', '-DFOREGROUND', '-f', '/run/raditi/preview/httpd.conf'],
      Env: ['APACHE_LOG_DIR=/var/log/apache2'],
    })
    for (const role of ['web', 'db', 'files-helper'])
      for (const options of fake.created.filter(
        (item) => item.Labels?.['io.raditi.preview.role'] === role,
      ))
        expect(options.HostConfig).toMatchObject({
          Runtime: 'runc',
          ReadonlyRootfs: true,
          Privileged: false,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          RestartPolicy: { Name: 'no' },
        })
    expect(web.options.HostConfig).toMatchObject({
      NetworkMode: network!.Id,
      NanoCpus: 1e9,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      PidsLimit: 256,
      ExtraHosts: ['db:172.23.0.3', 'egress:172.23.0.5'],
      Mounts: [
        {
          Type: 'volume',
          Source: `rpv-${previewId}-files`,
          Target: '/var/www/html',
          VolumeOptions: { NoCopy: true },
        },
      ],
    })
    expect(Object.keys(web.options.HostConfig!.Tmpfs!).sort()).toEqual([
      '/run/apache2',
      '/run/raditi/preview',
      '/tmp',
    ])
    expect(web.networks[network!.Name]!.IPAddress).toBe('172.23.0.2')
    for (const item of [web, fake.one('db')]) {
      expect(item.options.HostConfig?.Binds).toBeUndefined()
      expect(item.options.HostConfig?.PortBindings).toBeUndefined()
      expect(Object.keys(item.networks)).toEqual([network!.Name])
    }

    // Only the entry forwarder publishes, on PREVIEW_UPSTREAM_HOST, to the PHP container.
    const forwarder = fake.one('forwarder')
    expect(forwarder.options).toMatchObject({
      User: '10001:10001',
      // Its port outlives it in the callers' rows: any other host than its own is refused.
      Cmd: [`--http-host=${hostname}`, '0.0.0.0:8080=172.23.0.2:8080'],
      HostConfig: {
        NetworkMode: 'bridge',
        PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
        Sysctls: { 'net.ipv4.ip_forward': '0' },
      },
    })
    expect(forwarder.networks[network!.Name]!.IPAddress).toBe('172.23.0.4')
    expect(upstream).toEqual({
      host: '127.0.0.1',
      port: Number(forwarder.ports['8080/tcp']![0]!.HostPort),
    })

    const egress = fake.one('egress')
    expect(egress.options.Env).toEqual([
      'LISTEN_HOST=172.23.0.5',
      'LISTEN_PORT=3128',
      'ALLOWED_HOSTS=["api.example.ru:443"]',
    ])
    expect(egress.options.Entrypoint).toBeUndefined()
    expect(Object.keys(egress.networks).sort()).toEqual([network!.Name, 'bridge'].sort())

    expect([...fake.volumes.keys()].sort()).toEqual([
      `rpv-${previewId}-db`,
      `rpv-${previewId}-files`,
    ])
    // Every resource carries the identity and the deadline the watchdog reads.
    for (const item of fake.containers.values())
      expect(item.options.Labels).toMatchObject({
        'io.raditi.preview.owner': 'raditi',
        'io.raditi.preview.id': previewId,
        'io.raditi.preview.deadline': label(1_900_000_000_000),
      })
  })

  it('gives the docroot to the PHP user from a helper with that volume alone, on every build', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
    const init = fake.created.find(
      (item) => item.Labels?.['io.raditi.preview.role'] === 'files-helper',
    )!
    expect(init).toMatchObject({
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
    // The helper leaves a docroot of the PHP user as it is: asking again costs one helper.
    await runtime.ensure(spec(), { env: {} })
    expect(
      fake.execs.filter((call) => call.role === 'files-helper' && call.argv.includes('init')),
    ).toHaveLength(2)
    expect(fake.byRole('files-helper')).toHaveLength(0)
  })

  it('prepares a docroot left by a build that died before preparing it', async () => {
    const fake = daemon()
    // A build created the volume and was killed before its helper ran.
    fake.volumes.set(`rpv-${previewId}-files`, {
      Name: `rpv-${previewId}-files`,
      Labels: {
        'io.raditi.preview.owner': 'raditi',
        'io.raditi.preview.protocol': '1',
        'io.raditi.preview.id': previewId,
        'io.raditi.preview.site': spec().siteId,
        'io.raditi.preview.task': spec().taskId,
        'io.raditi.preview.deadline': label(1_900_000_000_000),
        'io.raditi.preview.role': 'files',
      },
    })
    await runtimeOn(fake).ensure(spec(), { env: {} })
    expect(
      fake.execs.find((call) => call.role === 'files-helper' && call.argv.includes('init'))?.user,
    ).toBe('0:0')
    expect(fake.events).not.toContain('volume:create:files')
  })

  it('answers a docroot of another user with a conflict and keeps a volume it did not create', async () => {
    const fake = daemon({
      answer: (call) =>
        call.argv.includes('init') ? { code: 3, stderr: 'refused: root_owner\n' } : undefined,
    })
    const runtime = runtimeOn(fake)
    await expect(runtime.ensure(spec(), { env: {} })).rejects.toMatchObject({ code: 'CONFLICT' })
    // Created by that call and never prepared: removed, so the next call starts over.
    expect(fake.volumes.has(`rpv-${previewId}-files`)).toBe(false)
    fake.volumes.set(`rpv-${previewId}-files`, {
      Name: `rpv-${previewId}-files`,
      Labels: { ...fake.byRole('lease')[0]!.options.Labels!, 'io.raditi.preview.role': 'files' },
    })
    await expect(runtime.ensure(spec(), { env: {} })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.volumes.has(`rpv-${previewId}-files`)).toBe(true)
    expect(fake.byRole('web')).toHaveLength(0)
  })

  it('writes the configuration, then the settings the server waits for, and keeps secrets there only', async () => {
    const fake = daemon()
    await runtimeOn(fake).ensure(spec(), { env: { API_KEY: secretValue } })
    const writes = fake.execs.filter((call) => call.role === 'web' && call.argv[0] === '/bin/sh')
    expect(writes.map((call) => call.argv.at(-1))).toEqual([
      '/run/raditi/preview/httpd.conf',
      PREVIEW_SETTINGS_PATH,
    ])
    expect(writes.every((call) => call.user === '33:33')).toBe(true)
    const settings = previewSettingsSchema.parse(JSON.parse(writes[1]!.stdin.toString()))
    const password = fake
      .one('db')
      .options.Env!.find((entry) => entry.startsWith('MARIADB_PASSWORD='))!
    expect(settings).toMatchObject({
      hostname,
      productionOrigin: 'https://shop.example.ru',
      database: { engine: 'mysql', host: 'db', port: 3306, name: 'preview', user: 'preview' },
      egress: { proxy: { host: 'egress', port: 3128 }, hosts: ['api.example.ru:443'] },
      settings: { DEBUG: false },
      env: { API_KEY: secretValue },
    })
    expect(`MARIADB_PASSWORD=${settings.database!.password}`).toBe(password)
    // Never in a label, an argument or the environment of a container or a command.
    const visible = JSON.stringify([fake.created, fake.execs.map((call) => [call.argv, call.env])])
    expect(visible).not.toContain(secretValue)
    expect(JSON.stringify(fake.created.map((item) => item.Labels))).not.toContain(
      settings.database!.password,
    )
  })

  it('is idempotent and moves the deadline only forward, with a new lease', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    const first = await runtime.ensure(spec(), { env: {} })
    // Only the helper that prepares the docroot comes again.
    const lasting = () =>
      fake.created.filter((item) => item.Labels?.['io.raditi.preview.role'] !== 'files-helper')
        .length
    const before = lasting()
    expect(await runtime.ensure(spec(), { env: {} })).toEqual(first)
    expect(lasting()).toBe(before)
    await runtime.ensure(spec({ expiresAt: 1_900_000_000_000 - 1 }), { env: {} })
    expect(lasting()).toBe(before)
    await runtime.ensure(spec({ expiresAt: 1_900_000_100_000 }), { env: {} })
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
    await runtime.ensure(spec(), { env: {} })
    const before = fake.created.length
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
    expect(fake.execs.filter((call) => call.argv[0] === '/bin/sh')).toHaveLength(2)
    for (const value of [Date.now() - 1, 1.5, Number.MAX_SAFE_INTEGER])
      await expect(runtime.extend(previewId, value)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(runtime.extend('../etc', 1_900_000_300_000)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('replaces only the container whose desired state changed, keeping the database passwords', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
    const db = fake.one('db')
    const password = db.options.Env!.find((entry) => entry.startsWith('MARIADB_PASSWORD='))
    await runtime.ensure(spec({ images: { ...spec().images, web: image('php84') } }), { env: {} })
    expect(fake.one('web').options.Image).toBe(image('php84'))
    expect(fake.one('db').id).toBe(db.id)
    await runtime.ensure(spec({ images: { ...spec().images, db: image('mariadb2') } }), { env: {} })
    expect(fake.one('db').id).not.toBe(db.id)
    expect(fake.one('db').options.Env).toContain(password)
    await runtime.ensure(spec({ egress: ['other.example.ru:443'] }), { env: {} })
    expect(fake.one('egress').options.Env).toContain('ALLOWED_HOSTS=["other.example.ru:443"]')
    // The server reads its configuration at start: a new one is a new web container.
    const web = fake.one('web')
    const recipe = spec().recipe
    await runtime.ensure(
      spec({
        recipe: {
          ...recipe,
          web: { ...recipe.web, configFiles: [{ name: 'httpd.conf', content: 'Listen 8081' }] },
        },
      }),
      { env: {} },
    )
    expect(fake.one('web').id).not.toBe(web.id)
    expect(fake.one('web').files.get('/run/raditi/preview/httpd.conf')!.toString()).toBe(
      'Listen 8081',
    )
  })

  it('tells the egress proxy the platform subnets it never connects to (Р13)', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake, { egressRefusedSubnets: ['84.201.128.0/18', '2a02:6b8::/32'] })
    await runtime.ensure(spec(), { env: {} })
    expect(fake.one('egress').options.Env).toEqual([
      'LISTEN_HOST=172.23.0.5',
      'LISTEN_PORT=3128',
      'ALLOWED_HOSTS=["api.example.ru:443"]',
      'REFUSED_SUBNETS=84.201.128.0/18,2a02:6b8::/32',
    ])
    expect(() => runtimeOn(daemon(), { egressRefusedSubnets: ['84.201.128.0'] })).toThrow()
  })

  it('drops the database and the egress proxy of a preview that no longer has them', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
    await runtime.ensure(spec({ images: { ...spec().images, db: null, egress: null } }), {
      env: {},
    })
    expect(fake.byRole('db')).toHaveLength(0)
    expect(fake.byRole('egress')).toHaveLength(0)
    expect(fake.volumes.has(`rpv-${previewId}-db`)).toBe(false)
    const settings = JSON.parse(fake.one('web').files.get(PREVIEW_SETTINGS_PATH)!.toString()) as {
      database: unknown
      egress: unknown
    }
    expect(settings).toMatchObject({ database: null, egress: null })
  })

  it('refuses what it cannot run safely', async () => {
    const wrongRuntime = daemon()
    await expect(
      runtimeOn(wrongRuntime).ensure(spec({ runtime: 'runsc' }), { env: {} }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      runtimeOn(daemon()).ensure({ ...spec(), hostname: 'x' }, { env: {} }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      runtimeOn(daemon()).ensure(spec(), { env: { PATH: '/tmp' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // Past its deadline the watchdog would take it at once.
    const expired = daemon()
    await expect(
      runtimeOn(expired).ensure(spec({ expiresAt: Date.now() - 1 }), { env: {} }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(expired.created).toHaveLength(0)
    const volume = daemon({ images: { [image('php')]: { Config: { Volumes: { '/data': {} } } } } })
    await expect(runtimeOn(volume).ensure(spec(), { env: {} })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(volume.created).toHaveLength(0)
    // PREVIEW_DB_IMAGE is MariaDB: another engine is refused before anything is created.
    const postgres = daemon()
    await expect(
      runtimeOn(postgres).ensure(spec({ recipe: { ...spec().recipe, database: 'postgres' } }), {
        env: {},
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(postgres.created).toHaveLength(0)
    const runsc = daemon({
      runtimes: { runsc: { path: '/usr/bin/runsc', runtimeArgs: ['--net-raw'] } },
    })
    await expect(
      runtimeOn(runsc, { runtime: 'runsc', firewallImage: image('guard') }).ensure(
        spec({ runtime: 'runsc' }),
        {
          env: {},
        },
      ),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(() => createDockerPreviewRuntime({ runtime: 'runsc', gatewayPort: 8090 })).toThrow(
      /firewall/,
    )
  })

  it('never builds on a network with a host address, and leaves none behind', async () => {
    const fake = daemon({ hostedNetwork: true })
    await expect(runtimeOn(fake).ensure(spec(), { env: {} })).rejects.toThrow()
    expect(fake.networks.size).toBe(0)
    expect(fake.byRole('web')).toHaveLength(0)
  })

  it('does not take over a preview of another site, nor a database whose container is gone', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
    await expect(
      runtime.ensure(spec({ siteId: '0196abcd-0000-7000-8000-0000000000ff' }), { env: {} }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    fake.containers.delete(fake.one('db').id)
    await expect(runtime.ensure(spec(), { env: {} })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('under runsc guards each preview bridge on the host before anything runs on it', async () => {
    const fake = daemon({ runtimes: { runsc: { path: '/usr/bin/runsc', runtimeArgs: [] } } })
    const runtime = runtimeOn(fake, { runtime: 'runsc', firewallImage: image('guard') })
    await runtime.ensure(spec({ runtime: 'runsc' }), { env: {} })
    const firewall = fake.created.find(
      (item) => item.Labels?.['io.raditi.preview.role'] === 'firewall',
    )!
    expect(firewall).toMatchObject({
      Image: image('guard'),
      Cmd: ['install', previewBridge(previewId)],
      HostConfig: { Runtime: 'runc', NetworkMode: 'host', CapAdd: ['NET_ADMIN'], CapDrop: ['ALL'] },
    })
    const order = fake.events.filter((event) => event.startsWith('start:'))
    expect(order.indexOf('start:firewall')).toBeLessThan(order.indexOf('start:files-helper'))
    expect(order.indexOf('start:firewall')).toBeLessThan(order.indexOf('start:web'))
    expect(fake.one('web').options.HostConfig!.Runtime).toBe('runsc')
  })

  it('under runsc leaves room in the pids limit for the threads of the sandbox kernel', async () => {
    const fake = daemon({ runtimes: { runsc: { path: '/usr/bin/runsc', runtimeArgs: [] } } })
    const runtime = runtimeOn(fake, { runtime: 'runsc', firewallImage: image('guard') })
    await runtime.ensure(
      spec({ runtime: 'runsc', limits: { cpu: 1, memoryMiB: 1024, pids: 64 } }),
      {
        env: {},
      },
    )
    const pids = (role: string) =>
      fake.created.find((item) => item.Labels?.['io.raditi.preview.role'] === role)!.HostConfig!
        .PidsLimit
    expect(pids('files-helper')).toBe(128)
    expect(pids('web')).toBe(128)
    expect(pids('db')).toBe(128)
    // The platform's forwarders run on the daemon's default runtime, their own limit.
    expect(pids('forwarder')).toBe(64)
    const runc = daemon()
    await runtimeOn(runc).ensure(spec({ limits: { cpu: 1, memoryMiB: 1024, pids: 64 } }), {
      env: {},
    })
    expect(runc.one('web').options.HostConfig!.PidsLimit).toBe(64)
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
    await runtime.ensure(spec(), { env: {} })
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

  it('loads a seed as data only, the password in the environment of the command alone', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
    await runtime.loadDatabase(previewId, archive())
    const [drop, load] = fake.execs
      .filter((call) => call.role === 'db' && call.argv[0] === 'mariadb')
      .slice(-2)
    expect(drop!.argv.at(-1)).toBe(
      '--execute=DROP DATABASE IF EXISTS `preview`; CREATE DATABASE `preview`',
    )
    expect(load!.argv).toEqual(
      expect.arrayContaining([
        '--binary-mode',
        '--sandbox',
        '--local-infile=0',
        '--database=preview',
      ]),
    )
    expect(load!.stdin.toString()).toBe('tar bytes')
    const password = fake
      .one('db')
      .options.Env!.find((entry) => entry.startsWith('MARIADB_PASSWORD='))!
      .split('=')[1]!
    expect(load!.env).toEqual([`MYSQL_PWD=${password}`])
    expect(load!.argv.join(' ')).not.toContain(password)
  })

  it('runs a command in a CLI container shaped like the web one, and removes it after', async () => {
    const fake = daemon({
      answer: (call) =>
        call.argv[0] === 'wp' ? { code: 2, stdout: 'out', stderr: 'err' } : undefined,
    })
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: { API_KEY: secretValue } })
    const result = await runtime.exec(previewId, {
      argv: ['wp', 'option', 'get', 'home'],
      timeoutMs: 5_000,
    })
    expect(Buffer.from(result.stdout).toString()).toBe('out')
    expect(Buffer.from(result.stderr).toString()).toBe('err')
    expect(result.code).toBe(2)
    const cli = fake.created.find((item) => item.Labels?.['io.raditi.preview.role'] === 'cli')!
    const web = fake.one('web').options
    expect(cli).toMatchObject({
      Image: image('cli'),
      User: '33:33',
      HostConfig: {
        Runtime: 'runc',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        NetworkMode: web.HostConfig!.NetworkMode,
        ExtraHosts: web.HostConfig!.ExtraHosts,
        Mounts: [{ Source: `rpv-${previewId}-files`, Target: '/var/www/html' }],
      },
    })
    const settings = fake.execs.find((call) => call.role === 'cli' && call.argv[0] === '/bin/sh')!
    expect(settings.stdin.toString()).toContain(secretValue)
    expect(fake.byRole('cli')).toHaveLength(0)
    await expect(runtime.exec(previewId, { argv: [], timeoutMs: 5_000 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('fails a command whose output is over its limit, and still removes the container', async () => {
    const fake = daemon({
      answer: (call) =>
        call.argv[0] === 'wp' ? { code: 0, stdout: 'x'.repeat(16 * 1024 * 1024 + 1) } : undefined,
    })
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
    await expect(
      runtime.exec(previewId, { argv: ['wp', 'db', 'export', '-'], timeoutMs: 5_000 }),
    ).rejects.toThrow()
    expect(fake.byRole('cli')).toHaveLength(0)
  })
})

describe('Docker preview runtime: browser and lifecycle', () => {
  it('starts the browser on its own network behind a relay, its control port on loopback only', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
    const endpoint = await runtime.startBrowser(previewId, { image: image('browser'), hostname })
    const network = [...fake.networks.values()].find((item) => item.Name.endsWith('-browser'))!
    expect(network.Options).toMatchObject({
      'com.docker.network.bridge.name': browserBridge(previewId),
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
    // The secret is never a label, an argument or an environment value.
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
    await runtime.ensure(spec(), { env: {} })
    await runtime.startBrowser(previewId, { image: image('browser'), hostname })
    const relay = fake.one('relay').options
    expect(relay.Cmd![0]).toBe('172.24.0.2:3128=172.17.0.1:8090')
    expect(relay.HostConfig?.ExtraHosts).toBeUndefined()
    expect(() =>
      createDockerPreviewRuntime({ runtime: 'runc', gatewayPort: 8090, gatewayHost: 'gw.local' }),
    ).toThrow()
  })

  it('stops, inspects, lists and destroys: containers, then networks, then volumes', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    expect(await runtime.inspect(previewId)).toBeNull()
    const upstream = await runtime.ensure(spec(), { env: {} })
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
    const kinds = fake.events.map((event) => event.split(':')[0])
    expect(kinds.lastIndexOf('remove')).toBeLessThan(kinds.indexOf('network'))
    expect(kinds.lastIndexOf('network')).toBeLessThan(kinds.indexOf('volume'))
    expect(fake.containers.size + fake.networks.size + fake.volumes.size).toBe(0)
    expect(await runtime.list()).toEqual([])
    await runtime.destroy(previewId)
  })

  it('answers a missing preview with a conflict, a malformed id with a bad request', async () => {
    const runtime = runtimeOn(daemon())
    await expect(
      runtime.writeFiles(previewId, { archive: archive(), deletes: [], replace: true }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(runtime.loadDatabase(previewId, archive())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      runtime.startBrowser(previewId, { image: image('browser'), hostname }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(runtime.stop('../etc')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('Docker preview runtime: the platform files of the stack (R5b, R5c)', () => {
  const platform = [{ path: 'wp-config.php', content: '<?php // platform' }]

  it('gives them back before a whole tree replaces the docroot and writes them after it', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
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
    // The root step of the helper may change owners and nothing else.
    const helpers = fake.created.filter(
      (item) => item.Labels?.['io.raditi.preview.role'] === 'files-helper' && item.User === '0:0',
    )
    for (const helper of helpers) expect(helper.HostConfig?.CapAdd).toEqual(['CHOWN'])
  })

  it('leaves them alone over a difference and refuses files of another shape', async () => {
    const fake = daemon()
    const runtime = runtimeOn(fake)
    await runtime.ensure(spec(), { env: {} })
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
