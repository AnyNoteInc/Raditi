import { ListToolsResultSchema } from '@modelcontextprotocol/core'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DomainError, type PreviewStatus } from '@repo/domain'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import { memoryStorage } from '@repo/snapshots/testing'

import type { McpConfig } from './config/config.ts'
import { fakeInfra, testMcpConfig } from './testing/fakes.ts'
import { MCP_CONTENT_STORAGE } from './storage/content-storage.ts'
import { MCP_ACCESS, type McpAccess } from './access/mcp-access.ts'
import { AppModule } from './app.module.ts'
import { MCP_BROWSER, type McpBrowserService } from './browser/mcp-browser.ts'
import { MCP_CONTENT, type McpContentService } from './content/mcp-content.ts'
import { MCP_ENDPOINT } from './server/mcp-runtime.ts'
import { mountMcp } from './server/mount-mcp.ts'
import { siteInfoOf } from './site-info/mcp-tools.controller.ts'

// The tools a request is offered follow its dialog (docs/plan/53-chat-preview-release.md, Р3,
// Р4, Р21): content into a preview with its own database, the browser on an open preview, and
// nothing of either for a dialog without one where previews are configured.

let app: INestApplication | undefined
const token = `mcp_${'b'.repeat(64)}`
const HOST = 'site-0a1b2c3d-chat-0a1b2c.localhost'
const address = { baseDomain: 'localhost', scheme: 'http' as const, publicPort: 8090 }
const browserTools = [
  'browser_click',
  'browser_console',
  'browser_expect',
  'browser_fill',
  'browser_navigate',
  'browser_network',
  'browser_run_checks',
  'browser_screenshot',
  'browser_snapshot',
]

const scopeOf = (preview: McpAccess['preview']): McpAccess => ({
  keyId: '01960000-0000-7000-8000-000000000001',
  taskId: '01960000-0000-7000-8000-000000000002',
  workspaceId: '01960000-0000-7000-8000-000000000003',
  siteId: '01960000-0000-7000-8000-000000000004',
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 1,
  stack: 'wordpress',
  url: 'https://site.example.test',
  preview,
})
/** A preview whose build found the text of records writable alone (`runtime.db.kinds`). */
const previewOf = (status: PreviewStatus, database = true) => ({
  id: '01960000-0000-7000-8000-000000000005',
  status,
  database,
  hostname: HOST,
  dbKinds: ['content_update' as const],
})

/** Both profiles of the role on a machine with previews; no S3 or browser is ever contacted. */
const config = (overrides: Partial<McpConfig> = {}): McpConfig => ({
  ...testMcpConfig(),
  contentProfile: 'local',
  browserProfile: 'local',
  storage: {
    endpoint: 'http://127.0.0.1:9',
    region: 'us-east-1',
    accessKeyId: 'synthetic',
    secretAccessKey: 'synthetic-secret',
    forcePathStyle: true,
    buckets: { artifacts: 'raditi-test-artifacts' },
  },
  preview: address,
  ...overrides,
})

function stubs() {
  return {
    content: {
      wpRest: vi.fn<McpContentService['wpRest']>(async () => ({
        result: 'ok',
        response: { objectRef: 'page:42', updated: true },
      })),
      restore: vi.fn<McpContentService['restore']>(async () => ({ result: 'ok', response: {} })),
    },
    browser: {
      navigate: vi.fn<McpBrowserService['navigate']>(async (_scope, args) => ({
        path: args.path,
        title: 'Главная',
        status: 200,
      })),
      snapshot: vi.fn<McpBrowserService['snapshot']>(async () => ({ text: '- heading' })),
      runChecks: vi.fn<McpBrowserService['runChecks']>(async () => ({ total: 1 })),
    },
  }
}

async function start(scope: McpAccess, fakes = stubs(), roleConfig = config()) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(roleConfig)] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue({ authenticate: async (value: string) => (value === token ? scope : null) })
    .overrideProvider(MCP_CONTENT_STORAGE)
    .useValue(memoryStorage().storage)
    .overrideProvider(MCP_CONTENT)
    .useValue(fakes.content)
    .overrideProvider(MCP_BROWSER)
    .useValue(fakes.browser)
    .compile()
  app = moduleRef.createNestApplication({ logger: false })
  await mountMcp(app)
  await app.listen(0, '127.0.0.1')
  const server = app.getHttpServer()
  const post = (body: object) =>
    request(server)
      .post(MCP_ENDPOINT)
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-protocol-version', '2025-06-18')
      .send(body)
  const names = async () =>
    (
      (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools as Array<{
        name: string
      }>
    )
      .map((tool) => tool.name)
      .sort()
  const call = (name: string, args: object = {}) =>
    post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  return { post, names, call, fakes }
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('MCP tools of a dialog with a preview', () => {
  it('offers content and the browser on a preview with its database', async () => {
    const { names, post } = await start(scopeOf(previewOf('ready')))
    expect(await names()).toEqual(['restore', 'site_info', ...browserTools, 'wp_rest'].sort())
    // Before any build has said what the preview's database takes, `db_schema` is offered: the
    // CLI asks for its tools once, as the first turn starts beside the build.
    const { dbKinds: _unsaid, ...unbuilt } = previewOf('building')
    expect(await (await start(scopeOf(unbuilt))).names()).toContain('db_schema')
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    // A client that checks the list against the MCP schema rejects the whole list otherwise.
    expect(ListToolsResultSchema.safeParse(list.body.result).success).toBe(true)
    for (const tool of list.body.result.tools as Array<{
      name: string
      inputSchema: { type: string }
      annotations: Record<string, boolean>
      _meta?: unknown
    }>) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' })
      // A family is no OAuth scope: every tool says what it said before families existed.
      expect(tool._meta, tool.name).toEqual({ securitySchemes: [{ type: 'noauth' }] })
      if (tool.name.startsWith('browser_'))
        expect(tool.annotations, tool.name).toMatchObject({
          readOnlyHint: ['browser_click', 'browser_fill'].includes(tool.name) ? false : true,
          openWorldHint: false,
        })
    }
  })

  it('offers no content to a preview without a database and nothing to a dialog without a preview', async () => {
    expect(await (await start(scopeOf(previewOf('ready', false)))).names()).toEqual(
      ['site_info', ...browserTools].sort(),
    )
    await app?.close()
    // Previews are configured here: a dialog without one never writes the site (Р3).
    expect(await (await start(scopeOf(null))).names()).toEqual(['site_info'])
    await app?.close()
    expect(await (await start(scopeOf(previewOf('destroyed')))).names()).toEqual(['site_info'])
  })

  it('keeps the browser tools out while the browser profile is off', async () => {
    const { names } = await start(
      scopeOf(previewOf('ready')),
      stubs(),
      config({ browserProfile: 'off' }),
    )
    expect(await names()).toEqual(['restore', 'site_info', 'wp_rest'])
  })

  it('calls the browser with the scope of the token and refuses a tool of another family', async () => {
    const scope = scopeOf(previewOf('ready', false))
    const { call, fakes } = await start(scope)
    const opened = await call('browser_navigate', { path: '/about/' })
    expect(opened.status).toBe(200)
    expect(JSON.parse(opened.body.result.content[0].text)).toEqual({
      path: '/about/',
      status: 200,
      title: 'Главная',
    })
    expect(fakes.browser.navigate).toHaveBeenCalledExactlyOnceWith(scope, { path: '/about/' })
    // This dialog's preview has no database: wp_rest is no tool of its request.
    expect((await call('wp_rest', { method: 'GET', route: '/wp/v2/pages/42' })).status).toBe(400)
    expect(fakes.content.wpRest).not.toHaveBeenCalled()
  })

  it('passes fixed browser codes to the agent and nothing else of an error', async () => {
    const fakes = stubs()
    fakes.browser.snapshot
      .mockRejectedValueOnce(new DomainError('BROWSER_SYNC_TIMEOUT', 'synthetic', 503))
      .mockRejectedValueOnce(new Error('page of anna@example.test said no'))
    const { call } = await start(scopeOf(previewOf('ready')), fakes)
    const timedOut = await call('browser_snapshot')
    expect(timedOut.body.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: '{"code":"BROWSER_SYNC_TIMEOUT"}' }],
    })
    const failed = await call('browser_snapshot')
    expect(failed.body.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: '{"code":"BROWSER_CALL_REJECTED"}' }],
    })
    expect(JSON.stringify(failed.body)).not.toContain('anna@example.test')
  })

  it('tells the agent where its preview answers and the address links keep', async () => {
    const { call } = await start(scopeOf(previewOf('ready')))
    const info = JSON.parse((await call('site_info')).body.result.content[0].text)
    expect(info).toEqual({
      url: `http://${HOST}:8090`,
      siteUrl: 'https://site.example.test',
      stack: 'wordpress',
      preview: 'ready',
      database: { operations: ['content_update'] },
    })
    expect(siteInfoOf(scopeOf(previewOf('building')), address)).toMatchObject({
      url: null,
      preview: 'building',
    })
    // Without previews configured the role knows no preview address either.
    expect(siteInfoOf(scopeOf(previewOf('ready')), null)).toMatchObject({ url: null })
    expect(siteInfoOf(scopeOf(null), address)).toEqual({
      url: 'https://site.example.test',
      stack: 'wordpress',
    })
  })

  it('refuses a browser profile in production, without previews, without storage or a seam without it', () => {
    expect(() =>
      AppModule.forRoot(config({ contentProfile: 'off', appEnv: 'production' })),
    ).toThrow('Local MCP browser profile cannot run in production')
    expect(() => AppModule.forRoot(config({ preview: null }))).toThrow(
      'MCP browser profile needs previews (PREVIEW_BASE_DOMAIN)',
    )
    expect(() => AppModule.forRoot(config({ contentProfile: 'off', storage: null }))).toThrow(
      'MCP browser profile needs its S3 settings',
    )
    expect(() =>
      AppModule.forRoot(config({ browserProfile: 'off' }), {
        browserFactory: { connect: vi.fn() },
      }),
    ).toThrow('MCP browser test seams need the browser profile')
  })

  it('writes content where its profile says: previews with local, the site only without them', () => {
    expect(() => AppModule.forRoot(config({ browserProfile: 'off', preview: null }))).toThrow(
      'MCP content profile local writes into previews (PREVIEW_BASE_DOMAIN)',
    )
    expect(() =>
      AppModule.forRoot(config({ browserProfile: 'off', contentProfile: 'local-site' })),
    ).toThrow('MCP content profile local-site is refused beside previews')
    expect(() =>
      AppModule.forRoot(
        config({ browserProfile: 'off', contentProfile: 'local-site', preview: null }),
      ),
    ).not.toThrow()
  })
})
