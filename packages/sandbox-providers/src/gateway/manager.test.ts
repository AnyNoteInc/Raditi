import type Docker from 'dockerode'
import { describe, expect, it, vi } from 'vitest'

import { bridgeName, createDockerGatewayManager } from './manager.ts'

const digest = (name: string, fill: string) =>
  `registry.local:3300/raditi/${name}@sha256:${fill.repeat(64)}`
const config = {
  image: digest('sandbox-gateway', '1'),
  guardImage: digest('sandbox-guard', '2'),
  llmUpstream: 'http://llm.internal:4000',
  mcpUpstream: 'http://mcp.internal:8082',
}
const labels = {
  workspaceId: 'w',
  siteId: 's',
  taskId: 't',
  sessionId: 'x',
  turn: 1,
  leaseEpoch: 4,
}
const policy = { mode: 'gateway' as const, routes: ['llm' as const] }
const ROLE = 'io.raditi.gateway.role'

/** In-memory Docker daemon: containers, networks, endpoints and an ordered event log. */
function daemon({
  hostAddress,
  firewallExit = 0,
}: { hostAddress?: string; firewallExit?: number | ((action: string) => number) } = {}) {
  type Stored = {
    options: Docker.ContainerCreateOptions
    networks: Record<string, { NetworkID: string; IPAddress: string }>
    running: boolean
  }
  const containers = new Map<string, Stored>()
  const networks = new Map<
    string,
    { options: Docker.NetworkCreateOptions; attached: Map<string, string> }
  >()
  const events: string[] = []
  let serial = 0
  const nextId = () => (++serial).toString(16).padStart(64, '0')
  const role = (options: Docker.ContainerCreateOptions) =>
    options.Labels?.[ROLE] === 'firewall'
      ? `firewall ${options.Cmd?.[0]}`
      : (options.Labels?.[ROLE] ?? 'sandbox')
  const owned = (itemLabels: Record<string, string> | undefined, filters: { label: string[] }) =>
    filters.label.every((pair) => {
      const split = pair.indexOf('=')
      return itemLabels?.[pair.slice(0, split)] === pair.slice(split + 1)
    })
  const attach = (containerId: string, networkId: string, ip: string) => {
    networks.get(networkId)!.attached.set(containerId, ip)
    containers.get(containerId)!.networks[networkId] = { NetworkID: networkId, IPAddress: ip }
  }
  const network = (id: string) => ({
    id,
    inspect: vi.fn(async () => {
      const { options, attached } = networks.get(id)!
      return {
        Id: id,
        Name: options.Name,
        Driver: options.Driver,
        Internal: options.Internal,
        EnableIPv6: options.EnableIPv6,
        Options: options.Options,
        Labels: options.Labels,
        IPAM: {
          Config: [{ Subnet: '172.30.0.0/16', ...(hostAddress ? { Gateway: hostAddress } : {}) }],
        },
        Containers: Object.fromEntries(
          [...attached].map(([key, ip]) => [key, { IPv4Address: ip }]),
        ),
      }
    }),
    remove: vi.fn(async () => {
      if (networks.get(id)?.attached.size) throw { statusCode: 409 }
      networks.delete(id)
      events.push('remove network')
    }),
    connect: vi.fn(async ({ Container }: { Container: string }) => {
      containers.get(Container)!.networks.bridge = { NetworkID: 'bridge', IPAddress: '172.17.0.9' }
    }),
  })
  const container = (id: string) => ({
    id,
    start: vi.fn(async () => {
      const stored = containers.get(id)!
      stored.running = !stored.options.Labels?.[ROLE]?.startsWith('firewall')
      events.push(`start ${role(stored.options)}`)
    }),
    wait: vi.fn(async () => {
      const action = String(containers.get(id)?.options.Cmd?.[0])
      return { StatusCode: typeof firewallExit === 'number' ? firewallExit : firewallExit(action) }
    }),
    remove: vi.fn(async () => {
      const stored = containers.get(id)
      if (!stored) throw { statusCode: 404 }
      for (const key of Object.keys(stored.networks)) networks.get(key)?.attached.delete(id)
      containers.delete(id)
      events.push(`remove ${role(stored.options)}`)
    }),
    inspect: vi.fn(async () => {
      const { options, networks: joined, running } = containers.get(id)!
      return {
        Id: id,
        State: { Running: running },
        Config: { ...options },
        HostConfig: { ...options.HostConfig },
        NetworkSettings: { Networks: structuredClone(joined) },
      }
    }),
    exec: vi.fn(async () => ({
      start: async () => undefined,
      inspect: async () => ({ Running: false, ExitCode: 0 }),
    })),
  })
  const client = {
    getImage: vi.fn(() => ({ inspect: async () => ({ Config: {} }) })),
    createNetwork: vi.fn(async (options: Docker.NetworkCreateOptions) => {
      const id = nextId()
      networks.set(id, { options, attached: new Map() })
      events.push('create network')
      return network(id)
    }),
    getNetwork: vi.fn((id: string) => network(id)),
    createContainer: vi.fn(async (options: Docker.ContainerCreateOptions) => {
      const id = nextId()
      containers.set(id, { options, networks: {}, running: false })
      const mode = options.HostConfig?.NetworkMode ?? ''
      const ip = options.NetworkingConfig?.EndpointsConfig?.[mode]?.IPAMConfig?.IPv4Address
      if (networks.has(mode) && ip) attach(id, mode, ip)
      events.push(`create ${role(options)}`)
      return container(id)
    }),
    getContainer: vi.fn((id: string) => container(id)),
    listContainers: vi.fn(async ({ filters }: { filters: { label: string[] } }) =>
      [...containers]
        .filter(([, stored]) => owned(stored.options.Labels, filters))
        .map(([id, stored]) => ({ Id: id, Labels: stored.options.Labels ?? {} })),
    ),
    listNetworks: vi.fn(async ({ filters }: { filters: { label: string[] } }) =>
      [...networks]
        .filter(([, stored]) => owned(stored.options.Labels, filters))
        .map(([id, stored]) => ({ Id: id, Labels: stored.options.Labels ?? {} })),
    ),
  }
  /** The provider's side: the sandbox container joins as the attachment says. */
  const sandbox = async (
    attachment: Awaited<ReturnType<ReturnType<typeof createDockerGatewayManager>['prepare']>>,
  ) => {
    const created = await client.createContainer({
      Image: 'runtime',
      HostConfig: { NetworkMode: attachment.networkMode, ExtraHosts: attachment.extraHosts },
      ...(attachment.endpoints
        ? { NetworkingConfig: { EndpointsConfig: attachment.endpoints } }
        : {}),
    })
    return {
      id: created.id,
      info: async () => (await created.inspect()) as unknown as Docker.ContainerInspectInfo,
    }
  }
  return {
    client: client as unknown as Docker,
    raw: client,
    containers,
    networks,
    events,
    attach,
    sandbox,
  }
}
const input = () => ({ labels, policy, deadline: Date.now() + 60_000 })

describe('Docker gateway manager', () => {
  it('runsc: installs the host rule before any code joins a hostless bridge; the sandbox joins directly', async () => {
    let helperDown = false
    const fake = daemon({ firewallExit: () => (helperDown ? 1 : 0) })
    const manager = createDockerGatewayManager(config, fake.client, 'runsc')
    const attachment = await manager.prepare(input())
    const [networkId] = fake.networks.keys()
    const options = fake.networks.get(networkId!)!.options
    expect(options).toMatchObject({ Internal: true, EnableIPv6: false })
    expect(options.Options).toEqual({
      'com.docker.network.bridge.name': bridgeName(attachment.resourceId),
      'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
      'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
    })
    expect(bridgeName(attachment.resourceId)).toMatch(/^rdx[0-9a-f]{12}$/)
    expect(fake.events).toEqual([
      'create network',
      'create firewall install',
      'start firewall install',
      'remove firewall install',
      'create proxy',
      'start proxy',
    ])
    const helper = fake.raw.createContainer.mock.calls.find(
      ([call]) => call.Labels?.[ROLE] === 'firewall',
    )![0]
    expect(helper.Cmd).toEqual(['install', bridgeName(attachment.resourceId)])
    expect(helper.Image).toBe(config.guardImage)
    expect(helper.HostConfig).toMatchObject({
      Runtime: 'runc',
      NetworkMode: 'host',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: ['NET_ADMIN'],
      SecurityOpt: ['no-new-privileges'],
    })
    expect(helper.HostConfig?.Binds).toBeUndefined()
    expect(attachment).toEqual({
      resourceId: attachment.resourceId,
      networkMode: networkId,
      extraHosts: ['sandbox-gw:172.30.0.2'],
      endpoints: { [networkId!]: { IPAMConfig: { IPv4Address: '172.30.0.3' } } },
    })

    const sandbox = await fake.sandbox(attachment)
    const check = async () =>
      manager.validate({
        resourceId: attachment.resourceId,
        labels,
        deadline: Number(options.Labels!['io.raditi.gateway.deadline']),
        policy,
        sandbox: await sandbox.info(),
      })
    expect(await check()).toBe(true)
    // Bridge traffic is unfiltered: a third endpoint on the attempt network is refused.
    const intruder = await fake.raw.createContainer({ Image: 'other' })
    fake.attach(intruder.id, networkId!, '172.30.0.4')
    expect(await check()).toBe(false)
    await intruder.remove()
    expect(await check()).toBe(true)
    // Every adoption puts the host rule back (e.g. after a firewalld reload); a helper that
    // cannot do it is an infrastructure error, not a vanished sandbox.
    const installs = () => fake.events.filter((event) => event === 'create firewall install').length
    const before = installs()
    expect(await check()).toBe(true)
    expect(installs()).toBe(before + 1)
    helperDown = true
    await expect(check()).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    helperDown = false
    fake.networks.get(networkId!)!.options.Options!['com.docker.network.bridge.name'] = 'docker0'
    expect(await check()).toBe(false)
  })

  it('runsc: release removes the bridge before sweeping host rules', async () => {
    const fake = daemon()
    const manager = createDockerGatewayManager(config, fake.client, 'runsc')
    const { resourceId } = await manager.prepare(input())
    fake.events.length = 0
    await manager.release(resourceId)
    expect(fake.events).toEqual([
      'remove proxy',
      'remove network',
      'create firewall sweep',
      'start firewall sweep',
      'remove firewall sweep',
    ])
    expect(fake.containers.size).toBe(0)
    expect(fake.networks.size).toBe(0)
  })

  it('runsc: a failed sweep does not fail the release', async () => {
    const fake = daemon({ firewallExit: (action) => (action === 'sweep' ? 1 : 0) })
    const manager = createDockerGatewayManager(config, fake.client, 'runsc')
    const { resourceId } = await manager.prepare(input())
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    await manager.release(resourceId)
    expect(warning).toHaveBeenCalledWith('Sandbox host firewall sweep failed', {
      code: 'RADITI_SANDBOX_FIREWALL_SWEEP',
    })
    warning.mockRestore()
    expect(fake.containers.size).toBe(0)
    expect(fake.networks.size).toBe(0)
  })

  it.each([
    ['a bridge with a host address', { hostAddress: '172.30.0.1' }],
    ['a failed host rule', { firewallExit: 1 }],
  ])('runsc fails closed on %s and removes the attempt', async (_case, options) => {
    const fake = daemon(options)
    const manager = createDockerGatewayManager(config, fake.client, 'runsc')
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    await expect(manager.prepare(input())).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    warning.mockRestore()
    expect(fake.events).not.toContain('create proxy')
    expect(fake.networks.size).toBe(0)
    expect(fake.containers.size).toBe(0)
  })

  it('runc: the sandbox shares a guard netns and no host rule is needed', async () => {
    const fake = daemon()
    const manager = createDockerGatewayManager(config, fake.client, 'runc')
    const attachment = await manager.prepare(input())
    expect(fake.events.some((event) => event.startsWith('create firewall'))).toBe(false)
    const guardId = [...fake.containers].find(
      ([, stored]) => stored.options.Labels?.[ROLE] === 'guard',
    )![0]
    expect(attachment).toEqual({
      resourceId: attachment.resourceId,
      networkMode: `container:${guardId}`,
      extraHosts: [],
    })
    const sandbox = await fake.sandbox(attachment)
    const [networkId] = fake.networks.keys()
    const deadline = Number(
      fake.networks.get(networkId!)!.options.Labels!['io.raditi.gateway.deadline'],
    )
    const check = async () =>
      manager.validate({
        resourceId: attachment.resourceId,
        labels,
        deadline,
        policy,
        sandbox: await sandbox.info(),
      })
    expect(await check()).toBe(true)
    fake.containers.get(sandbox.id)!.options.HostConfig!.ExtraHosts = ['sandbox-gw:192.0.2.1']
    expect(await check()).toBe(false)
    await manager.release(attachment.resourceId)
    expect(fake.events.at(-1)).toBe('remove network')
  })

  describe('the client egress of an attempt (plan 53, Р13)', () => {
    const egressPolicy = {
      mode: 'gateway' as const,
      routes: ['llm' as const, 'mcp' as const],
      egress: ['api.example.ru:443', 'hooks.example.com:8443'],
    }
    const envOf = (fake: ReturnType<typeof daemon>, role: string) =>
      Object.fromEntries(
        (
          [...fake.containers.values()].find((stored) => stored.options.Labels?.[ROLE] === role)
            ?.options.Env ?? []
        ).map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]),
      )

    it.each(['runc', 'runsc'] as const)(
      '%s: the proxy runs the egress listener with the hosts of the policy and the platform subnets',
      async (runtime) => {
        const fake = daemon()
        const manager = createDockerGatewayManager(
          { ...config, egressRefusedSubnets: ['84.201.128.0/18'] },
          fake.client,
          runtime,
        )
        const attachment = await manager.prepare({ ...input(), policy: egressPolicy })
        expect(envOf(fake, 'proxy')).toMatchObject({
          EGRESS_PORT: '3128',
          EGRESS_ALLOWED_HOSTS: JSON.stringify(egressPolicy.egress),
          EGRESS_REFUSED_SUBNETS: '84.201.128.0/18',
          LISTEN_HOST: '172.30.0.2',
          CLIENT_IPV4: '172.30.0.3',
        })
        // runc: the guard of the shared netns opens the egress port as well; runsc has none.
        if (runtime === 'runc')
          expect(envOf(fake, 'guard')).toEqual({
            GATEWAY_IPV4: '172.30.0.2',
            GATEWAY_PORT: '8080',
            EGRESS_PORT: '3128',
          })
        const sandbox = await fake.sandbox(attachment)
        const [networkId] = fake.networks.keys()
        const deadline = Number(
          fake.networks.get(networkId!)!.options.Labels!['io.raditi.gateway.deadline'],
        )
        const check = async (policyValue: typeof egressPolicy | typeof policy) =>
          manager.validate({
            resourceId: attachment.resourceId,
            labels,
            deadline,
            policy: policyValue,
            sandbox: await sandbox.info(),
          })
        expect(await check(egressPolicy)).toBe(true)
        // Another list of hosts than the attempt was made with is not this attempt.
        expect(await check({ ...egressPolicy, egress: ['api.example.ru:443'] })).toBe(false)
        expect(await check(policy)).toBe(false)
        // A host added to the running proxy behind the policy's back.
        const proxy = [...fake.containers.values()].find(
          (stored) => stored.options.Labels?.[ROLE] === 'proxy',
        )!
        proxy.options.Env = proxy.options.Env!.map((entry) =>
          entry.startsWith('EGRESS_ALLOWED_HOSTS=')
            ? `EGRESS_ALLOWED_HOSTS=${JSON.stringify([...egressPolicy.egress, 'evil.example.ru:443'])}`
            : entry,
        )
        expect(await check(egressPolicy)).toBe(false)
      },
    )

    it('without hosts no egress variable reaches the proxy or the guard, and one that does fails validation', async () => {
      const fake = daemon()
      const manager = createDockerGatewayManager(
        { ...config, egressRefusedSubnets: ['84.201.128.0/18'] },
        fake.client,
        'runc',
      )
      const attachment = await manager.prepare(input())
      for (const role of ['proxy', 'guard'])
        expect(Object.keys(envOf(fake, role)).filter((name) => name.startsWith('EGRESS_'))).toEqual(
          [],
        )
      const sandbox = await fake.sandbox(attachment)
      const [networkId] = fake.networks.keys()
      const deadline = Number(
        fake.networks.get(networkId!)!.options.Labels!['io.raditi.gateway.deadline'],
      )
      const check = async () =>
        manager.validate({
          resourceId: attachment.resourceId,
          labels,
          deadline,
          policy,
          sandbox: await sandbox.info(),
        })
      expect(await check()).toBe(true)
      const guard = [...fake.containers.values()].find(
        (stored) => stored.options.Labels?.[ROLE] === 'guard',
      )!
      guard.options.Env = [...guard.options.Env!, 'EGRESS_PORT=3128']
      expect(await check()).toBe(false)
    })
  })
})
