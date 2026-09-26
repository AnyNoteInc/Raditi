import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { PRISMA, SECRET_STORE } from '../infra/tokens.ts'
import { fakeInfra, TEST_METRICS_TOKEN, testMcpConfig, type FakeInfra } from '../testing/fakes.ts'
import { McpAppModule } from './mcp-app.module.ts'
import { createMcpStrategy, MCP_ENDPOINT, MCP_SERVER_NAME, mountMcp } from './mcp-server.ts'

let app: INestApplication | undefined

async function startMcp(infra: FakeInfra): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [McpAppModule.forRoot(testMcpConfig())],
  })
    .overrideProvider(PRISMA)
    .useValue(infra.prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(infra.secrets)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  await mountMcp(app, createMcpStrategy())
  await app.init()
  return app
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('McpAppModule', () => {
  it('checks its own dependencies but exposes only status without caching', async () => {
    const infra = fakeInfra()
    const server = (await startMcp(infra)).getHttpServer()

    const res = await request(server).get('/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(infra.prisma.$queryRaw).toHaveBeenCalledOnce()
    expect(infra.secrets.health).toHaveBeenCalledOnce()
  })

  it('answers /health 503 when Vault is down', async () => {
    const server = (await startMcp(fakeInfra({ vault: 'down' }))).getHttpServer()

    const res = await request(server).get('/health')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'degraded' })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it.each(['ok', 'down'] as const)(
    'never exposes core health details on the MCP port (vault=%s)',
    async (vault) => {
      const server = (await startMcp(fakeInfra({ vault }))).getHttpServer()

      const res = await request(server)
        .get('/health')
        .set('Authorization', `Bearer ${TEST_METRICS_TOKEN}`)

      expect(res.status).toBe(vault === 'ok' ? 200 : 503)
      expect(res.body).toEqual({ status: vault === 'ok' ? 'ok' : 'degraded' })
      expect(res.headers['cache-control']).toBe('no-store')
    },
  )

  it('serves MCP initialize as raditi-mcp', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()

    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: MCP_SERVER_NAME } },
    })
    // No tools capability until P6 brings SiteAdapter.mcpTools.
    expect(res.body.result.capabilities).not.toHaveProperty('tools')
  })

  it('answers tools/list with a JSON-RPC error while there are no tools', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()

    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-protocol-version', '2025-06-18')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32601, message: 'Method not found' },
    })
  })

  it('refuses a request whose Host is not localhost (DNS rebinding, requests from other machines)', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()

    for (const host of ['evil.example', 'host.docker.internal:8082', '10.0.0.5:8082']) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Host', host)
        .set('Accept', 'application/json, text/event-stream')
        .send(initialize)

      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } })
    }
  })

  it('refuses a browser request from a foreign Origin and accepts a local one', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()
    const post = (origin: string) =>
      request(server)
        .post(MCP_ENDPOINT)
        .set('Origin', origin)
        .set('Accept', 'application/json, text/event-stream')
        .send(initialize)

    expect((await post('https://evil.example')).status).toBe(403)
    expect((await post('http://localhost:3000')).status).toBe(200)
  })

  it('accepts localhost, 127.0.0.1 and [::1] as Host', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()

    for (const host of ['localhost:8082', '127.0.0.1:8082', '[::1]:8082']) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Host', host)
        .set('Accept', 'application/json, text/event-stream')
        .send(initialize)

      expect(res.status).toBe(200)
    }
  })

  it('mounts nothing of the core role: no /metrics on the MCP port', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()

    expect((await request(server).get('/metrics')).status).toBe(404)
  })
})
