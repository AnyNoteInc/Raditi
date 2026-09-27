import type { AddressInfo } from 'node:net'

import type { INestApplication } from '@nestjs/common'
import { isDomainError } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrchestratorConfig } from './config/config.ts'
import { LOCAL_HOST, listenHost, startMcp, startRoles, type RoleStarters } from './roles.ts'
import { testCoreConfig, testMcpConfig, testRunnerConfig } from './testing/fakes.ts'

const fakeApp = () =>
  ({ close: vi.fn().mockResolvedValue(undefined) }) as unknown as INestApplication

function starters(overrides: Partial<RoleStarters> = {}) {
  return {
    core: vi.fn<RoleStarters['core']>().mockResolvedValue(fakeApp()),
    mcp: vi.fn<RoleStarters['mcp']>().mockResolvedValue(fakeApp()),
    runner: vi.fn<RoleStarters['runner']>().mockResolvedValue(fakeApp()),
    ...overrides,
  }
}

const devConfig = (overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig => ({
  appEnv: 'test',
  roles: ['core', 'mcp'],
  core: testCoreConfig(),
  mcp: testMcpConfig(),
  runner: null,
  ...overrides,
})

const rejectsNotImplemented = (promise: Promise<unknown>, pattern: RegExp) =>
  expect(promise).rejects.toSatisfy(
    (err) => isDomainError(err) && err.code === 'NOT_IMPLEMENTED' && pattern.test(err.message),
  )

describe('startRoles', () => {
  it('starts the runner role on its own, without the HTTP roles', async () => {
    const start = starters()
    const runner = testRunnerConfig()

    await startRoles(devConfig({ roles: ['runner'], core: null, mcp: null, runner }), start)

    expect(start.runner).toHaveBeenCalledWith(runner)
    expect(start.core).not.toHaveBeenCalled()
    expect(start.mcp).not.toHaveBeenCalled()
  })

  it('refuses the mcp role in production until the per-task token check exists', async () => {
    const start = starters()
    const config = devConfig({
      appEnv: 'production',
      roles: ['mcp'],
      core: null,
      mcp: { ...testMcpConfig(), appEnv: 'production' },
    })

    await rejectsNotImplemented(startRoles(config, start), /mcp role in production.*P6/)

    expect(start.mcp).not.toHaveBeenCalled()
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
