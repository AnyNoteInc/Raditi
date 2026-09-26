import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { Sandbox } from '@repo/domain'
import Docker from 'dockerode'
import { describe, expect, it } from 'vitest'

import { createDockerSandboxProvider } from '../docker.ts'
import { createDockerGatewayManager } from './manager.ts'

const image = process.env.RADITI_DOCKER_TEST_IMAGE
const gatewayImage = process.env.SANDBOX_GATEWAY_IMAGE
const guardImage = process.env.SANDBOX_NETWORK_GUARD_IMAGE
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const runtime = process.env.SANDBOX_RUNTIME === 'runsc' ? 'runsc' : 'runc'

describe.skipIf(!image || !gatewayImage || !guardImage)('real isolated sandbox network', () => {
  it('allows only gateway routes and localhost; denies DNS, host, internet and tampered routes', async () => {
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
    const manager = createDockerGatewayManager(
      {
        image: gatewayImage!,
        guardImage: guardImage!,
        llmUpstream: `http://host.docker.internal:${port}`,
        mcpUpstream: `http://host.docker.internal:${port}`,
      },
      { client },
    )
    const provider = createDockerSandboxProvider(
      { runtime, imagePrefix: 'raditi/agent', socketPath },
      { client, gateway: manager },
    )
    let sandbox: Sandbox | undefined
    let resourceId: string | undefined
    const execute = async (argv: string[]) => {
      const exec = await sandbox!.exec({ argv, timeoutMs: 12_000 })
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
        hardTimeoutMs: 90_000,
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
      resourceId = info.Config.Labels['io.raditi.sandbox.gatewayId']
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
      // TEST-NET addresses: no real external user data or requests are involved.
      for (const address of ['192.0.2.1', '169.254.169.254', '127.0.0.11']) {
        const result = await execute([
          'curl',
          '-sS',
          '--connect-timeout',
          '1',
          '--max-time',
          '2',
          `http://${address}:80`,
        ])
        expect(result.result.code).not.toBe(0)
      }
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
    } finally {
      await sandbox?.destroy('completed')
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      )
    }
    if (resourceId) {
      const filters = { label: [`io.raditi.gateway.resourceId=${resourceId}`] }
      expect(await client.listContainers({ all: true, filters })).toHaveLength(0)
      expect(await client.listNetworks({ filters })).toHaveLength(0)
    }
  }, 120_000)
})
