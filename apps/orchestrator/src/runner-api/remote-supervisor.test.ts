import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'

import {
  MAX_SANDBOX_TURN_MS,
  runnerReportSchema,
  SANDBOX_SECRETS_DIR,
  type AgentDriver,
  type AgentEvent,
  type RunnerCommand,
  type SiteLeaseFence,
  type SiteLeaseGrant,
  type TurnBundleSource,
  type TurnEvidence,
  type TurnResult,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from '../git-workspace/archive.ts'
import { SnapshotService } from '../sessions/snapshot.service.ts'
import { sealSnapshotPart } from '../sessions/snapshot-parts.ts'
import { memoryStorage, memoryTransit, tarZst } from '../testing/snapshots.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { LiveTurns } from '../turns/live-turns.ts'
import { TurnSupervisor, type TurnRequest } from '../turns/turn-supervisor.ts'
import { RemoteTurnExecutor } from './remote-turn-executor.ts'
import { RunnerHub } from './runner-hub.ts'

const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 1,
}
const baseSha = 'b'.repeat(40)
const headSha = 'c'.repeat(40)
const image = `registry.invalid/raditi/codex@sha256:${'a'.repeat(64)}`
const home = { root: '/agent-home/codex', include: ['sessions'], exclude: [] }
const result: TurnResult = {
  summary: 'Готово',
  change_type: 'code',
  client_message: 'Изменение готово к проверке.',
  files_changed: ['page.txt'],
  questions: [],
  needs_approval: false,
  risk: 'low',
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const stops: AbortController[] = []
const hubs: RunnerHub[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort()
  for (const hub of hubs.splice(0)) hub.close()
})

/**
 * What a runner does with each command, scripted: the real runner (P2, runner/) drives a local
 * SandboxProvider instead. Keys and presigned URLs are used exactly as a runner would.
 */
function scriptedRunner(
  hub: RunnerHub,
  memory: ReturnType<typeof memoryStorage>,
  captured: { home: Uint8Array; patch: Uint8Array; untracked: Uint8Array },
  events: AgentEvent[],
) {
  const runnerId = 'sandbox-1'
  const runnerSession = randomUUID()
  const stop = new AbortController()
  stops.push(stop)
  const seen: RunnerCommand['type'][] = []
  const handle = async (command: RunnerCommand) => {
    seen.push(command.type)
    const report = (body: Record<string, unknown>) =>
      hub.report(
        runnerId,
        runnerReportSchema.parse({
          runnerSession,
          assignmentId: command.assignmentId,
          epoch: command.fence.epoch,
          ...body,
        }),
      )
    const headers = {
      session: runnerSession,
      epoch: String(command.fence.epoch),
      command: command.commandId,
    }
    switch (command.type) {
      case 'prepare': {
        const bundle = await hub.bundle(runnerId, command.assignmentId, headers)
        const chunks: Uint8Array[] = []
        for await (const chunk of bundle.read()) chunks.push(chunk)
        expect(sha256(Buffer.concat(chunks))).toBe(command.bundle.sha256)
        await report({ type: 'created', commandId: command.commandId, containerId: 'container1' })
        await report({ type: 'prepared', commandId: command.commandId, containerId: 'container1' })
        return
      }
      case 'launch': {
        await report({ type: 'running', commandId: command.commandId, execId: 'exec1' })
        const stdout = Buffer.byteLength(
          events.map((event) => JSON.stringify(event) + '\n').join(''),
        )
        await report({
          type: 'output',
          execId: 'exec1',
          from: { stdout: 0, stderr: 0 },
          to: { stdout, stderr: 0 },
          events,
        })
        await report({ type: 'exited', execId: 'exec1', exit: { code: 0, reason: 'exited' } })
        return
      }
      case 'quiesce':
        await report({ type: 'quiesced', commandId: command.commandId })
        return
      case 'capture': {
        for (const part of ['patch', 'untracked'] as const)
          (await hub.candidate(runnerId, command.assignmentId, part, headers))(captured[part])
        await report({
          type: 'captured',
          commandId: command.commandId,
          homeBytes: captured.home.byteLength,
          patch: { sha256: sha256(captured.patch), sizeBytes: captured.patch.byteLength },
          untracked: {
            sha256: sha256(captured.untracked),
            sizeBytes: captured.untracked.byteLength,
          },
        })
        return
      }
      case 'seal': {
        const key = await hub.key(runnerId, command.assignmentId, 'seal', headers)
        let sealed: ReturnType<typeof sealSnapshotPart>
        try {
          sealed = sealSnapshotPart(command.base, 'home', captured.home, key)
        } finally {
          key.fill(0)
        }
        await memory.transfer.put({ ...command.put, expiresAt: new Date() }, sealed.body)
        await report({ type: 'sealed', commandId: command.commandId, ...sealed.sealed })
        return
      }
      case 'destroy':
        await report({ type: 'destroyed', commandId: command.commandId, containerId: 'container1' })
        return
      default:
        return
    }
  }
  const running = (async () => {
    while (!stop.signal.aborted) {
      const { commands } = await hub.poll(
        runnerId,
        { runnerSession, capacity: 1, inventory: [], active: [] },
        stop.signal,
      )
      for (const command of commands) await handle(command)
    }
  })()
  return { seen, running }
}

describe('TurnSupervisor on a runner', () => {
  it('runs a whole turn through the runner API and commits a snapshot core can load back', async () => {
    const memory = memoryStorage()
    const transit = memoryTransit()
    const snapshots = new SnapshotService(memory.storage, transit.secrets)
    const assignments = new MemoryTurnAssignments()
    const grant = (ttlMs: number): SiteLeaseGrant => ({
      siteId: labels.siteId,
      taskId: labels.taskId,
      operation: 'turn',
      epoch: 1,
      serverNow: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
    })
    const leases = {
      acquire: vi.fn(async (input: { ttlMs: number }) => grant(input.ttlMs)),
      renew: vi.fn(async (_fence: SiteLeaseFence, ttlMs: number) => grant(ttlMs)),
      assert: vi.fn(async () => true),
      release: vi.fn(async () => true),
      inspect: vi.fn(async () => null),
      holdForRecovery: vi.fn(async () => true),
      reclaimForRecovery: vi.fn(async () => null),
    }
    const hub = new RunnerHub({ assignments, leases, logger: { warn: vi.fn() } })
    hubs.push(hub)
    const request: TurnRequest = {
      sandbox: {
        image,
        labels,
        runtime: 'runc',
        resources: { cpu: 1, memoryMiB: 256, pids: 64 },
        user: { uid: 10001, gid: 10001 },
        env: {},
        secrets: [],
        network: { mode: 'none' },
        hardTimeoutMs: MAX_SANDBOX_TURN_MS,
      },
      context: {
        taskId: labels.taskId,
        sessionId: labels.sessionId,
        turn: 1,
        llm: { baseUrl: 'http://llm.invalid', apiKey: 'synthetic-llm-secret', model: 'synthetic' },
        mcp: { url: 'http://mcp.invalid/mcp', token: 'synthetic-mcp-secret' },
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
      committedAt: '2026-09-27T00:00:00.000Z',
    }
    const events: AgentEvent[] = [
      { type: 'started', nativeSessionId: 'native1' },
      { type: 'message', text: JSON.stringify(result) },
      { type: 'completed' },
    ]
    const driver: AgentDriver = {
      id: 'codex',
      image,
      capabilities: {
        resume: true,
        jsonEvents: true,
        outputSchema: true,
        mcp: false,
        images: false,
      },
      prepare: vi.fn(async (context) => ({
        context: { ...context },
        files: [{ path: '/agent-home/codex/config.toml', content: 'synthetic = true' }],
        env: {},
        secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: context.llm.apiKey }],
      })),
      command: vi.fn(() => ['synthetic-agent']),
      parseEvent: () => [],
      sessionState: vi.fn(() => home),
      extractResult: vi.fn(
        (seen: readonly AgentEvent[]) =>
          JSON.parse(seen.findLast((event) => event.type === 'message')?.text ?? 'null') as unknown,
      ),
    }
    const bundleBytes = Buffer.from('synthetic bundle')
    const bundle: TurnBundleSource = {
      baseSha,
      branch: request.workspace.branch,
      sha256: sha256(bundleBytes),
      sizeBytes: bundleBytes.byteLength,
      read: async function* () {
        yield Buffer.from(bundleBytes)
      },
    }
    const captured = {
      home: await tarZst({ 'sessions/turn.jsonl': 'native session' }),
      patch: Buffer.from('tracked-patch'),
      untracked: emptyUntrackedArchive(),
    }
    const publish = vi.fn(async (assertFence: () => Promise<void>) => assertFence())
    const workspace = {
      buildBaseBundle: vi.fn(async () => bundle),
      preparePublication: vi.fn(async (input: { patch: Uint8Array; untracked: Uint8Array }) => ({
        baseSha,
        headSha,
        patch: input.patch,
        untracked: input.untracked,
        publish,
        dispose: vi.fn(async () => {}),
      })),
    }
    const evidence: TurnEvidence[] = []
    const journal = {
      record: vi.fn(async (entry: TurnEvidence) => {
        evidence.push(structuredClone(entry))
      }),
    }
    const runner = scriptedRunner(hub, memory, captured, events)

    const finished = await new TurnSupervisor({
      leases,
      executor: new RemoteTurnExecutor(hub, leases, assignments),
      assignments,
      driver,
      workspace,
      snapshots,
      journal,
      live: new LiveTurns(),
    }).run(request)

    expect(finished.result).toEqual(result)
    expect(runner.seen).toEqual(['prepare', 'launch', 'quiesce', 'capture', 'seal', 'destroy'])
    expect(evidence.map((entry) => entry.phase)).toEqual([
      'leased',
      'created',
      'restored',
      'running',
      'output',
      'quiesced',
      'checkpointing',
      'checkpointed',
      'destroyed',
      'publishing',
      'completed',
    ])
    expect(evidence[1]).toMatchObject({ containerId: 'container1' })
    expect(evidence[4]).toMatchObject({ execId: 'exec1', events })
    // The captured parts reached the candidate as uploaded.
    expect(workspace.preparePublication).toHaveBeenCalledWith(
      expect.objectContaining({ patch: captured.patch, untracked: captured.untracked }),
    )
    const loaded = await snapshots.load({
      workspaceId: labels.workspaceId,
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: 'codex', version: '1.0.0' },
      home,
    })
    expect(finished.manifest).toEqual(loaded.manifest)
    expect(Buffer.from(loaded.archives.home)).toEqual(Buffer.from(captured.home))
    expect(transit.allZeroed()).toBe(true)
    expect([...assignments.rows.values()]).toEqual([
      expect.objectContaining({
        executor: 'runner',
        outcome: 'completed',
        containerId: 'container1',
        runner: expect.objectContaining({ id: 'sandbox-1' }),
      }),
    ])
    expect(publish).toHaveBeenCalledOnce()
    expect(leases.release).toHaveBeenCalledOnce()
  })
})
