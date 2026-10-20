import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testRunnerConfig } from '@repo/runner-engine/testing'

import { hashRunnerToken, parseRunnerTokens } from '../config/runner-tokens.ts'
import { RunnerApiServer } from '../runner-api/runner-api.server.ts'
import { RunnerAuthenticator } from '../runner-api/runner-auth.ts'
import { RunnerHub } from '../runner-api/runner-hub.ts'
import { labels } from '../testing/runner-sandbox.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import {
  RunnerModule,
  runnerSandboxConfig,
  SANDBOX_PROVIDER,
  SandboxRunner,
} from '@repo/runner-engine'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

describe('RunnerModule', () => {
  it('polls core with the VM token from its file, reconciles its containers and opens no port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raditi-runner-module-'))
    closers.push(() => rm(dir, { recursive: true, force: true }))
    const token = `rnr_sandbox-1.${randomBytes(32).toString('base64url')}`
    const tokenFile = join(dir, 'runner-token')
    await writeFile(tokenFile, `${token}\n`, { mode: 0o400 })
    const hub = new RunnerHub({
      assignments: new MemoryTurnAssignments(),
      leases: { assert: vi.fn() },
      logger: { warn: vi.fn() },
    })
    const server = new RunnerApiServer(
      hub,
      new RunnerAuthenticator(parseRunnerTokens(`sandbox-1:${hashRunnerToken(token)}`).hashes),
      { warn: vi.fn() },
    )
    const { port } = await server.listen(0, '127.0.0.1')
    closers.push(() => server.close())
    const docker = {
      kind: 'docker' as const,
      create: vi.fn(),
      get: vi.fn(async () => null),
      getForRemoval: vi.fn(async () => null),
      list: vi.fn(async () => [
        { id: 'container1', labels: { ...labels, leaseEpoch: 1 }, createdAt: new Date() },
      ]),
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        RunnerModule.forRoot(
          testRunnerConfig({ coreUrl: new URL(`http://127.0.0.1:${port}`), tokenFile }),
        ),
      ],
    })
      .overrideProvider(SANDBOX_PROVIDER)
      .useValue(docker)
      .compile()
    closers.push(() => moduleRef.close())
    await moduleRef.init()

    // The poll brought the inventory; the reconcile at start found no owner for the container.
    await vi.waitFor(() => expect(hub.inventory({})).toHaveLength(1))
    await vi.waitFor(() => expect(docker.getForRemoval).toHaveBeenCalledWith('container1'))
    expect(moduleRef.get(SandboxRunner).session).toMatch(/^[0-9a-f-]{36}$/)
    await moduleRef.close()
    closers.pop()
  })

  it('labels its turn containers with the runner id of its VM token', () => {
    const config = testRunnerConfig({ tokenFile: '/etc/raditi/runner-token' })
    const token = `rnr_sandbox-7.${randomBytes(32).toString('base64url')}`
    expect(runnerSandboxConfig(config, token)).toEqual({ ...config.sandbox, runnerId: 'sandbox-7' })
    expect(() => runnerSandboxConfig(config, 'not-a-token')).toThrow(/RUNNER_TOKEN_FILE/)
  })
})
