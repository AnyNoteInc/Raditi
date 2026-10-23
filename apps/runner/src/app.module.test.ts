import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Test } from '@nestjs/testing'
import { labels } from '@repo/local-turns/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppModule } from './app.module.ts'
import { HttpRunnerTransport } from './core-api/core-client.ts'
import { RunnerReconciler } from './reconciler/runner-reconciler.ts'
import { SANDBOX_PROVIDER } from './sandbox/sandbox.tokens.ts'
import { SandboxRunner } from './sandbox-runner/sandbox-runner.ts'
import { testRunnerConfig } from './testing/config.ts'
import { fakeCoreServer } from './testing/fake-core-server.ts'
import { RUNNER_ID, RUNNER_TOKEN } from './vm-token/vm-token.tokens.ts'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** The VM token of runner `sandbox-1` in a file the way the VM holds it. */
async function tokenFile() {
  const dir = await mkdtemp(join(tmpdir(), 'raditi-runner-module-'))
  closers.push(() => rm(dir, { recursive: true, force: true }))
  const token = `rnr_sandbox-1.${randomBytes(32).toString('base64url')}`
  const path = join(dir, 'runner-token')
  await writeFile(path, `${token}\n`, { mode: 0o400 })
  return { token, path }
}

describe('AppModule', () => {
  it('polls core with the VM token from its file, reconciles its containers and opens no port', async () => {
    const { token, path } = await tokenFile()
    // Core finds no owner for the container the runner reports.
    const core = await fakeCoreServer({ token, remove: () => ['container1'] })
    closers.push(() => core.close())
    const container = { id: 'container1', labels: { ...labels, leaseEpoch: 1 } }
    const docker = {
      kind: 'docker' as const,
      create: vi.fn(),
      get: vi.fn(async () => null),
      getForRemoval: vi.fn(async () => null),
      list: vi.fn(async () => [{ ...container, createdAt: new Date() }]),
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(testRunnerConfig({ coreUrl: core.url, tokenFile: path }))],
    })
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(docker)
      .compile()
    closers.push(() => moduleRef.close())
    await moduleRef.init()
    // Its turn containers carry the runner id the token names.
    expect(moduleRef.get(RUNNER_ID)).toBe('sandbox-1')

    // The poll brought the inventory; the reconcile at start removes what core named.
    await vi.waitFor(() => expect(core.polls).toHaveLength(1))
    const session = moduleRef.get(SandboxRunner).session
    expect(session).toMatch(/^[0-9a-f-]{36}$/)
    expect(core.polls[0]).toMatchObject({
      runnerSession: session,
      capacity: 1,
      inventory: [{ containerId: container.id, labels: container.labels }],
    })
    await vi.waitFor(() => expect(docker.getForRemoval).toHaveBeenCalledWith('container1'))
    expect(core.reconciles).toMatchObject([{ runnerSession: session }])
    expect(core.unauthorized).toBe(0)
    await moduleRef.close()
    closers.pop()
  })

  it('starts polling before the reconciler, and stops the reconciler, polling and then the transport', async () => {
    const calls: string[] = []
    // Each stop settles later than it is called: the next one waits for it.
    const stopping = (name: string) =>
      vi.fn(async () => {
        calls.push(`${name} stop`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        calls.push(`${name} stopped`)
      })
    const runner = { start: vi.fn(() => void calls.push('runner start')), stop: stopping('runner') }
    const reconciler = {
      start: vi.fn(() => void calls.push('reconciler start')),
      stop: stopping('reconciler'),
    }
    const transport = { close: vi.fn(() => void calls.push('transport close')) }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(testRunnerConfig())],
    })
      .overrideProvider(SandboxRunner)
      .useValue(runner)
      .overrideProvider(RunnerReconciler)
      .useValue(reconciler)
      .overrideProvider(HttpRunnerTransport)
      .useValue(transport)
      .overrideProvider(RUNNER_TOKEN)
      .useValue(`rnr_sandbox-1.${randomBytes(32).toString('base64url')}`)
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue({})
      .compile()
    await moduleRef.init()
    expect(calls).toEqual(['runner start', 'reconciler start'])
    await moduleRef.close()

    expect(calls).toEqual([
      'runner start',
      'reconciler start',
      'reconciler stop',
      'reconciler stopped',
      'runner stop',
      'runner stopped',
      'transport close',
    ])
  })
})
