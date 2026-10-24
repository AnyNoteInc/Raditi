import { ListToolsResultSchema } from '@modelcontextprotocol/core'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { browserTaskCodes, browserTaskError, browserToolNames } from '@repo/domain'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MCP_ACCESS, type McpAccess } from '../access/mcp-access.ts'
import { AppModule } from '../app.module.ts'
import type { McpConfig } from '../config/config.ts'
import { MCP_ENDPOINT } from '../server/mcp-runtime.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import type { McpBrowserTasks } from '../site-info/browser-tasks.ts'
import { MCP_BROWSER_TASKS } from '../site-info/site-info.tokens.ts'
import { fakeInfra, testMcpConfig } from '../testing/fakes.ts'
import { McpWebService } from './mcp-web.ts'
import { MCP_WEB } from './web.tokens.ts'

// The cloud browser of a task (docs/plan/57-browser-tasks.md, Б20): the `web` tools go to a task
// that needs a browser, wherever the worker is configured — production too —, and to no other.

let app: INestApplication | undefined
const token = `mcp_${'c'.repeat(64)}`
const webTools = [...browserToolNames].sort()

const scopeOf = (requirements: McpAccess['requirements']): McpAccess => ({
  keyId: '01960000-0000-7000-8000-000000000001',
  taskId: '01960000-0000-7000-8000-000000000002',
  workspaceId: '01960000-0000-7000-8000-000000000003',
  siteId: '01960000-0000-7000-8000-000000000004',
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 1,
  stack: 'wordpress',
  url: 'https://site.example.test/',
  preview: null,
  ...(requirements === undefined ? {} : { requirements }),
})
const browserTask = scopeOf({ repository: false, browser: true })

/** The worker beside the role; no profile of its own, no S3. */
const config = (overrides: Partial<McpConfig> = {}): McpConfig => ({
  ...testMcpConfig(),
  browserWorker: { url: 'http://127.0.0.1:9', token: 'w'.repeat(48) },
  ...overrides,
})

function fakes() {
  return {
    web: { call: vi.fn<McpWebService['call']>(async (_scope, tool) => ({ tool, ok: 1 })) },
    tasks: {
      startPath: vi.fn<McpBrowserTasks['startPath']>(() => '/wp-admin/edit.php'),
      controller: vi.fn<McpBrowserTasks['controller']>(async () => 'user'),
    },
  }
}

async function start(scope: McpAccess, roleConfig = config(), doubles = fakes()) {
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(roleConfig)] })
    .overrideProvider(PRISMA)
    .useValue(fakeInfra().prisma)
    .overrideProvider(SECRET_STORE)
    .useValue(fakeInfra().secrets)
    .overrideProvider(MCP_ACCESS)
    .useValue({ authenticate: async (value: string) => (value === token ? scope : null) })
    .overrideProvider(MCP_BROWSER_TASKS)
    .useValue(doubles.tasks)
  if (roleConfig.browserWorker) builder = builder.overrideProvider(MCP_WEB).useValue(doubles.web)
  const moduleRef = await builder.compile()
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
  const list = () => post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const names = async () =>
    ((await list()).body.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort()
  const call = (name: string, args?: object) =>
    post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, ...(args === undefined ? {} : { arguments: args }) },
    })
  return { list, names, call, doubles }
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('the web tools of the mcp role', () => {
  it('offers them to a browser task where the worker is configured, each a strict object', async () => {
    const { names, list } = await start(browserTask)
    expect(await names()).toEqual(['site_info', ...webTools].sort())
    const result = (await list()).body.result
    // A client that checks the list against the MCP schema rejects the whole list otherwise.
    expect(ListToolsResultSchema.safeParse(result).success).toBe(true)
    for (const tool of result.tools as Array<{
      name: string
      description: string
      inputSchema: { type: string; additionalProperties?: boolean }
      annotations: Record<string, boolean>
      _meta?: unknown
    }>) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' })
      expect(tool._meta, tool.name).toEqual({ securitySchemes: [{ type: 'noauth' }] })
      if (!tool.name.startsWith('web_')) continue
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false)
      expect(tool.annotations, tool.name).toMatchObject({ openWorldHint: false })
      // Written for the model: English, short enough to read every turn.
      expect(tool.description.length, tool.name).toBeLessThan(1_000)
      expect(tool.description, tool.name).not.toMatch(/[а-яё]{3}/i)
      // The same for every stack (CLAUDE.md rule 8): its pages and editor are the guide's.
      expect(tool.description, tool.name).not.toMatch(/wp-|wordpress|bitrix|block editor/i)
    }
    const described = Object.fromEntries(
      (result.tools as Array<{ name: string; description: string }>).map((tool) => [
        tool.name,
        tool.description,
      ]),
    )
    expect(described.web_observe).toMatch(/untrusted/)
    expect(described.web_observe).toMatch(/expire/)
    expect(described.web_observe).toMatch(/web_help/)
    expect(described.web_help).toMatch(/end the turn/i)
    expect(described.web_click).toMatch(/web_verify/)
  })

  it('offers them to no other task, and nowhere without the worker', async () => {
    expect(await (await start(scopeOf({ repository: true, browser: false }))).names()).toEqual([
      'site_info',
    ])
    await app?.close()
    // A scope made before requirements is a repository task.
    expect(await (await start(scopeOf(undefined))).names()).toEqual(['site_info'])
    await app?.close()
    expect(await (await start(browserTask, config({ browserWorker: null }))).names()).toEqual([
      'site_info',
    ])
  })

  it('opens in production: the cloud browser is the product, not a local profile', async () => {
    const { names } = await start(browserTask, config({ appEnv: 'production' }))
    expect(await names()).toEqual(['site_info', ...webTools].sort())
  })

  it('calls the service with the scope of the token and the checked arguments', async () => {
    const { call, doubles } = await start(browserTask)
    const answer = await call('web_click', { observation: 'o2', ref: 'f1e5' })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body.result.content[0].text)).toEqual({ ok: 1, tool: 'web_click' })
    expect(doubles.web.call).toHaveBeenCalledExactlyOnceWith(browserTask, 'web_click', {
      observation: 'o2',
      ref: 'f1e5',
    })
    // A tool whose arguments are all optional goes without them.
    expect((await call('web_observe')).status).toBe(200)
    expect(doubles.web.call).toHaveBeenLastCalledWith(browserTask, 'web_observe', {})
    // Arguments past the domain's schema never reach the service.
    for (const [name, args] of [
      ['web_click', { observation: 'o2', ref: 'e1', sessionId: browserTask.taskId }],
      ['web_fill', { observation: 'o2', ref: 'e1' }],
      ['web_evaluate', { expression: 'document.cookie' }],
      ['browser_navigate', { path: '/' }],
    ] as const)
      expect((await call(name, args)).status, name).toBe(400)
    expect(doubles.web.call).toHaveBeenCalledTimes(2)
  })

  it('answers a refusal with its fixed code and text, and nothing else of an error', async () => {
    const doubles = fakes()
    doubles.web.call
      .mockRejectedValueOnce(browserTaskError('BROWSER_STALE_OBSERVATION'))
      .mockRejectedValueOnce(new Error('page of anna@example.test at https://site.example.test/x'))
    const { call } = await start(browserTask, config(), doubles)
    const stale = await call('web_click', { observation: 'o1', ref: 'e1' })
    expect(stale.body.result).toMatchObject({ isError: true })
    expect(JSON.parse(stale.body.result.content[0].text)).toEqual({
      code: 'BROWSER_STALE_OBSERVATION',
      message: browserTaskCodes.BROWSER_STALE_OBSERVATION.message,
    })
    const failed = await call('web_observe', {})
    expect(JSON.parse(failed.body.result.content[0].text)).toEqual({
      code: 'BROWSER_ACTION_FAILED',
      message: browserTaskCodes.BROWSER_ACTION_FAILED.message,
    })
    expect(JSON.stringify(failed.body)).not.toMatch(/anna|site\.example\.test\/x/)
  })

  it('tells a browser task where its browser works and who drives it', async () => {
    const { call, doubles } = await start(browserTask, config({ browserWorker: null }))
    const info = JSON.parse((await call('site_info')).body.result.content[0].text)
    expect(info).toEqual({
      url: 'https://site.example.test/',
      stack: 'wordpress',
      browser: {
        siteUrl: 'https://site.example.test/',
        startPath: '/wp-admin/edit.php',
        controller: 'user',
      },
    })
    expect(doubles.tasks.controller).toHaveBeenCalledWith(browserTask.taskId)
    await app?.close()
    // A repository task is told what it was told before.
    const repository = await start(scopeOf({ repository: true, browser: false }))
    expect(JSON.parse((await repository.call('site_info')).body.result.content[0].text)).toEqual({
      url: 'https://site.example.test/',
      stack: 'wordpress',
    })
    expect(repository.doubles.tasks.controller).not.toHaveBeenCalled()
  })

  it('says the browser cannot be read rather than guess who drives it', async () => {
    const doubles = fakes()
    doubles.tasks.controller.mockRejectedValueOnce(new Error('db.internal refused'))
    const { call } = await start(browserTask, config(), doubles)
    const answer = await call('site_info')
    expect(answer.body.result).toMatchObject({ isError: true })
    expect(JSON.stringify(answer.body)).not.toContain('db.internal')
  })

  it('takes the start of the browser from the policy of the stack', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(config({ browserWorker: null }))],
    })
      .overrideProvider(PRISMA)
      .useValue(fakeInfra().prisma)
      .overrideProvider(SECRET_STORE)
      .useValue(fakeInfra().secrets)
      .compile()
    const tasks = moduleRef.get<McpBrowserTasks>(MCP_BROWSER_TASKS)
    expect(tasks.startPath(browserTask)).toBe('/wp-admin/edit.php')
    expect(tasks.startPath({ ...browserTask, url: 'https://site.example.test/blog/' })).toBe(
      '/blog/wp-admin/edit.php',
    )
    // A stack with no adapter yet has no start to name.
    expect(tasks.startPath({ ...browserTask, stack: 'static' })).toBeNull()
    await moduleRef.close()
  })

  it('composes the service with the client of the configured worker', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config())] })
      .overrideProvider(PRISMA)
      .useValue(fakeInfra().prisma)
      .overrideProvider(SECRET_STORE)
      .useValue(fakeInfra().secrets)
      .compile()
    expect(moduleRef.get(MCP_WEB)).toBeInstanceOf(McpWebService)
    await moduleRef.close()
  })
})
