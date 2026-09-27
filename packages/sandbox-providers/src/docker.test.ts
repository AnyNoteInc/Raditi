import { Buffer } from 'node:buffer'
import { Duplex } from 'node:stream'
import type * as Timers from 'node:timers/promises'

import {
  MAX_SANDBOX_RESOURCES,
  MAX_SANDBOX_TURN_MS,
  preparedRunLimits,
  SANDBOX_GID,
  SANDBOX_SECRETS_DIR,
  SANDBOX_SECRETS_TMPFS_BYTES,
  SANDBOX_UID,
  type ExecChunk,
  type SandboxSpec,
} from '@repo/domain'
import type Docker from 'dockerode'
import { describe, expect, it, vi } from 'vitest'

import { DockerFrames, HELPER, HELPER_ENV, NODE, startDetachedExec } from './docker-api.ts'
import { createDockerSandboxProvider, safeRunscArgs, safeRunscRuntime } from './docker.ts'

// Route the provider's sleeps through the global timer, so fake timers drive them too.
vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof Timers>()),
  setTimeout: (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)),
}))

const spec = (patch: Partial<SandboxSpec> = {}): SandboxSpec => ({
  image: `registry.local:3300/raditi/sbx-wordpress@sha256:${'0'.repeat(64)}`,
  labels: { workspaceId: 'w', siteId: 's', taskId: 't', sessionId: 'x', turn: 1, leaseEpoch: 4 },
  runtime: 'runc',
  resources: { ...MAX_SANDBOX_RESOURCES },
  user: { uid: SANDBOX_UID, gid: SANDBOX_GID },
  env: { LANG: 'C.UTF-8' },
  secrets: [],
  network: { mode: 'none' },
  hardTimeoutMs: MAX_SANDBOX_TURN_MS,
  ...patch,
})
const frame = (value: Uint8Array, stream = 1) => {
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(value.length, 4)
  return Buffer.concat([header, value])
}

function daemon() {
  const id = 'c'.repeat(64)
  let info: Docker.ContainerInspectInfo
  let serial = 0
  const commands: Docker.ExecCreateOptions[] = []
  const records = new Map<
    string,
    { stdout: Buffer; stderr: Buffer; exit: { code: number | null; reason: string } | null }
  >()
  const execs = new Map<
    string,
    { id: string; inspect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }
  >()
  const files = new Map<string, Buffer>()
  const remove = vi.fn(async () => {})
  const container = {
    id,
    remove,
    inspect: vi.fn(async () => structuredClone(info)),
    start: vi.fn(async () => {}),
    exec: vi.fn(async (options: Docker.ExecCreateOptions) => {
      commands.push(options)
      const args = options.Cmd!.slice(2)
      const execId = (++serial).toString(16).padStart(64, '0')
      const status = {
        Running: false,
        ExitCode: 0,
        ContainerID: id,
        ProcessConfig: { entrypoint: NODE, arguments: options.Cmd!.slice(1), privileged: false },
      }
      const exec = {
        id: execId,
        inspect: vi.fn(async () => ({ ...status })),
        start: vi.fn(async () => {
          if (args[0] === 'run') {
            records.set(args[1]!, {
              stdout: Buffer.from([0, 255, 65, 66]),
              stderr: Buffer.from('warn'),
              exit: { code: 0, reason: 'exited' },
            })
            return undefined
          }
          const chunks: Buffer[] = []
          const socket = new Duplex({
            allowHalfOpen: true,
            read() {},
            write(chunk, _encoding, callback) {
              chunks.push(Buffer.from(chunk))
              callback()
            },
            final(callback) {
              let output: Buffer = Buffer.alloc(0)
              if (args[0] === 'ready') output = Buffer.from('{"protocol":1}')
              if (args[0] === 'read-exec') {
                const record = records.get(args[1]!)!
                const items = (['stdout', 'stderr'] as const).flatMap((stream, index) => {
                  const offset = Number(args[2 + index])
                  if (offset > record[stream].length) {
                    status.ExitCode = 125
                    return []
                  }
                  const data = record[stream].subarray(offset)
                  return data.length ? [{ stream, offset, data: data.toString('base64') }] : []
                })
                output = Buffer.from(JSON.stringify({ chunks: items, exit: record.exit }))
              }
              if (args[0] === 'fs' && args[1] === 'write') {
                const data = Buffer.concat(chunks)
                // Like the helper: no rename unless exactly the announced bytes arrived.
                if (args[4] === String(data.length)) files.set(args[2]!, data)
                else status.ExitCode = 125
              }
              if (args[0] === 'stage') files.set(`stage:${args[1]}`, Buffer.concat(chunks))
              if (args[0] === 'fs' && args[1] === 'read')
                output = files.get(args[2]!) ?? Buffer.alloc(0)
              this.push(frame(output))
              this.push(null)
              callback()
            },
          })
          return socket
        }),
      }
      execs.set(execId, exec)
      return exec
    }),
  }
  const client = {
    info: vi.fn(async (): Promise<{ Runtimes: Record<string, object> }> => ({
      Runtimes: { runc: {} },
    })),
    getImage: vi.fn(() => ({ inspect: async () => ({ Config: {} }) })),
    createContainer: vi.fn(async (options: Docker.ContainerCreateOptions) => {
      info = {
        Id: id,
        Name: `/${options.name}`,
        Created: new Date().toISOString(),
        Config: { ...options },
        HostConfig: { ...options.HostConfig },
        Mounts: [],
        State: { Running: true, OOMKilled: false },
      } as unknown as Docker.ContainerInspectInfo
      return container
    }),
    getContainer: vi.fn(() => container),
    getExec: vi.fn((execId: string) => execs.get(execId)),
    listContainers: vi.fn(async () => [{ Id: id }]),
  }
  return {
    client: client as unknown as Docker,
    raw: client,
    container,
    commands,
    records,
    files,
    info: () => info,
  }
}
const config = { runtime: 'runc' as const }
const collect = async (source: AsyncIterable<ExecChunk>) => {
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

describe('Docker sandbox provider', () => {
  it('pins hardening, uses only a local socket, and roundtrips labels including fencing epoch', async () => {
    const fake = daemon()
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    const sandbox = await provider.create(spec())
    const options = fake.raw.createContainer.mock.calls[0]![0]
    expect(options.HostConfig).toMatchObject({
      Runtime: 'runc',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NanoCpus: 2e9,
      Memory: 4096 * 1024 * 1024,
      MemorySwap: 4096 * 1024 * 1024,
      PidsLimit: 512,
      NetworkMode: 'none',
      AutoRemove: false,
    })
    expect(options.User).toBe('10001:10001')
    expect(options.Env).not.toContainEqual(expect.stringContaining('secret'))
    // Prepared secrets are limited by the same constant the tmpfs is mounted with.
    expect(options.HostConfig!.Tmpfs![SANDBOX_SECRETS_DIR]).toContain(
      `size=${SANDBOX_SECRETS_TMPFS_BYTES / 1024}k,`,
    )
    expect(preparedRunLimits.secretBytes).toBeLessThanOrEqual(SANDBOX_SECRETS_TMPFS_BYTES)
    expect((await provider.get(sandbox.id))!.labels).toEqual(spec().labels)
    expect(await provider.list({ leaseEpoch: 4 })).toMatchObject([
      { id: sandbox.id, labels: spec().labels },
    ])
    expect(await provider.list({ leaseEpoch: 3 })).toEqual([])
    await sandbox.destroy('completed')
    await sandbox.destroy('completed')
    expect(fake.container.remove).toHaveBeenCalledTimes(1)
    expect(() =>
      createDockerSandboxProvider({ ...config, socketPath: 'tcp://localhost:2375' }),
    ).toThrow(/socket/)
  })

  it('refuses invalid policy, missing runtimes and an unconfigured gateway before create', async () => {
    const fake = daemon()
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    for (const bad of [
      spec({ image: 'agent:latest' }),
      spec({ user: { uid: 0, gid: 0 } }),
      spec({ env: { TOKEN: 'secret' } }),
      spec({ secrets: [{ path: '/workspace/.env', value: 'secret' }] }),
      {} as SandboxSpec,
    ])
      await expect(provider.create(bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      provider.create(spec({ network: { mode: 'gateway', routes: ['llm'] } })),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(provider.create(spec({ runtime: 'runsc' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    fake.raw.info.mockResolvedValue({ Runtimes: {} })
    await expect(provider.create(spec())).rejects.toThrow(/runtime/)
    expect(fake.raw.createContainer).not.toHaveBeenCalled()
  })

  it('refuses container env that every exec resets, but passes it through exec env', async () => {
    const fake = daemon()
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    const value = '--max-old-space-size=2048'
    for (const name of HELPER_ENV.map((entry) => entry.slice(0, -1)))
      await expect(provider.create(spec({ env: { [name]: value } }))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('ExecSpec.env'),
      })
    expect(fake.raw.info).not.toHaveBeenCalled()
    const sandbox = await provider.create(spec())
    const run = await sandbox.exec({
      argv: ['agent'],
      env: { NODE_OPTIONS: value },
      timeoutMs: 5000,
    })
    const staged = fake.files.get(`stage:${run.id.split('.')[0]}`)!
    expect(JSON.parse(staged.subarray(4, 4 + staged.readUInt32BE(0)).toString())).toMatchObject({
      env: { NODE_OPTIONS: value },
    })
    await sandbox.destroy('completed')
  })

  it.each(['cleanup retry', 'external removal'])(
    'releases the exact gateway after main %s',
    async (cause) => {
      const fake = daemon()
      const resourceId = '01234567-1234-1234-1234-0123456789ab'
      const networkMode = `container:${'a'.repeat(64)}`
      const policy = { mode: 'gateway' as const, routes: ['llm' as const] }
      const gateway = {
        prepare: vi.fn(async () => ({ networkMode, resourceId, extraHosts: [] })),
        validate: vi.fn(async () => true),
        release: vi.fn(async () => {}),
      }
      const sandbox = await createDockerSandboxProvider(config, {
        client: fake.client,
        gateway,
      }).create(spec({ network: policy }))
      const deadline = Number(fake.info().Config.Labels['io.raditi.sandbox.deadline'])
      expect(gateway.prepare).toHaveBeenCalledWith(
        { labels: spec().labels, policy, deadline },
        undefined,
      )
      expect(gateway.validate).toHaveBeenCalledWith({
        resourceId,
        labels: spec().labels,
        deadline,
        policy,
        sandbox: expect.objectContaining({ Id: fake.info().Id }),
      })
      if (cause === 'cleanup retry') {
        gateway.release.mockRejectedValueOnce(new Error('transient gateway cleanup failure'))
        await expect(sandbox.destroy('completed')).rejects.toThrow(/cleanup failure/)
      }
      fake.container.inspect.mockRejectedValue({ statusCode: 404 })
      fake.container.remove.mockRejectedValue({ statusCode: 404 })
      await sandbox.destroy('completed')
      const expectedCalls = cause === 'cleanup retry' ? 2 : 1
      expect(gateway.release).toHaveBeenCalledTimes(expectedCalls)
      expect(gateway.release).toHaveBeenCalledWith(resourceId)
      expect(gateway.release.mock.calls).toEqual(Array(expectedCalls).fill([resourceId]))
      await sandbox.destroy('completed')
      expect(gateway.release).toHaveBeenCalledTimes(expectedCalls)
    },
  )

  it('runsc: joins the attempt network directly at the address the gateway manager gives', async () => {
    const fake = daemon()
    fake.raw.info.mockResolvedValue({
      Runtimes: { runsc: { path: '/usr/bin/runsc', runtimeArgs: ['--platform=systrap'] } },
    })
    const resourceId = '01234567-1234-1234-1234-0123456789ab'
    const network = 'b'.repeat(64)
    const endpoints = { [network]: { IPAMConfig: { IPv4Address: '172.30.0.3' } } }
    const gateway = {
      prepare: vi.fn(async () => ({
        resourceId,
        networkMode: network,
        extraHosts: ['sandbox-gw:172.30.0.2'],
        endpoints,
      })),
      validate: vi.fn(async () => true),
      release: vi.fn(async () => {}),
    }
    const provider = createDockerSandboxProvider(
      { ...config, runtime: 'runsc' },
      { client: fake.client, gateway },
    )
    const sandbox = await provider.create(
      spec({ runtime: 'runsc', network: { mode: 'gateway', routes: ['llm'] } }),
    )
    const options = fake.raw.createContainer.mock.calls[0]![0]
    expect(options.HostConfig).toMatchObject({
      Runtime: 'runsc',
      NetworkMode: network,
      ExtraHosts: ['sandbox-gw:172.30.0.2'],
      CapDrop: ['ALL'],
    })
    expect(options.NetworkingConfig).toEqual({ EndpointsConfig: endpoints })
    await sandbox.destroy('completed')
    expect(gateway.release).toHaveBeenCalledWith(resourceId)
  })

  it('runsc: refuses daemon flags that give the sandbox the host network or raw sockets', async () => {
    for (const args of [
      undefined,
      [],
      ['--platform=systrap'],
      ['-network=sandbox', '--net-raw=false'],
    ])
      expect(safeRunscArgs(args)).toBe(true)
    for (const args of [
      ['--net-raw'],
      ['-net-raw=true'],
      ['--network=host'],
      ['--network', 'host'],
      ['--network'],
      ['--allow-flag-override'],
      'not-a-list',
      [1],
    ])
      expect(safeRunscArgs(args)).toBe(false)
    expect(safeRunscRuntime({ path: '/usr/bin/runsc', status: {} })).toBe(true)
    for (const runtime of [
      // A containerd shim takes flags from a toml file the daemon does not report.
      { path: '/usr/bin/runsc', runtimeType: 'io.containerd.runsc.v1' },
      { path: '/usr/bin/runsc', options: { ConfigPath: '/etc/containerd/runsc.toml' } },
      // Any binary may be registered under the runtime name runsc.
      { path: 'runc' },
      { path: '/usr/bin/runsc', runtimeArgs: ['--net-raw'] },
      {},
      null,
    ])
      expect(safeRunscRuntime(runtime)).toBe(false)
    for (const runsc of [
      { path: '/usr/bin/runsc', runtimeArgs: ['--net-raw'] },
      { path: '/usr/bin/runsc', runtimeType: 'io.containerd.runsc.v1' },
    ]) {
      const fake = daemon()
      fake.raw.info.mockResolvedValue({ Runtimes: { runsc } })
      const provider = createDockerSandboxProvider(
        { ...config, runtime: 'runsc' },
        { client: fake.client },
      )
      // A misconfigured daemon is an infrastructure fault, never «check your input».
      await expect(provider.create(spec({ runtime: 'runsc' }))).rejects.toMatchObject({
        code: 'SANDBOX_COMMAND_FAILED',
        httpStatus: 502,
      })
      expect(fake.raw.createContainer).not.toHaveBeenCalled()
    }
  })

  it('refuses a none-network container that gained extra hosts', async () => {
    const fake = daemon()
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    const sandbox = await provider.create(spec())
    fake.info().HostConfig.ExtraHosts = ['sandbox-gw:192.0.2.1']
    expect(await provider.get(sandbox.id)).toBeNull()
  })

  it('builds the gateway manager from its config on the same Docker client', async () => {
    const fake = daemon()
    const image = `registry.local:3300/raditi/sandbox-gateway@sha256:${'1'.repeat(64)}`
    const provider = createDockerSandboxProvider(
      {
        ...config,
        gateway: {
          image,
          guardImage: image,
          llmUpstream: 'http://llm.internal:4000',
          mcpUpstream: 'http://mcp.internal:8082',
        },
      },
      { client: fake.client },
    )
    await expect(
      provider.create(spec({ network: { mode: 'gateway', routes: ['llm'] } })),
    ).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(fake.raw.getImage).toHaveBeenCalledWith(image)
    expect(fake.raw.createContainer).not.toHaveBeenCalled()
  })

  it.each(['owner', 'protocol', 'readonly', 'runtime', 'mount', 'epoch', 'privileged'])(
    'does not adopt or remove a foreign/unsafe container: %s',
    async (change) => {
      const fake = daemon()
      const provider = createDockerSandboxProvider(config, { client: fake.client })
      const sandbox = await provider.create(spec())
      const info = fake.info()
      if (change === 'owner') info.Config.Labels['io.raditi.sandbox.owner'] = 'other'
      if (change === 'protocol') info.Config.Labels['io.raditi.sandbox.protocol'] = '99'
      if (change === 'readonly') info.HostConfig.ReadonlyRootfs = false
      if (change === 'runtime') info.HostConfig.Runtime = 'other'
      if (change === 'mount') info.HostConfig.Binds = ['/host:/workspace']
      if (change === 'epoch') info.Config.Labels['io.raditi.sandbox.leaseEpoch'] = '-1'
      if (change === 'privileged') info.HostConfig.Privileged = true
      expect(await provider.get(sandbox.id)).toBeNull()
      expect(await provider.list()).toEqual([])
      if (['owner', 'protocol', 'epoch'].includes(change))
        await expect(sandbox.destroy('gc')).rejects.toThrow(/ownership/)
      expect(fake.container.remove).not.toHaveBeenCalled()
    },
  )

  it('cleans up a container whose startup failed but never removes a name-conflict winner', async () => {
    const fake = daemon()
    fake.container.start.mockRejectedValue(new Error('sensitive engine error'))
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    await expect(provider.create(spec())).rejects.toThrow(
      'Sandbox command failed or exceeded its limits',
    )
    expect(fake.container.remove).toHaveBeenCalledTimes(1)
    fake.container.remove.mockClear()
    fake.raw.createContainer.mockRejectedValue({ statusCode: 409 })
    await expect(provider.create(spec())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(fake.container.remove).not.toHaveBeenCalled()
  })

  it('does no work for an already aborted create and cleans up a late create response', async () => {
    const fake = daemon()
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    const controller = new AbortController()
    controller.abort()
    await expect(provider.create(spec(), controller.signal)).rejects.toThrow(/limits/)
    expect(fake.raw.info).not.toHaveBeenCalled()
    const original = fake.raw.createContainer.getMockImplementation()!
    let release: (() => void) | undefined
    fake.raw.createContainer.mockImplementation(async (options) => {
      const created = await original(options)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return created
    })
    vi.useFakeTimers()
    try {
      const pending = provider.create(spec()).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(30_001)
      expect(await pending).toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
      expect(fake.container.remove).not.toHaveBeenCalled()
      release!()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.container.remove).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an unconsumed completed handle cancel a later command', async () => {
    const fake = daemon()
    const sandbox = await createDockerSandboxProvider(config, { client: fake.client }).create(
      spec(),
    )
    vi.useFakeTimers()
    try {
      const completed = await sandbox.exec({ argv: ['command'], timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(150)
      expect(await completed.wait()).toEqual({ code: 0, reason: 'exited' })
      expect(
        fake.commands.some((options) => ['signal', 'quiesce'].includes(options.Cmd![2]!)),
      ).toBe(false)
    } finally {
      vi.useRealTimers()
      await sandbox.destroy('completed')
    }
  })

  it('transports binary files and secrets only through stdin, and rejects unsafe FS input', async () => {
    const fake = daemon()
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    const sandbox = await provider.create(
      spec({ secrets: [{ path: '/run/raditi/secrets/key', value: 'credential-value' }] }),
    )
    const bytes = Buffer.from([0, 255, 1])
    await sandbox.fs.write('/workspace/inbox/file', bytes)
    expect(await sandbox.fs.read('/workspace/inbox/file')).toEqual(bytes)
    expect(fake.files.get('/run/raditi/secrets/key')!.toString()).toBe('credential-value')
    // Only the byte count travels in argv, so the helper can refuse a cut stdin.
    expect(fake.commands.map((options) => options.Cmd!.slice(2))).toContainEqual([
      'fs',
      'write',
      '/workspace/inbox/file',
      '384',
      '3',
    ])
    expect(JSON.stringify(fake.commands)).not.toContain('credential-value')
    expect(JSON.stringify(fake.raw.createContainer.mock.calls)).not.toContain('credential-value')
    for (const path of [
      '/etc/passwd',
      '/workspace/../etc/passwd',
      '/workspace/a//b',
      '/run/raditi/exec/secret',
    ])
      await expect(sandbox.fs.read(path)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      sandbox.fs.write('/workspace/file', bytes, { mode: 0o4755 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await sandbox.destroy('completed')
  })

  it('replays binary stdout and stderr using independent cursors after provider reconstruction', async () => {
    const fake = daemon()
    const provider = createDockerSandboxProvider(config, { client: fake.client })
    const sandbox = await provider.create(spec())
    const run = await sandbox.exec({ argv: ['command', 'literal $(not-a-shell)'], timeoutMs: 5000 })
    expect(await collect(run.output())).toEqual([
      { stream: 'stdout', offset: 0, data: Buffer.from([0, 255, 65, 66]) },
      { stream: 'stderr', offset: 0, data: Buffer.from('warn') },
    ])
    expect(await run.wait()).toEqual({ code: 0, reason: 'exited' })
    const reconstructed = (await createDockerSandboxProvider(config, { client: fake.client }).get(
      sandbox.id,
    ))!
    const attached = await reconstructed.attach(run.id, { stdout: 2, stderr: 1 })
    expect(await collect(attached.output())).toEqual([
      { stream: 'stdout', offset: 2, data: Buffer.from('AB') },
      { stream: 'stderr', offset: 1, data: Buffer.from('arn') },
    ])
    await expect(reconstructed.attach(run.id, { stdout: -1, stderr: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(reconstructed.attach('../other')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(
      fake.commands.every(
        (cmd) =>
          cmd.Cmd![0] === NODE &&
          cmd.Cmd![1] === HELPER &&
          cmd.User === (cmd.Cmd![2] === 'bootstrap' ? '0:0' : '10001:10001') &&
          !cmd.Tty,
      ),
    ).toBe(true)
    await sandbox.destroy('completed')
  })

  it('drains bytes written between an empty spool read and the completed exec inspection', async () => {
    const fake = daemon()
    const sandbox = await createDockerSandboxProvider(config, { client: fake.client }).create(
      spec(),
    )
    const run = await sandbox.exec({ argv: ['command'], timeoutMs: 5000 })
    const [logical, execId] = run.id.split('.') as [string, string]
    const final = fake.records.get(logical)!
    fake.records.set(logical, { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exit: null })
    const exec = fake.raw.getExec(execId)!
    const status = await (exec.inspect as () => Promise<unknown>)()
    exec.inspect.mockImplementation(async () => {
      fake.records.set(logical, final)
      return status
    })
    expect(await collect(run.output())).toEqual([
      { stream: 'stdout', offset: 0, data: Buffer.from([0, 255, 65, 66]) },
      { stream: 'stderr', offset: 0, data: Buffer.from('warn') },
    ])
    await sandbox.destroy('completed')
  })

  it('backs off idle output polling and resets it when output arrives', async () => {
    const fake = daemon()
    const sandbox = await createDockerSandboxProvider(config, { client: fake.client }).create(
      spec(),
    )
    const run = await sandbox.exec({ argv: ['command'], timeoutMs: 60_000 })
    const [logical, execId] = run.id.split('.') as [string, string]
    const record = {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exit: null as { code: number; reason: string } | null,
    }
    fake.records.set(logical, record)
    const exec = fake.raw.getExec(execId)!
    const status = (await (exec.inspect as () => Promise<object>)()) as { Running: boolean }
    exec.inspect.mockImplementation(async () => ({ ...status, Running: true }))
    const reads = () => fake.commands.filter((options) => options.Cmd![2] === 'read-exec').length
    vi.useFakeTimers()
    try {
      const output = run.output()[Symbol.asyncIterator]()
      const first = output.next()
      await vi.advanceTimersByTimeAsync(3000)
      // Each read starts a helper process: 50 → 1000 ms backoff instead of ~30 reads at 100 ms.
      expect(reads()).toBe(7)
      record.stdout = Buffer.from('x')
      await vi.advanceTimersByTimeAsync(1000)
      expect((await first).value).toMatchObject({ stream: 'stdout', offset: 0 })
      const before = reads()
      const rest = output.next()
      await vi.advanceTimersByTimeAsync(60)
      expect(reads() - before).toBe(2)
      record.exit = { code: 0, reason: 'exited' }
      exec.inspect.mockImplementation(async () => status)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await rest).toEqual({ done: true, value: undefined })
    } finally {
      vi.useRealTimers()
    }
    await sandbox.destroy('completed')
  })
})

describe('Docker stream framing', () => {
  it('closes detached exec response streams, including responses arriving after timeout', async () => {
    const response = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done()
      },
    })
    const immediate = { start: vi.fn(async () => response) } as unknown as Docker.Exec
    await startDetachedExec(immediate)
    expect(response.destroyed).toBe(true)
    const lateResponse = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done()
      },
    })
    let resolve: (value: Duplex) => void = () => {
      throw new Error('No pending start')
    }
    const late = {
      start: vi.fn(
        () =>
          new Promise<Duplex>((accept) => {
            resolve = accept
          }),
      ),
    } as unknown as Docker.Exec
    await expect(startDetachedExec(late, 10)).rejects.toThrow(/limits/)
    resolve(lateResponse)
    await Promise.resolve()
    expect(lateResponse.destroyed).toBe(true)
  })

  it('preserves binary bytes over fragmented headers and bounds stderr separately', () => {
    const parser = new DockerFrames(4)
    const bytes = Buffer.concat([
      frame(Buffer.from([0, 255])),
      frame(Buffer.from('warning'), 2),
      frame(Buffer.from([1, 2])),
    ])
    for (const byte of bytes) parser.push(Buffer.from([byte]))
    expect(parser.finish()).toEqual(Buffer.from([0, 255, 1, 2]))
  })
  it('rejects corrupt, truncated and oversized frames', () => {
    expect(() => {
      const p = new DockerFrames(1)
      p.push(frame(Buffer.from('too large')))
    }).toThrow(/limits/)
    expect(() => {
      const p = new DockerFrames(1)
      p.push(Buffer.from([1]))
      p.finish()
    }).toThrow(/limits/)
    expect(() => {
      const p = new DockerFrames(1)
      p.push(frame(Buffer.from('x'), 3))
    }).toThrow(/limits/)
  })
})
