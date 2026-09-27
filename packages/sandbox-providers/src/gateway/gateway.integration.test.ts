import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Sandbox } from '@repo/domain'
import Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import { createDockerSandboxProvider } from '../docker.ts'
import { bridgeName } from './manager.ts'

const image = process.env.RADITI_DOCKER_TEST_IMAGE
const gatewayImage = process.env.SANDBOX_GATEWAY_IMAGE
const guardImage = process.env.SANDBOX_NETWORK_GUARD_IMAGE
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const runtime = process.env.SANDBOX_RUNTIME === 'runsc' ? 'runsc' : 'runc'
// Where gateway containers reach this test process: Colima maps the macOS host to 192.168.5.2.
const upstreamHost = process.env.RADITI_DOCKER_TEST_UPSTREAM_HOST || 'host.docker.internal'

// gVisor resolves ARP lazily: the first SYN to a live neighbour can stall, so every target gets
// two attempts of 6 s and the gateway itself is a positive control (P2 gate 1 audit).
const PROBE = `const net=require('net');const probe=(host,port)=>new Promise(done=>{const s=net.connect({host,port,timeout:6000});s.on('connect',()=>{s.destroy();done('connect')});s.on('timeout',()=>{s.destroy();done('timeout')});s.on('error',e=>done(e.code||'error'))});(async()=>{const out={};await Promise.all(JSON.parse(process.argv[1]).map(async([host,port])=>{let r;for(let i=0;i<2&&r!=='connect';i++)r=await probe(host,port);out[host+':'+port]=r}));process.stdout.write(JSON.stringify(out))})()`

/** Runs iptables in the host netns (runc, NET_ADMIN only) and returns its exit code. */
async function hostRule(client: Docker, bridge: string): Promise<number> {
  const container = await client.createContainer({
    Image: guardImage!,
    User: '0:0',
    Entrypoint: ['/usr/sbin/iptables'],
    Cmd: ['--wait', '5', '-C', 'INPUT', '-i', bridge, '-j', 'DROP'],
    HostConfig: {
      Runtime: 'runc',
      NetworkMode: 'host',
      CapDrop: ['ALL'],
      CapAdd: ['NET_ADMIN'],
      ReadonlyRootfs: true,
      Tmpfs: { '/run': 'rw,noexec,nosuid,nodev,size=1m' },
    },
  })
  try {
    await container.start()
    return ((await container.wait()) as { StatusCode: number }).StatusCode
  } finally {
    await container.remove({ force: true })
  }
}

describe.skipIf(!image || !gatewayImage || !guardImage)('real isolated sandbox network', () => {
  it(`${runtime}: allows only gateway routes and localhost; denies DNS, host, bridge, internet and tampered routes`, async () => {
    const requests: string[] = []
    const upstream = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '0.0.0.0', resolve))
    const port = (upstream.address() as AddressInfo).port
    const client = new Docker({ socketPath })
    const provider = createDockerSandboxProvider({
      runtime,
      socketPath,
      gateway: {
        image: gatewayImage!,
        guardImage: guardImage!,
        llmUpstream: `http://${upstreamHost}:${port}`,
        mcpUpstream: `http://${upstreamHost}:${port}`,
      },
    })
    let sandbox: Sandbox | undefined
    let resourceId: string | undefined
    let intruder: Docker.Container | undefined
    const execute = async (argv: string[], timeoutMs = 12_000) => {
      const exec = await sandbox!.exec({ argv, timeoutMs })
      const chunks: Buffer[] = []
      for await (const chunk of exec.output())
        if (chunk.stream === 'stdout') chunks.push(Buffer.from(chunk.data))
      return { output: Buffer.concat(chunks).toString(), result: await exec.wait() }
    }
    try {
      const id = randomUUID()
      sandbox = await provider.create({
        image: image!,
        runtime,
        user: { uid: 10001, gid: 10001 },
        resources: { cpu: 1, memoryMiB: 1024, pids: 128 },
        hardTimeoutMs: 120_000,
        labels: {
          workspaceId: 'network-test',
          siteId: id,
          taskId: id,
          sessionId: id,
          turn: 1,
          leaseEpoch: 1,
        },
        env: {},
        secrets: [],
        network: { mode: 'gateway', routes: ['llm', 'mcp'] },
      })
      const info = await client.getContainer(sandbox.id).inspect()
      resourceId = info.Config.Labels['io.raditi.sandbox.gatewayId']!
      const [attempt] = await client.listNetworks({
        filters: { label: [`io.raditi.gateway.resourceId=${resourceId}`] },
      })
      const network = await client.getNetwork(attempt!.Id).inspect()
      // Hostless bridge: Docker assigned no host address, so .1 is nobody.
      expect(network.IPAM?.Config).toHaveLength(1)
      expect(network.IPAM?.Config?.[0]?.Gateway).toBeFalsy()
      const subnet = network.IPAM!.Config![0]!.Subnet!.split('/')[0]!.split('.').slice(0, 3)
      const at = (last: number) => [...subnet, String(last)].join('.')
      if (runtime === 'runsc') expect(await hostRule(client, bridgeName(resourceId))).toBe(0)
      expect((await provider.get(sandbox.id))?.id).toBe(sandbox.id)

      for (const path of ['/v1/responses', '/v1/chat/completions', '/mcp']) {
        const result = await execute([
          'curl',
          '-sS',
          '--max-time',
          '5',
          '-X',
          'POST',
          `http://sandbox-gw:8080${path}`,
          '-d',
          '{}',
        ])
        expect(result).toEqual({ output: '{"ok":true}', result: { code: 0, reason: 'exited' } })
      }
      expect(requests).toEqual(['POST /v1/responses', 'POST /v1/chat/completions', 'POST /mcp'])
      for (const args of [
        ['http://sandbox-gw:8080/v1/models'],
        ['http://sandbox-gw:8080/v1/responses?target=evil'],
        ['-H', 'Host: evil', '-X', 'POST', 'http://sandbox-gw:8080/v1/responses'],
        ['-X', 'PUT', 'http://sandbox-gw:8080/mcp'],
        ['--path-as-is', 'http://sandbox-gw:8080/v1/../mcp'],
      ]) {
        const result = await execute([
          'curl',
          '-sS',
          '--max-time',
          '3',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          ...args,
        ])
        expect(result.output).toBe('403')
      }
      // TEST-NET, link-local metadata, Docker DNS, the bridge's .1, the default bridge's
      // host address and the gateway's other ports. No real external requests are made.
      const probes = await execute(
        [
          '/usr/local/bin/node',
          '-e',
          PROBE,
          JSON.stringify([
            [at(2), 8080],
            [at(1), 22],
            [at(1), 80],
            [at(2), 9090],
            ['172.17.0.1', 22],
            ['172.17.0.1', 80],
            ['192.0.2.1', 80],
            ['169.254.169.254', 80],
            ['127.0.0.11', 53],
          ]),
        ],
        40_000,
      )
      const reached = JSON.parse(probes.output) as Record<string, string>
      expect(reached[`${at(2)}:8080`]).toBe('connect')
      expect(
        Object.entries(reached).filter(
          ([target, result]) => result === 'connect' && target !== `${at(2)}:8080`,
        ),
      ).toEqual([])
      const dns = await execute([
        '/usr/local/bin/node',
        '-e',
        "const d=require('dns'); const r=new d.Resolver({timeout:300,tries:1});r.setServers(['127.0.0.11']);r.resolve4('example.com',e=>process.exit(e?0:9))",
      ])
      expect(dns.result.code).toBe(0)
      const localhost = await execute([
        '/usr/local/bin/node',
        '-e',
        "const h=require('http');const s=h.createServer((q,r)=>r.end('local'));s.listen(9231,'127.0.0.1',()=>h.get('http://127.0.0.1:9231',r=>{r.pipe(process.stdout);r.on('end',()=>s.close())}))",
      ])
      expect(localhost.output).toBe('local')
      expect(requests).toHaveLength(3)

      // Bridge traffic is not filtered, so a third endpoint on the attempt network is refused.
      intruder = await client.createContainer({
        Image: image!,
        User: '10001:10001',
        Entrypoint: ['sleep'],
        Cmd: ['60'],
        HostConfig: {
          Runtime: 'runc',
          NetworkMode: 'bridge',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
        },
      })
      await intruder.start()
      await client.getNetwork(network.Id).connect({ Container: intruder.id })
      expect(await provider.get(sandbox.id)).toBeNull()
      await intruder.remove({ force: true })
      intruder = undefined
      expect((await provider.get(sandbox.id))?.id).toBe(sandbox.id)
    } finally {
      await intruder?.remove({ force: true })
      await sandbox?.destroy('completed')
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      )
    }
    if (resourceId) {
      const filters = { label: [`io.raditi.gateway.resourceId=${resourceId}`] }
      expect(await client.listContainers({ all: true, filters })).toHaveLength(0)
      expect(await client.listNetworks({ filters })).toHaveLength(0)
      if (runtime === 'runsc') expect(await hostRule(client, bridgeName(resourceId))).not.toBe(0)
    }
  }, 180_000)
})
