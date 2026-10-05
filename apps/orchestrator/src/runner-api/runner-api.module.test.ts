import { randomUUID } from 'node:crypto'

import { Global, Module } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { MAX_SANDBOX_TURN_MS, type TurnPlan } from '@repo/domain'
import { afterEach, describe, expect, it } from 'vitest'

import { parseRunnerTokens } from '../config/runner-tokens.ts'
import { CORE_CONFIG, SITE_LEASES, TURN_ASSIGNMENTS } from '../infra/tokens.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RemoteTurnExecutor } from './remote-turn-executor.ts'
import { RunnerApiModule } from './runner-api.module.ts'
import { RunnerHub } from './runner-hub.ts'

const hash = (fill: string) => fill.repeat(64)
let app: TestingModule | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/** The runner API over RUNNER_TOKENS=`entries`, without a database. */
async function runnerApi(entries: string) {
  const { hashes, problems } = parseRunnerTokens(entries)
  expect(problems).toEqual([])
  const assignments = new MemoryTurnAssignments()
  @Global()
  @Module({
    providers: [
      { provide: CORE_CONFIG, useValue: { runnerApi: { port: 0, tokens: hashes } } },
      { provide: TURN_ASSIGNMENTS, useValue: assignments },
      { provide: SITE_LEASES, useValue: { assert: async () => true } },
    ],
    exports: [CORE_CONFIG, TURN_ASSIGNMENTS, SITE_LEASES],
  })
  class Infra {}
  app = await Test.createTestingModule({ imports: [Infra, RunnerApiModule] }).compile()
  const hub = app.get(RunnerHub)
  const executor = app.get(RemoteTurnExecutor)
  /** The address a turn's key is bound to once `runnerId` reserved the turn. */
  const addressFor = async (runnerId: string) => {
    const id = randomUUID()
    const assignment = (await assignments.open({
      fence: { siteId: id, taskId: id, operation: 'turn', epoch: 1 },
      sessionId: 'session1',
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_TURN_MS,
    }))!
    const address = executor
      .credentialAddress(assignment.id, new AbortController().signal)
      .catch((error: unknown) => error)
    await hub.poll(
      runnerId,
      { runnerSession: randomUUID(), capacity: 1, inventory: [], active: [] },
      AbortSignal.timeout(100),
    )
    return address
  }
  return { addressFor }
}

describe('RunnerApiModule: the address a turn key is bound to', () => {
  it('is the one RUNNER_TOKENS binds the runner to, also while its token rotates', async () => {
    const { addressFor } = await runnerApi(
      [
        `sandbox-1:${hash('a')}@10.20.0.11`,
        `sandbox-2:${hash('b')}@10.20.0.12`,
        `sandbox-2:${hash('c')}@10.20.0.12`,
      ].join(','),
    )
    expect(await addressFor('sandbox-1')).toBe('10.20.0.11')
    expect(await addressFor('sandbox-2')).toBe('10.20.0.12')
  })

  // loadConfig refuses such tokens at start; a configuration built otherwise still gets no key.
  it('refuses the turns of a runner bound to no single address as a platform fault', async () => {
    const { addressFor } = await runnerApi(
      [
        // Accepted outside production: a token bound to no address.
        `sandbox-1:${hash('a')}`,
        `sandbox-2:${hash('b')}@10.20.0.12`,
        // A rotation that also moved the VM: two addresses, none of them trusted alone.
        `sandbox-3:${hash('c')}@10.20.0.13`,
        `sandbox-3:${hash('d')}@10.20.0.14`,
      ].join(','),
    )
    for (const runnerId of ['sandbox-1', 'sandbox-3'])
      expect(await addressFor(runnerId)).toMatchObject({
        code: 'RUNNER_UNAVAILABLE',
        httpStatus: 503,
      })
    expect(await addressFor('sandbox-2')).toBe('10.20.0.12')
  })
})
