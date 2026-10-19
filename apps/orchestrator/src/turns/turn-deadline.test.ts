import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

import {
  SANDBOX_SECRETS_DIR,
  TURN_FINALIZE_RESERVE_MS,
  TURN_PUBLICATION_GRACE_MS,
  MAX_SANDBOX_TURN_MS,
  withoutTurnCredentials,
  type AgentDriver,
  type AgentEvent,
  type SiteLeaseGrant,
} from '@repo/domain'
import { createDockerSandboxProvider } from '@repo/sandbox-providers'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { RunnerHub } from '../runner-api/runner-hub.ts'
import { RunnerCallError } from '../runner/core-client.ts'
import { SandboxRunner } from '../runner/sandbox-runner.ts'
import { sampleDriverId } from '../testing/ids.ts'
import { loopbackTransport } from '../testing/runner-loopback.ts'
import { MemorySiteLeases } from '../testing/site-leases.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { MemoryTurnCredentials, testTurnCredentialPolicy } from '../testing/turn-credentials.ts'
import { MemoryTurnJournal } from '../testing/turn-journal.ts'
import { LiveTurns } from './live-turns.ts'
import { LocalTurnExecutor } from './local-turn-executor.ts'
import { TurnSupervisor, type TurnRequest } from './turn-supervisor.ts'

const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 1,
}
const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
const baseSha = 'b'.repeat(40)
const DEADLINE_LABEL = 'io.raditi.sandbox.deadline'

/** mulberry32: the same delays on every run of the suite. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const request = (hardTimeoutMs: number): TurnRequest => ({
  sandbox: {
    image,
    labels,
    runtime: 'runc',
    resources: { cpu: 1, memoryMiB: 256, pids: 64 },
    user: { uid: 10001, gid: 10001 },
    env: {},
    secrets: [],
    network: { mode: 'none' },
    hardTimeoutMs,
  },
  context: {
    taskId: labels.taskId,
    sessionId: labels.sessionId,
    turn: 1,
    llm: {
      baseUrl: 'http://synthetic.invalid',
      apiKey: 'synthetic-llm-secret',
      model: 'synthetic',
    },
    mcp: { url: 'http://synthetic.invalid/mcp', token: 'synthetic-mcp-secret' },
    instructions: 'Synthetic verification',
  },
  input: { prompt: 'Synthetic turn', attachments: [] },
  driverVersion: '1.0.0',
  workspace: {
    repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
    branch: `agent/${labels.taskId}`,
    expectedBaseSha: baseSha,
    protectedPaths: [],
  },
  committedAt: '2026-09-28T00:00:00.000Z',
})

const driver: AgentDriver = {
  id: sampleDriverId,
  image,
  cliVersion: '1.0.0',
  capabilities: { resume: true, jsonEvents: true, outputSchema: true, mcp: false, images: false },
  prepare: async (context) => ({
    context: { ...context },
    files: [
      {
        path: `/agent-home/${sampleDriverId}/.config/opencode/opencode.json`,
        content: '{"synthetic":true}',
      },
    ],
    env: {},
    secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey }],
  }),
  command: () => ['synthetic-agent'],
  parseEvent: (text) => [JSON.parse(text) as AgentEvent],
  sessionState: () => ({
    root: `/agent-home/${sampleDriverId}`,
    include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
    exclude: [],
  }),
  extractResult: () => null,
}

/**
 * The VM's Docker as the provider sees it, every answer late: the daemon's own info, the image,
 * then the create, which fails with a daemon error once the provider asked for it.
 */
function slowDaemon(random: () => number, labelled: number[]) {
  return {
    info: async () => {
      await sleep(random() * 9_000)
      return { Runtimes: { runc: {} } }
    },
    getImage: () => ({
      inspect: async () => {
        await sleep(random() * 9_000)
        return { Config: {} }
      },
    }),
    createContainer: async (options: { Labels: Record<string, string> }) => {
      labelled.push(Number(options.Labels[DEADLINE_LABEL]))
      await sleep(random() * 25_000)
      throw Object.assign(new Error('synthetic daemon failure'), { statusCode: 500 })
    },
    listContainers: async () => {
      await sleep(random() * 5_000)
      return []
    },
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('turn deadline chain (spec §8 «Срок контейнера и аренда»)', () => {
  it('never labels a container past the supervisor’s deadline, nor that past the lease’s grace', async () => {
    vi.useFakeTimers()
    // The monotonic clock follows the fake clock, as it would on a real host.
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    const random = seeded(20260928)
    let checked = 0
    for (let run = 0; run < 100; run++) {
      const leases = new MemorySiteLeases()
      const assignments = new MemoryTurnAssignments(leases)
      const journal = new MemoryTurnJournal(leases)
      const grants: SiteLeaseGrant[] = []
      const acquire = leases.acquire.bind(leases)
      vi.spyOn(leases, 'acquire').mockImplementation(async (input) => {
        // The database fixes expires_at when the statement starts; core gets it later.
        const grant = await acquire(input)
        if (grant) grants.push(grant)
        await sleep(random() * 5_000)
        return grant
      })
      const hub = new RunnerHub({ assignments, leases, logger: { warn: vi.fn() } })
      const deadlines: number[] = []
      const send = hub.send.bind(hub)
      vi.spyOn(hub, 'send').mockImplementation((live, body, options) => {
        if (body.type === 'prepare' && options.deadline !== undefined)
          deadlines.push(options.deadline)
        return send(live, body, options)
      })
      const base = loopbackTransport(hub)
      const transport = {
        ...base,
        // Late on the way to core and back; now and then an answer is lost and core requeues it.
        poll: async (...args: Parameters<typeof base.poll>) => {
          await sleep(random() * 3_000)
          const answer = (await base.poll(...args)) as { commands: [] }
          if (answer.commands.length > 0 && random() < 0.3) {
            hub.requeue('sandbox-1', args[0].runnerSession, answer.commands)
            throw new RunnerCallError('poll', null)
          }
          await sleep(random() * 3_000)
          return answer
        },
      }
      const labelled: number[] = []
      const sandboxes = createDockerSandboxProvider(
        { runtime: 'runc' },
        { client: slowDaemon(random, labelled) as never },
      )
      const runner = new SandboxRunner({
        transport,
        executor: new LocalTurnExecutor({
          sandboxes,
          parser: () => driver,
          transport: { capture: vi.fn(), restore: vi.fn() },
          transfer: { get: vi.fn(), put: vi.fn() },
          importBundle: vi.fn(async () => {}),
        }),
        maxTurns: 1,
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      })
      runner.start()
      cleanups.push(() => hub.close())
      const supervisor = new TurnSupervisor({
        leases,
        assignments,
        journal,
        executor: new RemoteTurnExecutor(hub, leases, assignments, () => '127.0.0.1'),
        credentials: new MemoryTurnCredentials({
          llmApiKey: 'synthetic-llm-secret',
          mcpToken: 'synthetic-mcp-secret',
        }),
        driver,
        live: new LiveTurns(),
        workspace: {
          buildBaseBundle: async () => {
            await sleep(random() * 5_000)
            return {
              baseSha,
              branch: `agent/${labels.taskId}`,
              sha256: '0'.repeat(64),
              sizeBytes: 1,
              read: async function* () {
                yield Buffer.from('b')
              },
            }
          },
          preparePublication: vi.fn(),
        },
        snapshots: { save: vi.fn(), load: vi.fn(), restoreSource: vi.fn() },
      })
      const hardTimeoutMs =
        TURN_FINALIZE_RESERVE_MS +
        1_000 +
        Math.floor(random() * (MAX_SANDBOX_TURN_MS - TURN_FINALIZE_RESERVE_MS - 1_000))
      let settled = false
      const running = supervisor
        .run(withoutTurnCredentials(request(hardTimeoutMs)), testTurnCredentialPolicy)
        .then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
      for (let step = 0; !settled && step < 600; step++) await vi.advanceTimersByTimeAsync(1_000)
      await running
      const stopping = runner.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      await stopping
      hub.close()

      expect(settled).toBe(true)
      expect(grants).toHaveLength(1)
      expect(deadlines.length).toBeLessThanOrEqual(1)
      if (deadlines.length === 1)
        expect(deadlines[0]!).toBeLessThanOrEqual(
          grants[0]!.expiresAt.getTime() - TURN_PUBLICATION_GRACE_MS,
        )
      for (const label of labelled) {
        expect(label).toBeLessThanOrEqual(deadlines[0]!)
        checked += 1
      }
    }
    // Most runs reached the daemon's create: the property is not vacuous.
    expect(checked).toBeGreaterThan(50)
  })
})
