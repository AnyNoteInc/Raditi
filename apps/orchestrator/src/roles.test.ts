import type { AddressInfo } from 'node:net'

import type { INestApplication, INestApplicationContext } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestratorConfig } from './config/config.ts'
import { llmConfigFromEnv } from './config/llm-config.ts'
import { PreviewGatewayServer } from './preview-gateway/preview-gateway.server.ts'
import {
  LOCAL_HOST,
  listenHost,
  startMcp,
  startPreview,
  startRoles,
  type RoleStarters,
} from './roles.ts'
import {
  testCoreConfig,
  testMcpConfig,
  testPreviewConfig,
  testRunnerConfig,
} from './testing/fakes.ts'

const fakeApp = () =>
  ({ close: vi.fn().mockResolvedValue(undefined) }) as unknown as INestApplication

function starters(overrides: Partial<RoleStarters> = {}) {
  return {
    core: vi.fn<RoleStarters['core']>().mockResolvedValue(fakeApp()),
    mcp: vi.fn<RoleStarters['mcp']>().mockResolvedValue(fakeApp()),
    runner: vi.fn<RoleStarters['runner']>().mockResolvedValue(fakeApp()),
    llm: vi.fn<RoleStarters['llm']>().mockResolvedValue(fakeApp()),
    preview: vi.fn<RoleStarters['preview']>().mockResolvedValue(fakeApp()),
    ...overrides,
  }
}

const devConfig = (overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig => ({
  appEnv: 'test',
  roles: ['core', 'mcp'],
  core: testCoreConfig(),
  mcp: testMcpConfig(),
  runner: null,
  llm: null,
  preview: null,
  ...overrides,
})

describe('startRoles', () => {
  it('starts llm alone without core, MCP, runner or Redis', async () => {
    const start = starters()
    const llm = {
      ...llmConfigFromEnv({}, 'test'),
      db: testMcpConfig().db,
      vault: testMcpConfig().vault,
      metricsToken: 'test',
    }
    await startRoles(devConfig({ roles: ['llm'], core: null, mcp: null, llm }), start)
    expect(start.llm).toHaveBeenCalledWith(llm)
    expect(start.core).not.toHaveBeenCalled()
    expect(start.mcp).not.toHaveBeenCalled()
    expect(start.runner).not.toHaveBeenCalled()
  })
  it('starts the runner role on its own, without the HTTP roles', async () => {
    const start = starters()
    const runner = testRunnerConfig()

    await startRoles(devConfig({ roles: ['runner'], core: null, mcp: null, runner }), start)

    expect(start.runner).toHaveBeenCalledWith(runner)
    expect(start.core).not.toHaveBeenCalled()
    expect(start.mcp).not.toHaveBeenCalled()
  })

  it('starts the preview gateway alone, without core or Redis', async () => {
    const start = starters()
    const preview = testPreviewConfig()

    await startRoles(devConfig({ roles: ['preview'], core: null, mcp: null, preview }), start)

    expect(start.preview).toHaveBeenCalledWith(preview)
    expect(start.core).not.toHaveBeenCalled()
    expect(start.mcp).not.toHaveBeenCalled()
  })

  it('starts the guarded mcp role alone in production', async () => {
    const start = starters()
    const config = devConfig({
      appEnv: 'production',
      roles: ['mcp'],
      core: null,
      mcp: { ...testMcpConfig(), appEnv: 'production', allowedHosts: ['mcp'] },
    })

    await startRoles(config, start)
    expect(start.mcp).toHaveBeenCalledWith(config.mcp)
    expect(start.core).not.toHaveBeenCalled()
  })

  it('closes the roles already started when the next one fails to start', async () => {
    const core = fakeApp()
    const failure = new Error('listen EADDRINUSE: address already in use 127.0.0.1:8082')
    const start = starters({
      core: vi.fn<RoleStarters['core']>().mockResolvedValue(core),
      mcp: vi.fn<RoleStarters['mcp']>().mockRejectedValue(failure),
    })

    await expect(startRoles(devConfig(), start)).rejects.toBe(failure)

    expect(core.close).toHaveBeenCalledOnce()
  })
})

describe('listenHost', () => {
  it('listens on loopback outside production and on every interface in production', () => {
    expect(listenHost('development')).toBe(LOCAL_HOST)
    expect(listenHost('test')).toBe('127.0.0.1')
    expect(listenHost('production')).toBeUndefined()
  })
})

describe('startMcp', () => {
  let app: INestApplication | undefined

  beforeEach(() => {
    // The role logger writes straight to stdout.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  it('opens its port on 127.0.0.1 only outside production', async () => {
    app = await startMcp({ ...testMcpConfig(), port: 0 })

    expect((app.getHttpServer().address() as AddressInfo).address).toBe('127.0.0.1')
  })
})

describe('startPreview', () => {
  let app: INestApplicationContext | undefined

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  it('opens its port on 127.0.0.1 outside production and answers its health', async () => {
    app = await startPreview({ ...testPreviewConfig(), port: 0 })
    const address = app.get(PreviewGatewayServer).address()
    expect(address?.address).toBe('127.0.0.1')
    const health = await fetch(`http://127.0.0.1:${address?.port}/__raditi/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
  })
})
