import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
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

// A client on the runtime of the pinned CLI — bun, inside the OpenCode binary — that posts bodies
// of the given sizes one after another and reports each outcome. The largest are above what the
// gateway takes: it must refuse them, and the request that follows must be answered — it may
// reuse the connection, because the refused upload was read to its end.
const UPLOADS = `(async () => {
  const post = async (bytes) => {
    try {
      const answer = await fetch('http://sandbox-gw:8080/zai/v4/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer synthetic-turn-key',
          'content-type': 'application/json',
          'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
        },
        body: '{"messages":"' + 'x'.repeat(bytes - 15) + '"}',
      })
      const text = await answer.text()
      return answer.status + ' ' + (answer.status === 200 ? text : JSON.parse(text).error.code)
    } catch (error) {
      return 'failed ' + (error.code || error.name)
    }
  }
  const outcomes = []
  for (const bytes of JSON.parse(process.argv.at(-1))) outcomes.push(await post(bytes))
  console.log(JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', outcomes }))
})()`
const MiB = 1024 * 1024
/** The limit of a request body at the gateway (gatewayLimits.requestBytes), and of the role llm. */
const BODY_LIMIT = 16 * MiB

// gVisor resolves ARP lazily: the first SYN to a live neighbour can stall, so every target gets
// two attempts of 6 s and the gateway itself is a positive control (P2 gate 1 audit).
const PROBE = `const net=require('net');const probe=(host,port)=>new Promise(done=>{const s=net.connect({host,port,timeout:6000});s.on('connect',()=>{s.destroy();done('connect')});s.on('timeout',()=>{s.destroy();done('timeout')});s.on('error',e=>done(e.code||'error'))});(async()=>{const out={};await Promise.all(JSON.parse(process.argv[1]).map(async([host,port])=>{let r;for(let i=0;i<2&&r!=='connect';i++)r=await probe(host,port);out[host+':'+port]=r}));process.stdout.write(JSON.stringify(out))})()`

/** Runs iptables on the attempt's INPUT rule in the host netns (runc, NET_ADMIN only). */
async function hostRule(client: Docker, bridge: string, op = '-C'): Promise<number> {
  const container = await client.createContainer({
    Image: guardImage!,
    User: '0:0',
    Entrypoint: ['/usr/sbin/iptables'],
    Cmd: ['--wait', '5', op, 'INPUT', '-i', bridge, '-j', 'DROP'],
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
    const requests: { route: string; headers: IncomingHttpHeaders }[] = []
    const upstream = createServer((req, res) => {
      requests.push({ route: `${req.method} ${req.url}`, headers: req.headers })
      req.resume()
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-provider-state': 'hidden-state',
        'retry-after': '7',
        'mcp-session-id': 'mcp-response-session',
        'mcp-protocol-version': '2025-06-18',
        'x-ratelimit-remaining-requests': '11',
        'set-cookie': 'provider-session=hidden',
      })
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
      if (runtime === 'runsc') {
        const bridge = bridgeName(resourceId)
        expect(await hostRule(client, bridge)).toBe(0)
        // A firewalld reload drops the rule; adopting the sandbox again puts it back.
        expect(await hostRule(client, bridge, '-D')).toBe(0)
        expect(await hostRule(client, bridge)).not.toBe(0)
        expect((await provider.get(sandbox.id))?.id).toBe(sandbox.id)
        expect(await hostRule(client, bridge)).toBe(0)
      }
      expect((await provider.get(sandbox.id))?.id).toBe(sandbox.id)

      const accepted: { path: string; headers: Record<string, string> }[] = [
        {
          path: '/zai/v4/chat/completions',
          headers: {
            'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
          },
        },
        {
          path: '/mcp',
          headers: {
            'mcp-session-id': 'mcp-request-session',
            'mcp-protocol-version': '2025-06-18',
            'last-event-id': 'mcp-event',
          },
        },
      ]
      for (const { path, headers } of accepted) {
        const result = await execute([
          'curl',
          '-sSi',
          '--max-time',
          '5',
          '-X',
          'POST',
          '-H',
          'authorization: Bearer synthetic-turn-key',
          '-H',
          'content-type: application/json',
          '-H',
          'accept: text/event-stream',
          '-H',
          'originator: private-client',
          '-H',
          'x-client-request-id: private-request',
          '-H',
          'x-forwarded-for: 192.0.2.1',
          // What the OpenCode CLI adds to every provider request: the session stays in the sandbox.
          '-H',
          'x-session-id: private-session',
          '-H',
          'x-session-affinity: private-session',
          '-H',
          'x-opencode-session-id: private-session',
          ...Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]),
          `http://sandbox-gw:8080${path}`,
          '-d',
          '{}',
        ])
        expect(result.result).toEqual({ code: 0, reason: 'exited' })
        const boundary = result.output.indexOf('\r\n\r\n')
        const responseHeaders = result.output.slice(0, boundary).toLowerCase()
        expect(result.output.slice(boundary + 4)).toBe('{"ok":true}')
        expect(responseHeaders).toContain('content-type: application/json')
        expect(responseHeaders).not.toContain('x-ratelimit-')
        expect(responseHeaders).not.toContain('x-provider-state:')
        expect(responseHeaders).not.toContain('set-cookie:')
        if (path === '/mcp') {
          expect(responseHeaders).toContain('mcp-session-id: mcp-response-session')
          expect(responseHeaders).toContain('mcp-protocol-version: 2025-06-18')
          expect(responseHeaders).not.toContain('retry-after:')
        } else {
          expect(responseHeaders).toContain('retry-after: 7')
          expect(responseHeaders).not.toContain('mcp-session-id:')
          expect(responseHeaders).not.toContain('mcp-protocol-version:')
        }
        const forwarded = requests.at(-1)!.headers
        expect(forwarded).toMatchObject({
          host: `${upstreamHost}:${port}`,
          authorization: 'Bearer synthetic-turn-key',
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...headers,
        })
        for (const name of [
          'originator',
          'x-client-request-id',
          'x-forwarded-for',
          'x-session-id',
          'x-session-affinity',
          'x-opencode-session-id',
        ])
          expect(forwarded[name]).toBeUndefined()
      }
      expect(requests.map(({ route }) => route)).toEqual([
        'POST /zai/v4/chat/completions',
        'POST /mcp',
      ])
      for (const args of [
        ['-X', 'POST', 'http://sandbox-gw:8080/v1/responses'],
        ['-X', 'POST', 'http://sandbox-gw:8080/v1/chat/completions'],
        ['http://sandbox-gw:8080/v1/models'],
        ['http://sandbox-gw:8080/zai/v4/models'],
        ['-X', 'POST', 'http://sandbox-gw:8080/zai/v4/chat/completions/compact'],
        ['-X', 'POST', 'http://sandbox-gw:8080/zai/v4/chat/completions?stream=false'],
        ['-X', 'POST', 'http://sandbox-gw:8080/zai/v4/chat/completions?target=evil'],
        ['-X', 'GET', 'http://sandbox-gw:8080/zai/v4/chat/completions'],
        ['-H', 'Host: evil', '-X', 'POST', 'http://sandbox-gw:8080/zai/v4/chat/completions'],
        ['-X', 'PUT', 'http://sandbox-gw:8080/mcp'],
        ['--path-as-is', 'http://sandbox-gw:8080/zai/../mcp'],
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
      // Only the two allowed requests above reached the upstream.
      expect(requests).toHaveLength(2)

      // A body really above the limit, uploaded by the runtime of the pinned CLI: a final 400,
      // and the next request of the same client answered. That runtime keeps a connection it
      // stopped uploading into, so the gateway answers a refused upload only after it has read
      // it to its end, and the connection stays in order.
      const sizes = Array.from({ length: 3 }, () => [
        BODY_LIMIT + 1,
        1024,
        24 * MiB,
        48 * MiB,
        1024,
      ]).flat()
      const uploads = await execute(
        ['env', 'BUN_BE_BUN=1', '/usr/local/bin/opencode', '-e', UPLOADS, JSON.stringify(sizes)],
        90_000,
      )
      expect(uploads.result).toEqual({ code: 0, reason: 'exited' })
      expect(JSON.parse(uploads.output)).toEqual({
        runtime: 'bun',
        outcomes: sizes.map((bytes) =>
          bytes > BODY_LIMIT ? '400 raditi_body' : '200 {"ok":true}',
        ),
      })
      // A body of exactly the limit is taken: only the six small ones and it went upstream.
      const atLimit = await execute(
        ['env', 'BUN_BE_BUN=1', '/usr/local/bin/opencode', '-e', UPLOADS, `[${BODY_LIMIT}]`],
        60_000,
      )
      expect(JSON.parse(atLimit.output).outcomes).toEqual(['200 {"ok":true}'])
      expect(requests).toHaveLength(2 + 6 + 1)

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
      // Still found by its labels, and reached for removal only.
      expect(
        (await provider.list({ taskId: sandbox.labels.taskId })).map((found) => found.id),
      ).toEqual([sandbox.id])
      expect((await provider.getForRemoval(sandbox.id))?.id).toBe(sandbox.id)
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
