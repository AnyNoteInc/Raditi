import { createHash } from 'node:crypto'
import { connect, type AddressInfo } from 'node:net'

import { ListToolsResultSchema } from '@modelcontextprotocol/core'
import { Logger, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DomainError } from '@repo/domain'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { McpConfig } from '../config/config.ts'
import { PRISMA, SECRET_STORE } from '../infra/tokens.ts'
import { newTurnKeys } from '../llm/turn-key.ts'
import { fakeInfra, TEST_METRICS_TOKEN, testMcpConfig, type FakeInfra } from '../testing/fakes.ts'
import { MCP_CONTENT_STORAGE, type ContentStorage } from './content-storage.ts'
import { McpAppModule } from './mcp-app.module.ts'
import { MCP_CONTENT, type ContentGatewayResolver, type McpContentService } from './mcp-content.ts'
import { memoryStorage } from '../testing/snapshots.ts'
import { MCP_ACCESS, type McpAccessStore } from './mcp-access.ts'
import { MCP_CONTENT_RESOLVER } from './site-content-resolver.ts'
import { MCP_ENDPOINT, MCP_SERVER_NAME, mountMcp } from './mcp-server.ts'
import { parseMcpHosts } from './mcp-policy.ts'

let app: INestApplication | undefined
const token = `mcp_${'a'.repeat(64)}`
const scope = {
  keyId: '01960000-0000-7000-8000-000000000001',
  taskId: '01960000-0000-7000-8000-000000000002',
  workspaceId: '01960000-0000-7000-8000-000000000003',
  siteId: '01960000-0000-7000-8000-000000000004',
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 1,
  stack: 'wordpress' as const,
  url: 'https://site.example.test',
}

/** The configuration of the role with MCP_CONTENT_PROFILE=local; no S3 is ever contacted. */
const contentConfig = (): McpConfig => ({
  ...testMcpConfig(),
  contentProfile: 'local',
  storage: {
    endpoint: 'http://127.0.0.1:9',
    region: 'us-east-1',
    accessKeyId: 'synthetic',
    secretAccessKey: 'synthetic-secret',
    forcePathStyle: true,
    buckets: { artifacts: 'raditi-test-artifacts' },
  },
})

/** What a unit test puts in place of S3 and of the Vault resolver of the content profile. */
interface ContentFakes {
  storage: Partial<ContentStorage>
  resolve?: ContentGatewayResolver
}

async function startMcp(
  infra: FakeInfra,
  access: McpAccessStore = {
    authenticate: async (value) => (value === token ? scope : null),
  },
  config = testMcpConfig(),
  content?: ContentFakes,
  implementation?: Pick<McpContentService, 'wpRest' | 'restore'>,
): Promise<INestApplication> {
  const builder = Test.createTestingModule({
    imports: [
      McpAppModule.forRoot(content && config.contentProfile === 'off' ? contentConfig() : config),
    ],
  })
    .overrideProvider(PRISMA)
    .useValue(infra.prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(infra.secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue(access)
  if (content) builder.overrideProvider(MCP_CONTENT_STORAGE).useValue(content.storage)
  if (content?.resolve) builder.overrideProvider(MCP_CONTENT_RESOLVER).useValue(content.resolve)
  if (implementation) builder.overrideProvider(MCP_CONTENT).useValue(implementation)
  const moduleRef = await builder.compile()
  app = moduleRef.createNestApplication({ logger: false })
  await mountMcp(app)
  // On 127.0.0.1, where supertest connects. Left unbound, supertest listens on every address,
  // and a server another test file binds to 127.0.0.1 on the same port answers instead.
  await app.listen(0, '127.0.0.1')
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
  vi.restoreAllMocks()
  await app?.close()
  app = undefined
})

describe('McpAppModule', () => {
  it('exposes bounded content tools only with the content profile of the configuration', async () => {
    const profile = { storage: memoryStorage().storage, resolve: vi.fn() }
    const implementation = {
      wpRest: vi.fn(async () => ({
        result: 'ok' as const,
        response: { objectRef: 'page:42', title: 'Текст' },
      })),
      restore: vi.fn(async () => ({ result: 'ok' as const, response: { restored: true } })),
    }
    const server = (
      await startMcp(fakeInfra(), undefined, undefined, profile, implementation)
    ).getHttpServer()
    const post = (body: object) =>
      request(server)
        .post(MCP_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-protocol-version', '2025-06-18')
        .send(body)
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.status).toBe(200)
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'restore',
      'site_info',
      'wp_rest',
    ])
    for (const tool of list.body.result.tools.filter(
      (tool: { name: string }) => tool.name !== 'site_info',
    ))
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      })
    const args = { method: 'GET', route: '/wp/v2/pages/42' }
    const read = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'wp_rest', arguments: args },
    })
    expect(read.body.result).not.toHaveProperty('isError', true)
    expect(implementation.wpRest).toHaveBeenCalledExactlyOnceWith(scope, args)
    for (const arguments_ of [
      { method: 'GET', route: '/wp/v2/users/42' },
      { method: 'GET', route: '/wp/v2/pages' },
      { method: 'GET', route: '/wp/v2/pages/42?context=edit' },
      { method: 'DELETE', route: '/wp/v2/pages/42' },
      {
        method: 'POST',
        route: '/wp/v2/pages/42',
        body: { status: 'draft' },
        idempotencyKey: 'test',
      },
    ])
      expect(
        (
          await post({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'wp_rest', arguments: arguments_ },
          })
        ).status,
      ).toBe(400)
    expect(implementation.wpRest).toHaveBeenCalledOnce()
  })

  it('lists every content tool with an object input schema that MCP clients accept', async () => {
    const profile = { storage: memoryStorage().storage, resolve: vi.fn() }
    const implementation = { wpRest: vi.fn(), restore: vi.fn() }
    const server = (
      await startMcp(fakeInfra(), undefined, undefined, profile, implementation)
    ).getHttpServer()
    const list = await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-protocol-version', '2025-06-18')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.status).toBe(200)
    // A client that checks the list against the MCP schema rejects the whole list otherwise.
    expect(ListToolsResultSchema.safeParse(list.body.result).success).toBe(true)
    const tools = list.body.result.tools as Array<{
      name: string
      inputSchema: { type: string; properties?: Record<string, unknown> }
    }>
    for (const tool of tools) expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' })
    const wpRest = tools.find((tool) => tool.name === 'wp_rest')!
    expect(Object.keys(wpRest.inputSchema.properties ?? {}).sort()).toEqual([
      'body',
      'idempotencyKey',
      'method',
      'route',
    ])
    const advertised = {
      wp_rest: z.fromJSONSchema(wpRest.inputSchema as z.core.JSONSchema.JSONSchema),
      restore: z.fromJSONSchema(
        tools.find((tool) => tool.name === 'restore')!.inputSchema as z.core.JSONSchema.JSONSchema,
      ),
    }
    for (const args of [
      { method: 'GET', route: '/wp/v2/pages/42' },
      {
        method: 'POST',
        route: '/wp/v2/posts/7',
        body: { title: 'Заголовок' },
        idempotencyKey: 'edit-1',
      },
    ])
      expect(advertised.wp_rest.safeParse(args).success, JSON.stringify(args)).toBe(true)
    expect(
      advertised.restore.safeParse({
        snapshotId: '01960000-0000-7000-8000-000000000009',
        idempotencyKey: 'undo-1',
      }).success,
    ).toBe(true)
    expect(
      advertised.wp_rest.safeParse({ method: 'DELETE', route: '/wp/v2/pages/42' }).success,
    ).toBe(false)
  })

  it('passes only fixed, content-free refusals of a content call to the agent', async () => {
    const profile = { storage: memoryStorage().storage, resolve: vi.fn() }
    const implementation = { wpRest: vi.fn(), restore: vi.fn() }
    const server = (
      await startMcp(fakeInfra(), undefined, undefined, profile, implementation)
    ).getHttpServer()
    const call = async () =>
      (
        await request(server)
          .post(MCP_ENDPOINT)
          .set('Authorization', `Bearer ${token}`)
          .set('Accept', 'application/json, text/event-stream')
          .set('mcp-protocol-version', '2025-06-18')
          .send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'wp_rest', arguments: { method: 'GET', route: '/wp/v2/pages/42' } },
          })
      ).body.result
    for (const code of [
      'CONTENT_PRIVACY_LIMIT',
      'CONTENT_PRIVACY_UNAVAILABLE',
      'CONTENT_PRIVACY_CONTEXT',
      'CONTENT_TOO_LARGE',
      'CONTENT_OBJECT_UNAVAILABLE',
      'MCP_APPROVAL_REQUIRED',
      'MCP_CALL_IN_FLIGHT',
    ]) {
      implementation.wpRest.mockRejectedValueOnce(new DomainError(code, `private ${token}`, 409))
      expect(await call()).toEqual({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code }) }],
      })
    }
    for (const error of [
      new DomainError('CONFLICT', `private ${token}`, 409),
      new Error(`private ${token}`),
    ]) {
      implementation.wpRest.mockRejectedValueOnce(error)
      expect(await call()).toEqual({
        isError: true,
        content: [{ type: 'text', text: '{"code":"CONTENT_CALL_REJECTED"}' }],
      })
    }
  })

  it('gives a turn token no way to the trusted undo of the host', async () => {
    const profile = { storage: memoryStorage().storage, resolve: vi.fn() }
    // The whole content service of the role, as the port could reach it at the worst.
    const implementation = {
      wpRest: vi.fn(),
      restore: vi.fn(),
      undoTurn: vi.fn(),
      undoTask: vi.fn(),
      rollbackTurn: vi.fn(),
      recoverWrite: vi.fn(),
    }
    const server = (
      await startMcp(fakeInfra(), undefined, undefined, profile, implementation)
    ).getHttpServer()
    const send = (method: 'post' | 'get', path: string, body?: object) =>
      request(server)
        [method](path)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-protocol-version', '2025-06-18')
        .send(body)
    const fence = { siteId: scope.siteId, taskId: scope.taskId, operation: 'turn', epoch: 1 }
    const snapshotId = '01960000-0000-7000-8000-000000000009'
    const call = (name: string, args: object) =>
      send('post', MCP_ENDPOINT, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      })
    // No tool of that name, however it is spelled.
    for (const name of [
      'undoTurn',
      'undoTask',
      'undo_turn',
      'undo_task',
      'rollbackTurn',
      'rollback',
      'recoverWrite',
    ])
      for (const args of [
        { fence, turn: 1 },
        { fence, targetTaskId: scope.taskId },
        { snapshotId, idempotencyKey: `undo:1:${snapshotId}` },
      ])
        expect((await call(name, args)).status, name).toBe(400)
    // The agent's restore takes a snapshot and a key and nothing of the host's scope.
    for (const extra of [
      { hostUndo: true },
      { fence },
      { targetTaskId: scope.taskId },
      { turn: 1 },
      { scope: { ...fence, targetTaskId: scope.taskId } },
    ])
      expect(
        (await call('restore', { snapshotId, idempotencyKey: 'undo-1', ...extra })).status,
        JSON.stringify(extra),
      ).toBe(400)
    // No JSON-RPC method and no path beside the endpoint.
    expect(
      (
        await send('post', MCP_ENDPOINT, {
          jsonrpc: '2.0',
          id: 1,
          method: 'content/undo',
          params: { fence, targetTaskId: scope.taskId },
        })
      ).status,
    ).toBe(400)
    for (const path of [
      '/internal/content/undo-task',
      '/internal/content/undo-turn',
      '/internal/content/replace-rollback',
      `${MCP_ENDPOINT}/undo`,
    ])
      for (const method of ['post', 'get'] as const)
        expect(
          (await send(method, path, method === 'post' ? { fence, turn: 1 } : undefined)).status,
          path,
        ).toBe(404)
    for (const method of Object.values(implementation)) expect(method).not.toHaveBeenCalled()
  })

  it('refuses the content profile in production, whatever the configuration loader let through', () => {
    const refusal = 'Local MCP content profile cannot run in production'
    // loadConfig never produces this configuration; the module does not rely on that.
    expect(() => McpAppModule.forRoot({ ...contentConfig(), appEnv: 'production' })).toThrow(
      refusal,
    )
    // Nor may a test seam reach a production composition, with the profile off as well.
    for (const config of [contentConfig(), testMcpConfig()])
      expect(() =>
        McpAppModule.forRoot(
          { ...config, appEnv: 'production' },
          { wrapResolver: (regular) => regular },
        ),
      ).toThrow(refusal)
    expect(() => McpAppModule.forRoot({ ...testMcpConfig(), appEnv: 'production' })).not.toThrow()
  })

  it('refuses a composition that names the profile without its storage, or a seam without the profile', () => {
    expect(() => McpAppModule.forRoot({ ...contentConfig(), storage: null })).toThrow(
      'MCP content profile needs its S3 settings',
    )
    expect(() =>
      McpAppModule.forRoot(testMcpConfig(), { wrapResolver: (regular) => regular }),
    ).toThrow('MCP content test seams need the content profile')
  })

  it('keeps the content tools and their providers out of the role while the profile is off', async () => {
    const instance = await startMcp(fakeInfra())
    for (const provider of [MCP_CONTENT, MCP_CONTENT_STORAGE, MCP_CONTENT_RESOLVER])
      expect(() => instance.get(provider)).toThrow()
  })

  it('composes the content profile from the configuration: S3, Vault and the registry of site adapters', async () => {
    const siteId = scope.siteId
    const reference = {
      id: '01960000-0000-7000-8000-00000000000a',
      workspaceId: scope.workspaceId,
      vaultPath: `kv/sites/${siteId}/wp`,
      keyVersion: 2,
    }
    const findMany = vi.fn(async (_query: unknown) => [reference])
    const kvRead = vi.fn(async (_path: string) => ({
      version: 2,
      data: {
        v: '1',
        origin: 'https://site.example.test',
        username: 'raditi',
        applicationPassword: 'synthetic application password',
      },
    }))
    const infra = fakeInfra()
    Object.assign(infra.prisma, { credentialRef: { findMany } })
    Object.assign(infra.secrets, { kvRead })
    const instance = await startMcp(infra, undefined, contentConfig(), {
      storage: memoryStorage().storage,
    })
    const resolve = instance.get<ContentGatewayResolver>(MCP_CONTENT_RESOLVER)
    // The role's own database and Vault clients, the kind and the path from the adapter of the
    // site's stack: nothing of it is named by this module.
    const gateway = await resolve(scope)
    expect(findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { siteId, kind: 'wp' } }),
    )
    expect(kvRead).toHaveBeenCalledExactlyOnceWith(`kv/sites/${siteId}/wp`)
    expect(typeof gateway.conditionalWrite).toBe('function')
    await expect(resolve({ ...scope, stack: 'bitrix' })).rejects.toMatchObject({
      code: 'CONTENT_SITE_ACCESS_UNAVAILABLE',
      details: { reason: 'stack' },
    })
    // A reference whose path is the path of another site is not followed.
    await expect(
      resolve({ ...scope, siteId: '01960000-0000-7000-8000-0000000000ff' }),
    ).rejects.toMatchObject({ details: { reason: 'path' } })
    expect(instance.get(MCP_CONTENT)).toBeDefined()
  })

  it('logs why a site access was refused as one fixed word, without the site or the secret', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const infra = fakeInfra()
    Object.assign(infra.prisma, { credentialRef: { findMany: async () => [] } })
    const instance = await startMcp(infra, undefined, contentConfig(), {
      storage: memoryStorage().storage,
    })
    const resolve = instance.get<ContentGatewayResolver>(MCP_CONTENT_RESOLVER)
    for (let attempt = 0; attempt < 3; attempt++)
      await expect(resolve(scope)).rejects.toMatchObject({ details: { reason: 'reference' } })
    // Throttled: one line for the repeated refusal.
    expect(warn.mock.calls).toEqual([['site content access (reference): refused']])
  })

  it('lets a stand wrap the regular resolver to inject faults, and nothing else', async () => {
    const infra = fakeInfra()
    Object.assign(infra.prisma, { credentialRef: { findMany: async () => [] } })
    const seen: ContentGatewayResolver[] = []
    const wrapped: ContentGatewayResolver = async () => {
      throw new Error('synthetic fault')
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        McpAppModule.forRoot(contentConfig(), {
          wrapResolver: (regular) => {
            seen.push(regular)
            return wrapped
          },
        }),
      ],
    })
      .overrideProvider(PRISMA)
      .useValue(infra.prisma)
      .overrideProvider(SECRET_STORE)
      .useValue(infra.secrets)
      .overrideProvider(MCP_CONTENT_STORAGE)
      .useValue(memoryStorage().storage)
      .compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    expect(app.get(MCP_CONTENT_RESOLVER)).toBe(wrapped)
    expect(seen).toHaveLength(1)
    // What the wrapper was given is the regular resolver over the role's database and Vault.
    await expect(seen[0]!(scope)).rejects.toMatchObject({
      code: 'CONTENT_SITE_ACCESS_UNAVAILABLE',
      details: { reason: 'reference' },
    })
  })

  it('answers /health for the artifacts bucket of the content profile, and for no other', async () => {
    const checkBuckets = vi.fn(async () => ({ artifacts: true }))
    const server = (
      await startMcp(fakeInfra(), undefined, contentConfig(), { storage: { checkBuckets } })
    ).getHttpServer()
    const healthy = await request(server).get('/health')
    expect(healthy.status).toBe(200)
    expect(healthy.body).toEqual({ status: 'ok' })
    expect(checkBuckets).toHaveBeenCalledExactlyOnceWith(['artifacts'])
  })

  it('answers /health 503 when the bucket of content snapshots is out of reach', async () => {
    const server = (
      await startMcp(fakeInfra(), undefined, contentConfig(), {
        storage: { checkBuckets: async () => ({ artifacts: false }) },
      })
    ).getHttpServer()
    const degraded = await request(server).get('/health')
    expect(degraded.status).toBe(503)
    expect(degraded.body).toEqual({ status: 'degraded' })
  })
  it('checks its own dependencies but exposes only status without caching', async () => {
    const infra = fakeInfra()
    const server = (await startMcp(infra)).getHttpServer()

    const res = await request(server).get('/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(infra.prisma.$queryRaw).toHaveBeenCalledOnce()
    expect(infra.secrets.health).toHaveBeenCalledOnce()

    // The next probes within a few seconds reuse the report.
    expect((await request(server).get('/health')).body).toEqual({ status: 'ok' })
    expect(infra.prisma.$queryRaw).toHaveBeenCalledOnce()
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
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: MCP_SERVER_NAME } },
    })
    expect(res.body.result.capabilities).toHaveProperty('tools')
    expect(res.body.result.capabilities).not.toHaveProperty('logging')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('advertises only the implemented read-only site_info tool', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()

    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-protocol-version', '2025-06-18')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    expect(res.status).toBe(200)
    expect(res.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['site_info'])
    expect(res.body.result.tools[0].annotations).toMatchObject({ readOnlyHint: true })
  })

  it('refuses a request whose Host is not an allowed upstream host (DNS rebinding, requests from other machines)', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()

    // The dev default admits localhost and host.docker.internal (Docker Desktop sandbox-gw);
    // every other name or address is refused.
    for (const host of ['evil.example', 'gateway.docker.internal:8082', '10.0.0.5:8082']) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
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
        .set('Authorization', `Bearer ${token}`)
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
        .set('Authorization', `Bearer ${token}`)
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

  it('accepts full and compressed IPv6 Hosts configured with a full address', async () => {
    const config = testMcpConfig()
    config.allowedHosts = parseMcpHosts('[fd00:0:0:0:0:0:0:2]', true)
    const server = (await startMcp(fakeInfra(), undefined, config)).getHttpServer()
    for (const host of ['[fd00::2]:8082', '[fd00:0:0:0:0:0:0:2]:8082']) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Host', host)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(initialize)
      expect(res.status, `${host} ${res.text}`).toBe(200)
      expect(res.body.result.serverInfo.name).toBe(MCP_SERVER_NAME)
    }
  })

  it('requires the turn token for initialize, tools/list, notifications, GET and DELETE', async () => {
    const access = { authenticate: vi.fn(async () => null) }
    const server = (await startMcp(fakeInfra(), access)).getHttpServer()
    for (const body of [
      initialize,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]) {
      const res = await request(server).post(MCP_ENDPOINT).send(body)
      expect(res.status).toBe(401)
      expect(res.headers['www-authenticate']).toBe('Bearer realm="raditi-mcp"')
      expect(res.headers['cache-control']).toBe('no-store')
    }
    expect((await request(server).get(MCP_ENDPOINT)).status).toBe(401)
    expect((await request(server).delete(MCP_ENDPOINT)).status).toBe(401)
    // Only `Bearer` and one whole token of the issued format reach the lookup.
    const pair = newTurnKeys()
    for (const header of [
      token,
      `bearer ${token}`,
      `Basic ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token}0`,
      `Bearer x${token}`,
      `Bearer ${token.toUpperCase()}`,
      `Bearer ${token}, Bearer ${token}`,
      `Bearer ${pair.llmApiKey}`,
      'Bearer ',
    ]) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Authorization', header)
        .send(initialize)
      expect(res.status, header).toBe(401)
    }
    expect(access.authenticate).not.toHaveBeenCalled()
    await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${pair.mcpToken}`)
      .send(initialize)
    expect(access.authenticate).toHaveBeenCalledExactlyOnceWith(pair.mcpToken)
    access.authenticate.mockClear()
    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .send(initialize)
    expect(res.status).toBe(401)
    expect(access.authenticate).toHaveBeenCalledExactlyOnceWith(token)
    expect(JSON.stringify(res.body)).not.toContain(token)
  })

  it('checks authorization afresh on every request, including after initialization', async () => {
    const authenticate = vi.fn().mockResolvedValueOnce(scope).mockResolvedValue(null)
    const server = (await startMcp(fakeInfra(), { authenticate })).getHttpServer()
    expect(
      (
        await request(server)
          .post(MCP_ENDPOINT)
          .set('Authorization', `Bearer ${token}`)
          .set('Accept', 'application/json, text/event-stream')
          .send(initialize)
      ).status,
    ).toBe(200)
    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(res.status).toBe(401)
    expect(authenticate).toHaveBeenCalledTimes(2)
  })

  it('returns only the assigned site and refuses a target supplied by the caller', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()
    const call = (args: Record<string, unknown>) =>
      request(server)
        .post(MCP_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-protocol-version', '2025-06-18')
        .send({
          jsonrpc: '2.0',
          id: 0,
          method: 'tools/call',
          params: { name: 'site_info', arguments: args },
        })
    const res = await call({})
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(0)
    expect(res.body.result.content).toEqual([
      { type: 'text', text: JSON.stringify({ url: scope.url, stack: scope.stack }) },
    ])
    expect(JSON.stringify(res.body)).not.toMatch(/taskId|siteId|workspaceId|mcp_|keyId/)
    const foreign = await call({ siteId: 'another-site' })
    expect(foreign.body.error ?? foreign.body.result?.isError).toBeTruthy()
  })

  it('returns a fixed 503 on database failures without reflecting credentials or errors', async () => {
    const server = (
      await startMcp(fakeInfra(), {
        authenticate: async () => {
          throw new Error(`private database detail ${token}`)
        },
      })
    ).getHttpServer()
    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .send(initialize)
    expect(res.status).toBe(503)
    expect(res.body.error.message).toBe('MCP authorization is unavailable')
    expect(JSON.stringify(res.body)).not.toMatch(/private|mcp_/)
  })

  it('logs only the class and codes of an admission failure and reports health degraded', async () => {
    const lines: string[] = []
    for (const level of ['warn', 'error'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
        lines.push(String(line))
      })
    const hash = createHash('sha256').update(token).digest('hex')
    // The shape of a PrismaPg raw-query failure, e.g. a column a pending migration adds.
    const failure = Object.assign(new Error(`private ${token} ${hash}`), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { kind: 'ColumnNotFound', originalCode: '42703', originalMessage: 'private' },
        },
      },
    })
    const authenticate = vi.fn(async (): Promise<null> => {
      throw failure
    })
    const server = (await startMcp(fakeInfra(), { authenticate })).getHttpServer()
    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize)
    expect(res.status).toBe(503)
    const health = await request(server).get('/health')
    expect(health.status).toBe(503)
    expect(health.body).toEqual({ status: 'degraded' })
    expect(lines.join('\n')).toContain('PrismaClientKnownRequestError P2010 42703 ColumnNotFound')
    expect(
      lines.filter((line) => line.startsWith('MCP authorization is unavailable')),
    ).toHaveLength(1)
    expect(lines.join('\n')).not.toMatch(new RegExp(`private|mcp_|${hash}`))
  })

  it('checks the admission query itself for health without admitting the probe', async () => {
    const authenticate = vi.fn(async () => null)
    const server = (await startMcp(fakeInfra(), { authenticate })).getHttpServer()
    expect((await request(server).get('/health')).body).toEqual({ status: 'ok' })
    expect(authenticate).toHaveBeenCalledOnce()
    await app!.close()
    const admitted = vi.fn(async () => scope)
    const leaky = (await startMcp(fakeInfra(), { authenticate: admitted })).getHttpServer()
    expect((await request(leaky).get('/health')).status).toBe(503)
  })

  it('refuses repeated Authorization, Host, Origin and protocol headers before admission', async () => {
    const authenticate = vi.fn(async () => scope)
    const server = (await startMcp(fakeInfra(), { authenticate })).getHttpServer()
    const { port } = server.address() as AddressInfo
    const body = JSON.stringify(initialize)
    // A raw request: Node's HTTP client refuses to send a repeated Host itself.
    const send = (extra: string[]) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const singles: Record<string, string> = {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
        }
        for (const line of extra) delete singles[line.slice(0, line.indexOf(':'))]
        const head = [
          `POST ${MCP_ENDPOINT} HTTP/1.1`,
          ...Object.entries(singles).map(([name, value]) => `${name}: ${value}`),
          'Accept: application/json, text/event-stream',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          ...extra,
        ]
        let raw = ''
        const socket = connect(port, '127.0.0.1', () =>
          socket.end(`${head.join('\r\n')}\r\n\r\n${body}`),
        )
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => (raw += chunk))
        socket.on('error', reject)
        socket.on('end', () =>
          resolve({
            status: Number(raw.split(' ')[1]),
            text: raw.slice(raw.indexOf('\r\n\r\n') + 4),
          }),
        )
      })
    expect((await send([])).status).toBe(200)
    expect(authenticate).toHaveBeenCalledOnce()
    for (const repeated of [
      ['Authorization', `Bearer ${token}`, `Bearer mcp_${'b'.repeat(64)}`],
      ['Host', `127.0.0.1:${port}`, 'localhost'],
      ['Origin', 'http://localhost', 'http://localhost:3000'],
      ['MCP-Protocol-Version', '2025-06-18', '2025-03-26'],
    ] as const) {
      const [name, ...values] = repeated
      const res = await send(values.map((value) => `${name}: ${value}`))
      expect(res.status, name).toBe(400)
      expect(res.text, name).toContain('"message":"Invalid MCP headers"')
      expect(res.text).not.toContain(token)
    }
    expect(authenticate).toHaveBeenCalledOnce()
  })

  it('refuses an unknown protocol header without repeating its value', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()
    const res = await request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .set('mcp-protocol-version', token)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toContain(token)
  })

  it('refuses a newer protocol version in the form that lets a client fall back to initialize', async () => {
    const access = { authenticate: vi.fn(async () => scope) }
    const server = (await startMcp(fakeInfra(), access)).getHttpServer()
    for (const version of ['2026-07-28', token]) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-protocol-version', version)
        .set('mcp-method', 'server/discover')
        .send({ jsonrpc: '2.0', id: 1, method: 'server/discover' })
      expect(res.status).toBe(400)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      // A client of the rmcp library (rmcp-client http_client_adapter.rs,
      // has_legacy_fallback_evidence; measured in P6) retries with legacy initialize only on a
      // null id, -32000 and this exact SDK-shaped text whose versions are all dates before
      // 2026-07-28 and include one it knows.
      expect(res.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32000 } })
      const listed =
        /^Bad Request: Unsupported protocol version \(supported versions: (.+)\)$/.exec(
          res.body.error.message,
        )
      expect(listed, res.body.error.message).not.toBeNull()
      const versions = listed![1]!.split(', ')
      expect(versions).toContain('2025-06-18')
      for (const listedVersion of versions) {
        expect(listedVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(listedVersion < '2026-07-28').toBe(true)
      }
      expect(JSON.stringify(res.body)).not.toContain(version)
    }
    expect(access.authenticate).not.toHaveBeenCalled()
  })

  it('rejects batches, unsafe keys, unsupported tools and deeply nested input', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()
    const bodies = [
      [initialize],
      { ...initialize, params: JSON.parse('{"__proto__":{"x":1}}') },
      { ...initialize, method: 'resources/read' },
      {
        ...initialize,
        params: { ...initialize.params, capabilities: { experimental: { [token]: 'invalid' } } },
      },
      {
        ...initialize,
        params: {
          ...initialize.params,
          clientInfo: { name: { [token]: 'invalid' }, version: '1' },
        },
      },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: { [token]: 'invalid' } } },
      {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: { [token]: 'invalid' } },
      },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: token, arguments: {} } },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'site_info', arguments: { [token]: 'untrusted' } },
      },
      { ...initialize, params: JSON.parse(`${'{"x":'.repeat(17)}0${'}'.repeat(17)}`) },
    ]
    for (const body of bodies) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(body)
      expect(JSON.stringify(res.body)).not.toContain(token)
      expect(res.status).toBe(400)
    }
  })

  it('answers unsupported methods and body encodings with fixed 4xx before authorization', async () => {
    const access = { authenticate: vi.fn(async () => null) }
    const server = (await startMcp(fakeInfra(), access)).getHttpServer()
    for (const method of ['put', 'patch', 'options'] as const) {
      const res = await request(server)[method](MCP_ENDPOINT)
      expect(res.status, method).toBe(405)
      expect(res.headers.allow).toBe('GET, POST, DELETE')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'MCP method is not allowed' },
      })
    }
    for (const [name, value] of [
      ['Content-Type', 'application/json; charset=latin1'],
      ['Content-Encoding', 'zstd'],
    ] as const) {
      const res = await request(server)
        .post(MCP_ENDPOINT)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .set(name, value)
        .send(JSON.stringify(initialize))
      expect(res.status, value).toBe(415)
      expect(res.body.error.message).toBe('Unsupported MCP request encoding')
      expect(JSON.stringify(res.body)).not.toMatch(/latin1|zstd|mcp_/i)
      expect(res.headers['cache-control']).toBe('no-store')
    }
    expect(access.authenticate).not.toHaveBeenCalled()
  })

  it('bounds raw JSON before dispatch and never reflects malformed input', async () => {
    const server = (await startMcp(fakeInfra())).getHttpServer()
    for (const [path, body, status, message] of [
      [MCP_ENDPOINT, `{"private":"${token}",`, 400, 'Invalid MCP request'],
      [`${MCP_ENDPOINT}/`, `{"private":"${token}",`, 400, 'Invalid MCP request'],
      ['/MCP', `{"private":"${token}",`, 400, 'Invalid MCP request'],
      [
        MCP_ENDPOINT,
        JSON.stringify({ ...initialize, padding: 'x'.repeat(110_000) }),
        413,
        'MCP request is too large',
      ],
    ] as const) {
      const res = await request(server)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send(body)
      expect(res.status).toBe(status)
      expect(res.body.error.message).toBe(message)
      expect(JSON.stringify(res.body)).not.toContain(token)
      expect(res.headers['cache-control']).toBe('no-store')
    }
    const res = await request(server)
      .post(`${MCP_ENDPOINT}?siteId=foreign`)
      .set('Authorization', `Bearer ${token}`)
      .send(initialize)
    expect(res.status).toBe(400)
  })
})
