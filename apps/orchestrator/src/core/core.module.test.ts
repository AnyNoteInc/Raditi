import type { INestApplication, LoggerService } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { AgentDriverRegistry } from '@repo/agent-drivers'
import type { JobQueue, SandboxProvider, TurnExecutor } from '@repo/domain'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OutboxRelayService } from '../outbox/outbox-relay.service.ts'
import type { CoreConfig } from '../config/config.ts'
import { hashRunnerToken, parseRunnerTokens } from '../config/runner-tokens.ts'
import { AGENT_DRIVERS, JOB_QUEUE, SANDBOX_PROVIDER, TURN_EXECUTOR } from '../infra/tokens.ts'
import { RunnerApiServer } from '../runner-api/runner-api.server.ts'
import {
  fakeInfra,
  overrideCoreInfra,
  TEST_METRICS_TOKEN,
  testCoreConfig,
  type FakeInfra,
} from '../testing/fakes.ts'
import { CoreModule } from './core.module.ts'

let app: INestApplication | undefined

async function startCore(
  infra: FakeInfra,
  logger: LoggerService | false = false,
  config: CoreConfig = testCoreConfig(),
): Promise<INestApplication> {
  const builder = Test.createTestingModule({
    imports: [CoreModule.forRoot({ config, background: false })],
  })
  const moduleRef = await overrideCoreInfra(builder, infra).compile()
  app = moduleRef.createNestApplication({ logger })
  await app.init()
  return app
}

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('CoreModule', () => {
  it('answers /health 200 with public status only and disables caching', async () => {
    const server = (await startCore(fakeInfra())).getHttpServer()

    const res = await request(server).get('/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('answers /health 503 without exposing dependencies to anonymous callers', async () => {
    const infra = fakeInfra({ database: false, missingBuckets: ['logs'], vault: 'sealed' })
    const server = (await startCore(infra)).getHttpServer()

    const res = await request(server).get('/health')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({ status: 'degraded' })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it.each([false, true])(
    'reveals health details only with METRICS_TOKEN (degraded=%s)',
    async (degraded) => {
      const server = (await startCore(fakeInfra({ database: !degraded }))).getHttpServer()

      for (const token of ['Bearer wrong-token', `Basic ${TEST_METRICS_TOKEN}`]) {
        const res = await request(server).get('/health').set('Authorization', token)
        expect(res.status).toBe(degraded ? 503 : 200)
        expect(res.body).toEqual({ status: degraded ? 'degraded' : 'ok' })
        expect(res.headers['cache-control']).toBe('no-store')
      }

      const res = await request(server)
        .get('/health')
        .set('Authorization', `Bearer ${TEST_METRICS_TOKEN}`)
      expect(res.status).toBe(degraded ? 503 : 200)
      expect(res.body).toEqual({
        status: degraded ? 'degraded' : 'ok',
        checks: { database: degraded ? 'fail' : 'ok', redis: 'ok', s3: 'ok', vault: 'ok' },
      })
      expect(res.headers['cache-control']).toBe('no-store')
    },
  )

  it('checks only the buckets of the core role on /health', async () => {
    const infra = fakeInfra({ missingBuckets: ['backups', 'platform'] })
    const server = (await startCore(infra)).getHttpServer()

    const res = await request(server)
      .get('/health')
      .set('Authorization', `Bearer ${TEST_METRICS_TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.checks.s3).toBe('ok')
    expect(infra.storage.checkBuckets).toHaveBeenCalledWith([
      'inbox',
      'sessions',
      'logs',
      'artifacts',
    ])
  })

  it('answers /health 503 with every check failed when nothing is reachable', async () => {
    const infra = fakeInfra({
      database: false,
      redis: false,
      missingBuckets: ['inbox'],
      vault: 'down',
    })
    const server = (await startCore(infra)).getHttpServer()

    const res = await request(server)
      .get('/health')
      .set('Authorization', `Bearer ${TEST_METRICS_TOKEN}`)

    expect(res.status).toBe(503)
    expect(res.body.checks).toEqual({ database: 'fail', redis: 'fail', s3: 'fail', vault: 'fail' })
  })

  it('reuses one /health report for a few seconds instead of probing on every request', async () => {
    const infra = fakeInfra()
    const server = (await startCore(infra)).getHttpServer()

    for (let i = 0; i < 3; i++) expect((await request(server).get('/health')).status).toBe(200)

    expect(infra.prisma.$queryRaw).toHaveBeenCalledOnce()
    expect(infra.redis.ping).toHaveBeenCalledOnce()
  })

  it('logs an unavailable dependency by name, without the details reaching the response', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const server = (await startCore(fakeInfra({ vault: 'down' }), logger)).getHttpServer()

    const res = await request(server).get('/health')

    expect(res.body).toEqual({ status: 'degraded' })
    const lines = logger.warn.mock.calls.filter(([line]) => String(line).includes('unavailable'))
    expect(lines).toEqual([['vault is unavailable: connect ECONNREFUSED', 'HealthController']])
  })

  it('protects /metrics with the bearer METRICS_TOKEN', async () => {
    const server = (await startCore(fakeInfra())).getHttpServer()

    expect((await request(server).get('/metrics')).status).toBe(401)
    expect(
      (await request(server).get('/metrics').set('Authorization', 'Bearer wrong-token')).status,
    ).toBe(401)

    const res = await request(server)
      .get('/metrics')
      .set('Authorization', `Bearer ${TEST_METRICS_TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.text).toMatch(/process_cpu_user_seconds_total\{app="orchestrator"\}/)
  })

  it('does not serve the MCP endpoint', async () => {
    const server = (await startCore(fakeInfra())).getHttpServer()

    expect((await request(server).post('/mcp').send({})).status).toBe(404)
  })

  it('wires the ports: job queue, agent drivers, sandbox provider, relay', async () => {
    const infra = fakeInfra()
    const core = await startCore(infra)

    const drivers = core.get<AgentDriverRegistry>(AGENT_DRIVERS)
    expect(drivers.list().map((driver) => driver.id)).toEqual(['codex', 'kimi'])
    expect(drivers.has('qwen')).toBe(false)
    expect(core.get<SandboxProvider>(SANDBOX_PROVIDER).kind).toBe('docker')
    expect(core.get(OutboxRelayService)).toBeInstanceOf(OutboxRelayService)

    await core.get<JobQueue>(JOB_QUEUE).enqueue('notifications', 'auth.welcome', { a: 1 })
    expect(infra.queue.add).toHaveBeenCalledWith('auth.welcome', { a: 1 }, {})
  })

  it('runs turns in core by default and on runner VMs behind their own port', async () => {
    expect((await startCore(fakeInfra())).get<TurnExecutor>(TURN_EXECUTOR).kind).toBe('local')
    await app?.close()

    const token = `rnr_sandbox-1.${'a'.repeat(43)}`
    const core = await startCore(fakeInfra(), false, {
      ...testCoreConfig(),
      turnExecutor: 'runner',
      runnerApi: {
        port: 0,
        tokens: parseRunnerTokens(`sandbox-1:${hashRunnerToken(token)}`).hashes,
      },
    })
    expect(core.get<TurnExecutor>(TURN_EXECUTOR).kind).toBe('runner')
    // Core drives no Docker of its own then: the runners do.
    expect(() => core.get(SANDBOX_PROVIDER)).toThrow()
    const { port } = await core.get(RunnerApiServer).listen(0, '127.0.0.1')
    const poll = (authorization: string) =>
      fetch(`http://127.0.0.1:${port}/runner/v1/reconcile`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ runnerSession: crypto.randomUUID(), inventory: [] }),
      })
    expect((await poll('Bearer wrong')).status).toBe(401)
    // The runner API is not on the main port.
    expect((await request(core.getHttpServer()).post('/runner/v1/reconcile')).status).toBe(404)
    await core.close()
    app = undefined
    await expect(poll(`Bearer ${token}`)).rejects.toThrow()
  })

  it('closes its connections on shutdown without errors', async () => {
    const infra = fakeInfra()
    // Nest logs (and swallows) errors thrown by shutdown hooks.
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const core = await startCore(infra, logger)

    await core.close()
    app = undefined

    expect(logger.error).not.toHaveBeenCalled()
    expect(infra.prisma.$disconnect).toHaveBeenCalledOnce()
    expect(infra.redis.quit).toHaveBeenCalledOnce()
  })
})
