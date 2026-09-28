import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'

import {
  MAX_SANDBOX_TURN_MS,
  runnerReportSchema,
  runnerTimings,
  SANDBOX_SECRETS_DIR,
  type RunnerCommand,
  type TurnExecution,
  type TurnPlan,
  type TurnPrepareInput,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RemoteTurnExecutor } from './remote-turn-executor.ts'
import { RunnerApiError } from './runner-api-error.ts'
import { RunnerHub } from './runner-hub.ts'

const siteId = '00000000-0000-4000-8000-000000000002'
const taskId = '00000000-0000-4000-8000-000000000003'
const fence = { siteId, taskId, operation: 'turn' as const, epoch: 1 }
const labels = { workspaceId: 'ws1', siteId, taskId, sessionId: 'session1', turn: 1 }
const image = `registry.invalid/raditi/codex@sha256:${'a'.repeat(64)}`
const baseSha = 'b'.repeat(40)
const credentials = ['synthetic-llm-secret', 'synthetic-mcp-secret']
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const hubs: RunnerHub[] = []
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(RunnerApiError)
  return (error as RunnerApiError).body
}

function fixture() {
  const assignments = new MemoryTurnAssignments()
  const leases = { assert: vi.fn(async () => true) }
  const warn = vi.fn()
  const hub = new RunnerHub({ assignments, leases, logger: { warn } })
  hubs.push(hub)
  const executor = new RemoteTurnExecutor(hub, leases, assignments)
  const bundleBytes = Buffer.from('synthetic bundle')
  const created = vi.fn(async (_execution: TurnExecution) => {})
  const dispatched = vi.fn()
  const vacated = vi.fn()

  const runner = (runnerId = 'sandbox-1', runnerSession = randomUUID()) => ({
    runnerId,
    runnerSession,
    /** One poll; it gives up after 200 ms instead of the 25-second hold. */
    async poll(overrides: { capacity?: number; active?: string[] } = {}) {
      const { commands } = await hub.poll(
        runnerId,
        {
          runnerSession,
          capacity: overrides.capacity ?? 1,
          inventory: [],
          active: (overrides.active ?? []).map((assignmentId) => ({
            assignmentId,
            epoch: 1,
            phase: 'running' as const,
          })),
        },
        AbortSignal.timeout(200),
      )
      return commands
    },
    report(assignmentId: string, body: Record<string, unknown>, epoch = 1) {
      return hub.report(
        runnerId,
        runnerReportSchema.parse({ runnerSession, assignmentId, epoch, ...body }),
      )
    },
    headers(command: RunnerCommand, epoch = command.fence.epoch) {
      return { session: runnerSession, epoch: String(epoch), command: command.commandId }
    },
  })

  const open = async () =>
    (await assignments.open({
      fence,
      sessionId: labels.sessionId,
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_TURN_MS,
    }))!

  const input = (
    assignmentId: string,
    extra: Partial<TurnPrepareInput> = {},
  ): TurnPrepareInput => ({
    assignmentId,
    fence,
    sandbox: {
      image,
      labels: { ...labels, leaseEpoch: 1 },
      runtime: 'runc',
      resources: { cpu: 1, memoryMiB: 256, pids: 64 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'none' },
      hardTimeoutMs: MAX_SANDBOX_TURN_MS,
    },
    remainingMs: MAX_SANDBOX_TURN_MS,
    bundle: {
      baseSha,
      branch: `agent/${taskId}`,
      sha256: sha256(bundleBytes),
      sizeBytes: bundleBytes.byteLength,
      read: async function* () {
        yield Buffer.from(bundleBytes)
      },
    },
    driverId: 'codex',
    prepared: {
      files: [{ path: '/agent-home/codex/config.toml', content: 'synthetic = true' }],
      env: {},
      secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: credentials[0]! }],
    },
    argv: ['codex', 'exec', '--json'],
    credentials,
    created,
    dispatched,
    vacated,
    ...extra,
  })

  /** A prepared turn on `vm`: the prepare command answered with created and prepared. */
  const prepared = async (vm = runner()) => {
    const assignment = await open()
    const preparing = executor.prepare(input(assignment.id), new AbortController().signal)
    const [command] = await vm.poll()
    await vm.report(assignment.id, {
      type: 'created',
      commandId: command!.commandId,
      containerId: 'container1',
    })
    await vm.report(assignment.id, {
      type: 'prepared',
      commandId: command!.commandId,
      containerId: 'container1',
    })
    return { assignment, execution: await preparing, vm, command: command! }
  }

  return {
    assignments,
    leases,
    warn,
    hub,
    executor,
    runner,
    open,
    input,
    prepared,
    created,
    dispatched,
    vacated,
    bundleBytes,
  }
}

describe('RemoteTurnExecutor over the runner hub', () => {
  it('hands the prepare to a runner with a free slot and owns the container from `created`', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const preparing = f.executor.prepare(f.input(assignment.id), new AbortController().signal)
    // A runner without a free slot takes nothing.
    expect(await vm.poll({ capacity: 0 })).toEqual([])
    expect(f.assignments.rows.get(assignment.id)!.runner).toBeNull()

    const [command] = await vm.poll()
    expect(command).toMatchObject({
      type: 'prepare',
      assignmentId: assignment.id,
      fence,
      driverId: 'codex',
      credentials,
      bundle: { baseSha, sizeBytes: f.bundleBytes.byteLength },
      sandbox: { secrets: [], labels: { leaseEpoch: 1 } },
    })
    expect(command).not.toHaveProperty('restore')
    expect(f.assignments.rows.get(assignment.id)!.runner).toEqual({
      id: 'sandbox-1',
      session: vm.runnerSession,
    })

    const bundle = await f.hub.bundle('sandbox-1', assignment.id, vm.headers(command!))
    const chunks: Uint8Array[] = []
    for await (const chunk of bundle.read()) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(f.bundleBytes)
    expect(f.leases.assert).toHaveBeenCalledWith(fence)

    await vm.report(assignment.id, {
      type: 'created',
      commandId: command!.commandId,
      containerId: 'container1',
    })
    expect(f.created).toHaveBeenCalledOnce()
    expect(f.created.mock.calls[0]![0].containerId).toBe('container1')
    expect(f.assignments.rows.get(assignment.id)!.containerId).toBe('container1')
    // A repeated report changes nothing.
    await vm.report(assignment.id, {
      type: 'created',
      commandId: command!.commandId,
      containerId: 'container1',
    })
    expect(f.created).toHaveBeenCalledOnce()

    const done = { type: 'prepared', commandId: command!.commandId, containerId: 'container1' }
    await vm.report(assignment.id, done)
    await expect(preparing).resolves.toMatchObject({ containerId: 'container1' })
    await vm.report(assignment.id, done)
    // Nothing can be fetched for an answered command.
    expect(await refusal(f.hub.bundle('sandbox-1', assignment.id, vm.headers(command!)))).toEqual({
      error: 'COMMAND_CLOSED',
    })
  })

  it('fails the turn as RUNNER_UNAVAILABLE when no runner claims it in time', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const assignment = await f.open()
    const preparing = f.executor.prepare(f.input(assignment.id), new AbortController().signal)
    const rejected = expect(preparing).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
      httpStatus: 503,
    })
    await vi.advanceTimersByTimeAsync(runnerTimings.claimTimeoutMs)
    await rejected
    expect(f.assignments.rows.get(assignment.id)!.outcome).toBe('failed')
    vi.useRealTimers()
    expect(await f.runner().poll()).toEqual([])
    expect(f.dispatched).not.toHaveBeenCalled()
  })

  it('keeps a prepare undispatched when the poll that claimed it closed meanwhile', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const preparing = f.executor.prepare(f.input(assignment.id), new AbortController().signal)
    const claim = f.assignments.claim.bind(f.assignments)
    const claiming = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<void>()
    vi.spyOn(f.assignments, 'claim').mockImplementationOnce(async (input) => {
      claiming.resolve()
      await answer.promise
      return claim(input)
    })
    const connection = new AbortController()
    const polled = f.hub.poll(
      'sandbox-1',
      { runnerSession: vm.runnerSession, capacity: 1, inventory: [], active: [] },
      connection.signal,
    )
    await claiming.promise
    // The runner's connection breaks while the claim query is out; then the claim commits.
    connection.abort()
    answer.resolve()

    expect(await polled).toEqual({ commands: [] })
    expect(f.dispatched).not.toHaveBeenCalled()
    // Still queued: the next poll of the session takes it, and only then has it left core.
    const [command] = await vm.poll()
    expect(command).toMatchObject({ type: 'prepare', assignmentId: assignment.id })
    expect(f.dispatched).toHaveBeenCalledOnce()
    await vm.report(assignment.id, {
      type: 'prepared',
      commandId: command!.commandId,
      containerId: 'container1',
    })
    await preparing
  })

  it('stops waiting for a runner when the turn is given up', async () => {
    const f = fixture()
    const assignment = await f.open()
    const cancel = new AbortController()
    const preparing = f.executor.prepare(f.input(assignment.id), cancel.signal)
    cancel.abort(new Error('cancelled'))
    await expect(preparing).rejects.toThrow('cancelled')
    expect(f.assignments.rows.get(assignment.id)!.outcome).toBe('failed')
    // Never handed out: no container of it can exist.
    expect(f.dispatched).not.toHaveBeenCalled()
  })

  it('reports a container created after the prepare was given up, so that it is removed', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const cancel = new AbortController()
    const preparing = f.executor.prepare(f.input(assignment.id), cancel.signal)
    const [command] = await vm.poll()
    expect(f.dispatched).toHaveBeenCalledOnce()
    cancel.abort(new Error('cancelled'))
    await expect(preparing).rejects.toThrow('cancelled')
    await vm.report(assignment.id, {
      type: 'created',
      commandId: command!.commandId,
      containerId: 'container1',
    })
    expect(f.created).toHaveBeenCalledOnce()
    expect(f.vacated).not.toHaveBeenCalled()
  })

  it('takes `absent` as proof only while no container of the prepare was reported', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const cancel = new AbortController()
    const preparing = f.executor.prepare(f.input(assignment.id), cancel.signal)
    const [command] = await vm.poll()
    cancel.abort(new Error('cancelled'))
    await expect(preparing).rejects.toThrow('cancelled')
    // Answered after the owner gave up: the proof still reaches it.
    const absent = {
      type: 'failed',
      commandId: command!.commandId,
      code: 'SANDBOX_COMMAND_FAILED',
      absent: true,
    }
    await vm.report(assignment.id, absent)
    expect(f.vacated).toHaveBeenCalledOnce()
    await vm.report(assignment.id, absent)
    expect(f.vacated).toHaveBeenCalledOnce()

    const g = fixture()
    const other = g.runner()
    const second = await g.open()
    const running = g.executor.prepare(g.input(second.id), new AbortController().signal)
    const [prepare] = await other.poll()
    await other.report(second.id, {
      type: 'created',
      commandId: prepare!.commandId,
      containerId: 'container1',
    })
    await other.report(second.id, { ...absent, commandId: prepare!.commandId })
    await expect(running).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
    expect(g.vacated).not.toHaveBeenCalled()
  })

  it('proves nothing by a removal report for a container core did not know', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const preparing = f.executor.prepare(f.input(assignment.id), new AbortController().signal)
    const [command] = await vm.poll()
    await vm.report(assignment.id, { type: 'destroyed', containerId: 'container9' })
    await expect(preparing).rejects.toMatchObject({ code: 'EXEC_LOST' })
    expect(f.vacated).not.toHaveBeenCalled()
    expect(f.created).not.toHaveBeenCalled()
    await vm.report(assignment.id, {
      type: 'failed',
      commandId: command!.commandId,
      code: 'SANDBOX_COMMAND_FAILED',
      absent: true,
    })
    expect(f.vacated).not.toHaveBeenCalled()
    // A newer owner asks the runner about it again instead of trusting that report.
    const adopting = f.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container9',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'removal',
      },
      new AbortController().signal,
    )
    const [adopt] = await vm.poll()
    expect(adopt).toMatchObject({ type: 'adopt', containerId: 'container9', purpose: 'removal' })
    await vm.report(
      assignment.id,
      { type: 'destroyed', commandId: adopt!.commandId, containerId: 'container9' },
      2,
    )
    await expect(adopting).resolves.toBeNull()
  })

  it('maps a failure report to the error core writes itself', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const preparing = f.executor.prepare(f.input(assignment.id), new AbortController().signal)
    const [command] = await vm.poll()
    await vm.report(assignment.id, {
      type: 'failed',
      commandId: command!.commandId,
      code: 'SNAPSHOT_LOAD_FAILED',
    })
    await expect(preparing).rejects.toMatchObject({
      code: 'SNAPSHOT_LOAD_FAILED',
      message: 'The runner could not restore the turn',
    })
  })

  it('launches only under a confirmed fence and journals output from its cursor', async () => {
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    f.leases.assert.mockResolvedValueOnce(false)
    await expect(execution.launch(60_000)).rejects.toMatchObject({ code: 'LEASE_LOST' })
    f.leases.assert.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(execution.launch(60_000)).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(await vm.poll()).toEqual([])

    const launching = execution.launch(60_000)
    const [launch] = await vm.poll()
    expect(launch).toMatchObject({ type: 'launch', timeoutMs: 60_000 })
    await vm.report(assignment.id, {
      type: 'running',
      commandId: launch!.commandId,
      execId: 'exec1',
    })
    const agent = await launching
    const journal: unknown[] = []
    const output = agent.output(async (batch) => {
      journal.push(batch)
    })
    const batch = (from: number, to: number) => ({
      type: 'output',
      execId: 'exec1',
      from: { stdout: from, stderr: 0 },
      to: { stdout: to, stderr: 0 },
      events: [{ type: 'message', text: `up to ${to}` }],
    })
    await vm.report(assignment.id, batch(0, 10))
    expect(await refusal(vm.report(assignment.id, batch(20, 30)))).toEqual({
      error: 'CURSOR_MISMATCH',
      expected: { stdout: 10, stderr: 0 },
    })
    await vm.report(assignment.id, batch(0, 10))
    await vm.report(assignment.id, batch(10, 20))
    await vm.report(assignment.id, {
      type: 'exited',
      execId: 'exec1',
      exit: { code: 0, reason: 'exited' },
    })
    await output
    expect(journal).toHaveLength(2)
    expect(await agent.wait()).toEqual({ code: 0, reason: 'exited' })
    expect(await refusal(vm.report(assignment.id, { ...batch(20, 30), execId: 'exec2' }))).toEqual({
      error: 'COMMAND_CLOSED',
    })

    await agent.kill()
    expect(await vm.poll()).toEqual([expect.objectContaining({ type: 'abort', fence })])
  })

  it('takes the captured parts only as uploaded for the open capture, and seals with its key', async () => {
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    const patch = Buffer.from('untrusted patch')
    const untracked = Buffer.from('untrusted archive')
    const capturing = execution.capture({
      home: { root: '/agent-home/codex', include: ['sessions'], exclude: [] },
      baseSha,
    })
    const [capture] = await vm.poll()
    expect(capture).toMatchObject({ type: 'capture', baseSha })
    const upload = async (part: 'patch' | 'untracked', bytes: Uint8Array) =>
      (await f.hub.candidate('sandbox-1', assignment.id, part, vm.headers(capture!)))(bytes)
    await upload('patch', patch)
    const captured = {
      type: 'captured',
      commandId: capture!.commandId,
      homeBytes: 321,
      patch: { sha256: sha256(patch), sizeBytes: patch.byteLength },
      untracked: { sha256: sha256(untracked), sizeBytes: untracked.byteLength },
    }
    expect(await refusal(vm.report(assignment.id, captured))).toEqual({ error: 'BAD_REQUEST' })
    await upload('untracked', Buffer.from('another archive'))
    expect(await refusal(vm.report(assignment.id, captured))).toEqual({ error: 'BAD_REQUEST' })
    await upload('untracked', untracked)
    await vm.report(assignment.id, captured)
    const result = await capturing
    expect(Buffer.from(result.patch)).toEqual(patch)
    expect(Buffer.from(result.untracked)).toEqual(untracked)
    expect(result.homeBytes).toBe(321)

    const key = new Uint8Array(32).fill(7)
    const dataKey = vi.fn(async () => key)
    const base = {
      workspaceId: 'ws1',
      sessionId: labels.sessionId,
      turn: 1,
      image,
      driver: { id: 'codex' as const, version: '1.0.0' },
      home: { root: '/agent-home/codex', include: ['sessions'], exclude: [] },
      git: {
        provider: 'gitea' as const,
        branch: `agent/${taskId}`,
        baseSha,
        headSha: 'c'.repeat(40),
      },
      schemaVersion: 1 as const,
      createdAt: '2026-09-27T00:00:00.000Z',
    }
    const sealing = execution.seal({
      base,
      dataKey,
      put: {
        method: 'PUT',
        url: 'https://s3.invalid/raditi-sessions/sessions/session1/turns/0001/home.tar.zst?X-Amz-Signature=synthetic',
        headers: { 'if-none-match': '*' },
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const [seal] = await vm.poll()
    expect(seal).toMatchObject({ type: 'seal', sizeBytes: 321, put: { method: 'PUT' } })
    expect(seal).not.toHaveProperty('put.expiresAt')
    // A key for another command, or once the site is lost, never leaves core.
    expect(
      await refusal(f.hub.key('sandbox-1', assignment.id, 'restore', vm.headers(seal!))),
    ).toEqual({ error: 'COMMAND_CLOSED' })
    f.leases.assert.mockResolvedValueOnce(false)
    expect(await refusal(f.hub.key('sandbox-1', assignment.id, 'seal', vm.headers(seal!)))).toEqual(
      {
        error: 'LEASE_LOST',
      },
    )
    f.leases.assert.mockRejectedValueOnce(new Error('database unavailable'))
    expect(await refusal(f.hub.key('sandbox-1', assignment.id, 'seal', vm.headers(seal!)))).toEqual(
      {
        error: 'UNAVAILABLE',
      },
    )
    expect(dataKey).not.toHaveBeenCalled()
    expect(await f.hub.key('sandbox-1', assignment.id, 'seal', vm.headers(seal!))).toBe(key)
    const sealed = {
      sha256: 'd'.repeat(64),
      sizeBytes: 321,
      iv: 'e'.repeat(24),
      tag: 'f'.repeat(32),
    }
    await vm.report(assignment.id, { type: 'sealed', commandId: seal!.commandId, ...sealed })
    await expect(sealing).resolves.toEqual(sealed)
  })

  it('points a runner behind a recovery at the newer fence and refuses everyone else', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    const adopting = f.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'work',
        remainingMs: 60_000,
        driverId: 'codex',
        credentials,
        holdsCredentials: true,
      },
      new AbortController().signal,
    )
    const [adopt] = await vm.poll()
    expect(adopt).toMatchObject({
      type: 'adopt',
      fence: { epoch: 2 },
      purpose: 'work',
      work: { driverId: 'codex' },
    })
    // What is left when the poll took it, not when it was queued.
    expect(adopt!.type === 'adopt' && adopt!.work!.remainingMs).toBeGreaterThan(59_000)
    expect(adopt!.type === 'adopt' && adopt!.work!.remainingMs).toBeLessThanOrEqual(60_000)
    expect(adopt).not.toHaveProperty('work.credentials')
    const quiesced = { type: 'quiesced', commandId: randomUUID() }
    expect(await refusal(vm.report(assignment.id, quiesced, 1))).toEqual({
      error: 'FENCE_SUPERSEDED',
      fence: { ...fence, epoch: 2 },
    })
    expect(await refusal(vm.report(assignment.id, quiesced, 3))).toEqual({ error: 'LEASE_LOST' })
    const other = f.runner('sandbox-2', vm.runnerSession)
    expect(await refusal(other.report(assignment.id, quiesced, 2))).toEqual({ error: 'LEASE_LOST' })
    // Another session of this runner: it stops and leaves the container to this one.
    const zombie = f.runner('sandbox-1')
    expect(await refusal(zombie.report(assignment.id, quiesced, 2))).toEqual({
      error: 'SESSION_RETIRED',
    })
    expect(await refusal(vm.report(randomUUID(), quiesced, 2))).toEqual({ error: 'LEASE_LOST' })
    expect(await refusal(vm.report(assignment.id, quiesced, 2))).toEqual({
      error: 'COMMAND_CLOSED',
    })

    await vm.report(
      assignment.id,
      { type: 'adopted', commandId: adopt!.commandId, containerId: 'container1' },
      2,
    )
    const adopted = (await adopting)!
    expect(adopted.containerId).toBe('container1')
    await expect(adopted.launch(1_000)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('leaves a turn no core drives to recovery and refuses a finished one', async () => {
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    const quiescing = execution.quiesce()
    const [quiesce] = await vm.poll()
    // Core restarted: the assignment is unfinished, but no live state answers for it.
    f.hub.release(
      (f.hub as unknown as { attach: RunnerHub['attach'] }).attach({
        id: assignment.id,
        fence,
        runner: { id: 'sandbox-1', session: vm.runnerSession },
        credentials: [],
        remainingMs: 1,
      }),
      fence.epoch,
    )
    await expect(quiescing).rejects.toMatchObject({ code: 'CONFLICT' })
    const answer = { type: 'quiesced', commandId: quiesce!.commandId }
    expect(await refusal(vm.report(assignment.id, answer))).toEqual({ error: 'UNAVAILABLE' })
    await f.assignments.finish({ id: assignment.id, epoch: 1, outcome: 'failed' })
    expect(await refusal(vm.report(assignment.id, answer))).toEqual({ error: 'LEASE_LOST' })
  })

  it('checks an adopted agent’s output against the credentials it did not send again', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    const adopting = f.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'work',
        remainingMs: 60_000,
        driverId: 'codex',
        credentials,
        holdsCredentials: true,
      },
      new AbortController().signal,
    )
    const [adopt] = await vm.poll()
    expect(JSON.stringify(adopt)).not.toContain(credentials[0])
    await vm.report(
      assignment.id,
      { type: 'adopted', commandId: adopt!.commandId, containerId: 'container1' },
      2,
    )
    const adopted = (await adopting)!
    const cursor = { stdout: 0, stderr: 0 }
    const attaching = adopted.attach({ execId: 'exec1', cursor, eventCount: 0 })
    const [resume] = await vm.poll()
    await vm.report(
      assignment.id,
      { type: 'running', commandId: resume!.commandId, execId: 'exec1' },
      2,
    )
    const agent = (await attaching)!
    const record = vi.fn(async () => {})
    const reading = agent.output(record)
    // A runner that let a key through, compromised or not: core refuses it before the journal.
    const leaked = {
      type: 'output',
      execId: 'exec1',
      from: cursor,
      to: { stdout: 64, stderr: 0 },
      events: [{ type: 'message', text: `ключ ${credentials[0]}` }],
    }
    expect(await refusal(vm.report(assignment.id, leaked, 2))).toEqual({ error: 'COMMAND_CLOSED' })
    await expect(reading).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
    expect(record).not.toHaveBeenCalled()
  })

  it('retires another session of the runner that reports on a turn no core drives yet', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    // Core restarted: its hub knows no runner session yet; the assignment names vm's.
    const restarted = new RunnerHub({
      assignments: f.assignments,
      leases: f.leases,
      logger: { warn: vi.fn() },
    })
    hubs.push(restarted)
    const report = (runnerId: string, runnerSession: string) =>
      restarted.report(
        runnerId,
        runnerReportSchema.parse({
          type: 'quiesced',
          commandId: randomUUID(),
          runnerSession,
          assignmentId: assignment.id,
          epoch: 1,
        }),
      )
    expect(await refusal(report('sandbox-1', randomUUID()))).toEqual({ error: 'SESSION_RETIRED' })
    expect(await refusal(report('sandbox-1', vm.runnerSession))).toEqual({ error: 'UNAVAILABLE' })
    expect(await refusal(report('sandbox-2', vm.runnerSession))).toEqual({ error: 'LEASE_LOST' })
  })

  it('fails the open commands of a runner that restarted and refuses its old session', async () => {
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    const quiescing = execution.quiesce()
    const rejected = expect(quiescing).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' })
    await vm.poll()
    const restarted = f.runner('sandbox-1')
    expect(await restarted.poll({ capacity: 0 })).toEqual([])
    await rejected
    // Retired, not lost: the new session may have taken the container over.
    expect(
      await refusal(vm.report(assignment.id, { type: 'quiesced', commandId: randomUUID() })),
    ).toEqual({ error: 'SESSION_RETIRED' })
    expect(await refusal(vm.poll())).toEqual({ error: 'SESSION_RETIRED' })
    // The container is not reachable through the new session until recovery adopts it.
    await expect(execution.destroy('failed')).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' })
  })

  it('gives up the commands of a runner silent for longer than the heartbeat allows', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    // The monotonic clock follows the fake clock, as it would on a real host.
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    const quiescing = execution.quiesce()
    const rejected = expect(quiescing).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' })
    await vi.advanceTimersByTimeAsync(runnerTimings.silentAfterMs + 10_000)
    await rejected
    // Coming back, it is told to restart under a new session instead of polling in vain.
    expect(await refusal(vm.poll())).toEqual({ error: 'SESSION_RETIRED' })
    expect(
      await refusal(vm.report(assignment.id, { type: 'quiesced', commandId: randomUUID() })),
    ).toEqual({ error: 'SESSION_RETIRED' })
  })

  it('treats a container the runner removed on its own as gone', async () => {
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    const quiescing = execution.quiesce()
    await vm.poll()
    expect(
      await refusal(vm.report(assignment.id, { type: 'destroyed', containerId: 'container2' })),
    ).toEqual({ error: 'BAD_REQUEST' })
    await vm.report(assignment.id, { type: 'destroyed', containerId: 'container1' })
    await expect(quiescing).rejects.toMatchObject({ code: 'EXEC_LOST' })
    await execution.destroy('failed')
    expect(await vm.poll()).toEqual([])
  })

  it('answers a removal of the very container the runner reported removed without asking it', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    await vm.report(assignment.id, { type: 'destroyed', containerId: 'container1' })
    const adopt = (containerId: string) =>
      f.executor.adopt(
        {
          assignmentId: assignment.id,
          fence: { ...fence, epoch: 2 },
          containerId,
          labels: { ...labels, leaseEpoch: 1 },
          purpose: 'removal',
        },
        new AbortController().signal,
      )
    await expect(adopt('container1')).resolves.toBeNull()
    expect(await vm.poll()).toEqual([])
  })

  it('destroys through the runner and forgets the turn once it confirmed', async () => {
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    const destroying = execution.destroy('completed')
    const [destroy] = await vm.poll()
    expect(destroy).toMatchObject({ type: 'destroy', reason: 'completed' })
    const confirmed = {
      type: 'destroyed',
      commandId: destroy!.commandId,
      containerId: 'container1',
    }
    await vm.report(assignment.id, confirmed)
    await destroying
    // A late repeat finds the turn left to recovery, not a live command.
    expect(await refusal(vm.report(assignment.id, confirmed))).toEqual({ error: 'UNAVAILABLE' })
  })

  it('adopts nothing when the runner answers that the container is gone', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    const adopting = f.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'removal',
      },
      new AbortController().signal,
    )
    const [adopt] = await vm.poll()
    await vm.report(
      assignment.id,
      { type: 'destroyed', commandId: adopt!.commandId, containerId: 'container1' },
      2,
    )
    await expect(adopting).resolves.toBeNull()
  })

  it('tells recovery whether the runner of a turn is there and still holds its credentials', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    const row = (await f.assignments.get(assignment.id))!
    expect(f.executor.takeover(row)).toEqual({
      runnerSession: vm.runnerSession,
      holdsCredentials: true,
    })
    // Restarted: a new session that never saw the turn credentials.
    const restarted = f.runner('sandbox-1')
    await restarted.poll({ capacity: 0 })
    expect(f.executor.takeover(row)).toEqual({
      runnerSession: restarted.runnerSession,
      holdsCredentials: false,
    })
    expect(f.executor.takeover({ runner: { id: 'sandbox-2', session: randomUUID() } })).toBeNull()
    // Nobody claimed it: no runner holds anything of the turn.
    expect(f.executor.takeover({ runner: null })).toEqual({ holdsCredentials: false })
  })

  it('does not take a turn over through a runner silent past its poll hold', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    const row = (await f.assignments.get(assignment.id))!
    const now = performance.now.bind(performance)
    let later = runnerTimings.pollHoldMs + 14_000
    vi.spyOn(performance, 'now').mockImplementation(() => now() + later)
    expect(f.executor.takeover(row)).toMatchObject({ runnerSession: vm.runnerSession })
    // Removing through it now would only time out: recovery waits for it instead.
    later = runnerTimings.pollHoldMs + 16_000
    expect(f.executor.takeover(row)).toBeNull()
    // A poll in progress is fresh however long ago the last one ended.
    const polling = vm.poll()
    await vi.waitFor(() => expect(f.executor.takeover(row)).not.toBeNull())
    await polling
  })

  it('lists and reconciles the runner inventory against unfinished assignments', async () => {
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    const container = (containerId: string, extra: Record<string, unknown> = {}) => ({
      containerId,
      labels: { ...labels, leaseEpoch: 1, ...extra },
      ageMs: 1_000,
    })
    const inventory = [
      container('container1'),
      container('container2'),
      container('container3', { turn: 2 }),
      container('container4', { leaseEpoch: 2 }),
    ]
    await f.hub.poll(
      'sandbox-1',
      { runnerSession: vm.runnerSession, capacity: 0, inventory, active: [] },
      AbortSignal.timeout(100),
    )
    expect((await f.executor.list({ turn: 1 })).map((info) => info.id)).toEqual([
      'container1',
      'container2',
      'container4',
    ])
    expect(
      await f.hub.reconcile('sandbox-1', { runnerSession: vm.runnerSession, inventory }),
    ).toEqual({ remove: ['container2', 'container3', 'container4'] })
    // Another runner owns none of them.
    expect(await f.hub.reconcile('sandbox-2', { runnerSession: randomUUID(), inventory })).toEqual({
      remove: inventory.map((entry) => entry.containerId),
    })
    await f.assignments.finish({ id: assignment.id, epoch: 1, outcome: 'completed' })
    expect(
      (await f.hub.reconcile('sandbox-1', { runnerSession: vm.runnerSession, inventory })).remove,
    ).toContain('container1')
    vi.spyOn(f.assignments, 'unfinished').mockRejectedValueOnce(new Error('database unavailable'))
    expect(
      await refusal(f.hub.reconcile('sandbox-1', { runnerSession: vm.runnerSession, inventory })),
    ).toEqual({ error: 'UNAVAILABLE' })
  })
})

const fakeClock = () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  // The monotonic clock follows the fake clock, as it would on a real host.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
}

describe('RemoteTurnExecutor: the turn deadline at delivery', () => {
  const remaining = (command: RunnerCommand | undefined) =>
    command?.type === 'prepare'
      ? command.remainingMs
      : command?.type === 'adopt'
        ? command.work?.remainingMs
        : undefined

  it('hands out what is left of the turn when a poll takes the prepare, not when it was queued', async () => {
    fakeClock()
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const sandbox = { ...f.input(assignment.id).sandbox, hardTimeoutMs: 40_000 }
    const preparing = f.executor.prepare(
      f.input(assignment.id, { remainingMs: 40_000, sandbox }),
      new AbortController().signal,
    )
    const [first] = await vm.poll()
    expect(first).toMatchObject({ type: 'prepare', remainingMs: 40_000, ttlMs: 40_000 })
    // The answer of that poll never reached the runner: the prepare waits 10 s for the next one.
    f.hub.requeue('sandbox-1', vm.runnerSession, [first!])
    await vi.advanceTimersByTimeAsync(10_000)
    const [second] = await vm.poll()
    expect(second).toMatchObject({
      type: 'prepare',
      commandId: first!.commandId,
      remainingMs: 30_000,
      ttlMs: 30_000,
      sandbox: { hardTimeoutMs: 30_000 },
    })
    await vm.report(assignment.id, {
      type: 'failed',
      commandId: first!.commandId,
      code: 'SANDBOX_COMMAND_FAILED',
    })
    await expect(preparing).rejects.toMatchObject({ code: 'SANDBOX_COMMAND_FAILED' })
  })

  it('counts an adoption for work from its delivery too', async () => {
    fakeClock()
    const f = fixture()
    const { assignment, vm } = await f.prepared()
    const adopting = f.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'work',
        remainingMs: 50_000,
        driverId: 'codex',
        credentials,
      },
      new AbortController().signal,
    )
    await vi.advanceTimersByTimeAsync(10_000)
    const [adopt] = await vm.poll()
    expect(remaining(adopt)).toBe(40_000)
    await vm.report(
      assignment.id,
      { type: 'adopted', commandId: adopt!.commandId, containerId: 'container1' },
      2,
    )
    await expect(adopting).resolves.toMatchObject({ containerId: 'container1' })
  })

  it('never delivers a prepare whose turn ran out while it waited, and refuses it', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const preparing = f.executor.prepare(
      f.input(assignment.id, { remainingMs: 60_000 }),
      new AbortController().signal,
    )
    const [first] = await vm.poll()
    f.hub.requeue('sandbox-1', vm.runnerSession, [first!])
    // The event loop was late: the next poll comes after the turn's deadline, before its timer.
    const now = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 61_000)
    const refused = expect(preparing).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
      message: 'The turn ran out of time before a runner took it',
    })
    expect(await vm.poll()).toEqual([])
    await refused
    // Only the first delivery counts: it is the one that may have reached the runner.
    expect(f.dispatched).toHaveBeenCalledOnce()
  })

  it('takes a rejected command off the queue by its id, also the copy a poll put back', async () => {
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const cancel = new AbortController()
    const preparing = f.executor.prepare(f.input(assignment.id), cancel.signal)
    const [first] = await vm.poll()
    f.hub.requeue('sandbox-1', vm.runnerSession, [first!])
    cancel.abort(new Error('cancelled'))
    await expect(preparing).rejects.toThrow('cancelled')
    expect(await vm.poll()).toEqual([])
    expect(f.dispatched).toHaveBeenCalledOnce()
  })

  it('lets an older owner neither command nor forget a turn recovery took over', async () => {
    const f = fixture()
    const { assignment, execution, vm } = await f.prepared()
    const adopting = f.executor.adopt(
      {
        assignmentId: assignment.id,
        fence: { ...fence, epoch: 2 },
        containerId: 'container1',
        labels: { ...labels, leaseEpoch: 1 },
        purpose: 'removal',
      },
      new AbortController().signal,
    )
    const [adopt] = await vm.poll()
    // The owner of epoch 1 is refused before anything reaches the runner, under any fence.
    await expect(execution.destroy('failed')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The turn was taken over under a newer fence',
    })
    await expect(execution.quiesce()).rejects.toMatchObject({ code: 'CONFLICT' })
    const live = (f.hub as unknown as { attach: RunnerHub['attach'] }).attach({
      id: assignment.id,
      fence: { ...fence, epoch: 2 },
      runner: { id: 'sandbox-1', session: vm.runnerSession },
      credentials: [],
      remainingMs: 60_000,
    })
    f.hub.release(live, 1)
    expect(await vm.poll()).toEqual([])
    // Recovery's adoption under epoch 2 is still answered.
    await vm.report(
      assignment.id,
      { type: 'adopted', commandId: adopt!.commandId, containerId: 'container1' },
      2,
    )
    const adopted = (await adopting)!
    const destroying = adopted.destroy('failed')
    const [destroy] = await vm.poll()
    expect(destroy).toMatchObject({ type: 'destroy', fence: { epoch: 2 } })
    await vm.report(
      assignment.id,
      { type: 'destroyed', commandId: destroy!.commandId, containerId: 'container1' },
      2,
    )
    await destroying
  })
})

describe('RemoteTurnExecutor: a prepare the wire lost', () => {
  it('hands a prepare out again under its id once two polls of its runner miss it', async () => {
    fakeClock()
    const f = fixture()
    const vm = f.runner()
    const assignment = await f.open()
    const preparing = f.executor.prepare(f.input(assignment.id), new AbortController().signal)
    // Core wrote the answer, so it counts the prepare delivered; the wire lost it after that.
    const [lost] = await vm.poll()
    expect(lost).toMatchObject({ type: 'prepare', remainingMs: MAX_SANDBOX_TURN_MS })
    await vi.advanceTimersByTimeAsync(25_000)
    // One poll may have left before the answer arrived: it proves nothing yet.
    expect(await vm.poll()).toEqual([])
    await vi.advanceTimersByTimeAsync(25_000)
    const [again] = await vm.poll()
    expect(again).toMatchObject({
      type: 'prepare',
      commandId: lost!.commandId,
      remainingMs: MAX_SANDBOX_TURN_MS - 50_000,
    })
    // Handed out once as far as the turn knows: the runner drops a copy it already took.
    expect(f.dispatched).toHaveBeenCalledOnce()

    // A poll that reports the turn starts the count again.
    for (const active of [[assignment.id], [], [assignment.id], []])
      expect(await vm.poll({ capacity: 1 - active.length, active })).toEqual([])
    await vm.report(assignment.id, {
      type: 'created',
      commandId: lost!.commandId,
      containerId: 'container1',
    })
    // A prepare whose container core knows is never missing.
    expect(await vm.poll()).toEqual([])
    expect(await vm.poll()).toEqual([])
    await vm.report(assignment.id, {
      type: 'prepared',
      commandId: lost!.commandId,
      containerId: 'container1',
    })
    await expect(preparing).resolves.toMatchObject({ containerId: 'container1' })
  })

  it('gives up a prepare its runner never takes, and the runner’s slot takes the next turn', async () => {
    fakeClock()
    const f = fixture()
    const vm = f.runner()
    const first = await f.open()
    const preparing = f.executor.prepare(f.input(first.id), new AbortController().signal)
    const refused = expect(preparing).rejects.toMatchObject({
      code: 'RUNNER_UNAVAILABLE',
      message: 'The sandbox runner did not take the prepare',
    })
    const pollAt = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms - Date.now())
      return vm.poll()
    }
    const start = Date.now()
    const [lost] = await vm.poll()
    // Every copy is lost as well: the runner never holds the turn and never answers.
    for (const [at, copy] of [
      [10_000, false],
      [20_000, true],
      [40_000, false],
      [60_000, true],
      [80_000, false],
      [100_000, true],
    ] as const) {
      const commands = await pollAt(start + at)
      expect(commands.map((command) => command.commandId)).toEqual(copy ? [lost!.commandId] : [])
    }

    // Another turn now waits for this VM, the only one, with one slot.
    await vi.advanceTimersByTimeAsync(start + 110_000 - Date.now())
    const other = '00000000-0000-4000-8000-000000000004'
    const otherFence = { ...fence, siteId: other, taskId: other }
    const second = (await f.assignments.open({
      fence: otherFence,
      sessionId: 'session2',
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_TURN_MS,
    }))!
    const base = f.input(second.id)
    const next = f.executor.prepare(
      {
        ...base,
        fence: otherFence,
        sandbox: {
          ...base.sandbox,
          labels: { ...base.sandbox.labels, siteId: other, taskId: other, sessionId: 'session2' },
        },
      },
      new AbortController().signal,
    )
    // The missing prepare still takes the slot.
    expect(await pollAt(start + 115_000)).toEqual([])
    expect(f.assignments.rows.get(second.id)!.runner).toBeNull()

    // Missing for two minutes since the first poll that missed it: long before its deadline.
    expect(runnerTimings.prepareMissingMs).toBe(120_000)
    const [handed] = await pollAt(start + 130_000)
    await refused
    expect(handed).toMatchObject({ type: 'prepare', assignmentId: second.id })
    // No proof that nothing was created: the first turn vacates, and a late answer still frees it.
    expect(f.vacated).not.toHaveBeenCalled()
    await vm.report(first.id, {
      type: 'failed',
      commandId: lost!.commandId,
      code: 'SANDBOX_COMMAND_FAILED',
      absent: true,
    })
    expect(f.vacated).toHaveBeenCalledOnce()

    await vm.report(second.id, {
      type: 'prepared',
      commandId: handed!.commandId,
      containerId: 'container2',
    })
    await expect(next).resolves.toMatchObject({ containerId: 'container2' })
  })
})
