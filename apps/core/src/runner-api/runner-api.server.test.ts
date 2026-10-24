import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'

import {
  MAX_SANDBOX_TURN_MS,
  runnerApiPaths,
  runnerBundlePath,
  runnerCandidatePath,
  runnerHeaders,
  runnerKeyPath,
  SANDBOX_SECRETS_DIR,
  snapshotLimits,
  type RunnerCommand,
  type TurnPlan,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hashRunnerToken, parseRunnerTokens } from '../config/runner-tokens.ts'
import { sampleDriverId } from '../testing/ids.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RemoteTurnExecutor } from './remote-turn-executor.ts'
import { RunnerApiServer } from './runner-api.server.ts'
import { RunnerAuthenticator } from './runner-auth.ts'
import { RunnerHub } from './runner-hub.ts'

const siteId = '00000000-0000-4000-8000-000000000002'
const taskId = '00000000-0000-4000-8000-000000000003'
const fence = { siteId, taskId, operation: 'turn' as const, epoch: 1 }
const labels = { workspaceId: 'ws1', siteId, taskId, sessionId: 'session1', turn: 1 }
const token = `rnr_sandbox-1.${'a'.repeat(43)}`
const presignedUrl =
  'https://s3.invalid/raditi-sessions/sessions/session1/turns/0000/home.tar.zst?X-Amz-Signature=synthetic-signature'

const servers: RunnerApiServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  vi.restoreAllMocks()
})

/** `binding` is appended to the runner's RUNNER_TOKENS entry: `@<address>` binds it. */
async function start(binding = '') {
  const assignments = new MemoryTurnAssignments()
  const leases = { assert: vi.fn(async () => true) }
  const warn = vi.fn()
  const hub = new RunnerHub({ assignments, leases, logger: { warn } })
  const executor = new RemoteTurnExecutor(hub, leases, assignments)
  const { hashes } = parseRunnerTokens(`sandbox-1:${hashRunnerToken(token)}${binding}`)
  const server = new RunnerApiServer(hub, new RunnerAuthenticator(hashes, { warn }), { warn })
  servers.push(server)
  const { port } = await server.listen(0, '127.0.0.1')
  const origin = `http://127.0.0.1:${port}`
  const runnerSession = randomUUID()
  const call = (path: string, init: RequestInit = {}, bearer = token) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
    })
  const json = (path: string, body: unknown, bearer = token) =>
    call(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      bearer,
    )
  const poll = async () => {
    const response = await json(runnerApiPaths.poll, {
      runnerSession,
      capacity: 1,
      inventory: [],
      active: [],
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { commands: RunnerCommand[] }).commands
  }
  const report = (assignmentId: string, body: Record<string, unknown>, epoch = 1) =>
    json(runnerApiPaths.reports, { runnerSession, assignmentId, epoch, ...body })
  const binary = (command: RunnerCommand, epoch = command.fence.epoch) => ({
    [runnerHeaders.session]: runnerSession,
    [runnerHeaders.epoch]: String(epoch),
    [runnerHeaders.command]: command.commandId,
  })

  /**
   * A turn prepared over HTTP; `restoreKey` is served for the prepare's restore. Without a
   * repository (docs/plan/57-browser-tasks.md, Б5) the prepare carries no bundle.
   */
  const prepare = async (restoreKey?: Uint8Array, { repository = true } = {}) => {
    const assignment = (await assignments.open({
      fence,
      sessionId: labels.sessionId,
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_TURN_MS,
    }))!
    const bundle = Buffer.from('synthetic bundle bytes')
    const preparing = executor.prepare(
      {
        assignmentId: assignment.id,
        fence,
        sandbox: {
          image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
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
        ...(repository
          ? {
              bundle: {
                baseSha: 'b'.repeat(40),
                branch: `agent/${taskId}`,
                sha256: createHash('sha256').update(bundle).digest('hex'),
                sizeBytes: bundle.byteLength,
                read: async function* () {
                  yield bundle.subarray(0, 5)
                  yield bundle.subarray(5)
                },
              },
            }
          : {}),
        ...(restoreKey
          ? {
              restore: {
                manifest: {
                  workspaceId: 'ws1',
                  sessionId: 'session1',
                  turn: 1,
                  image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
                  driver: { id: sampleDriverId, version: '1.0.0' },
                  home: {
                    root: `/agent-home/${sampleDriverId}`,
                    include: [
                      '.local/share/opencode/opencode.db',
                      '.local/share/opencode/opencode.db-wal',
                    ],
                    exclude: [],
                  },
                  git: {
                    provider: 'gitea',
                    branch: `agent/${taskId}`,
                    baseSha: 'b'.repeat(40),
                    headSha: 'b'.repeat(40),
                  },
                  schemaVersion: 1,
                  createdAt: '2026-09-27T00:00:00.000Z',
                  parts: ['home', 'untracked', 'patch'].map((name) => ({
                    name,
                    key: `sessions/session1/turns/0001/${name === 'patch' ? 'patch.diff' : `${name}.tar.zst`}`,
                    sha256: 'd'.repeat(64),
                    sizeBytes: 10,
                    encryption: {
                      algorithm: 'aes-256-gcm',
                      keyId: 'ws-ws1',
                      wrappedKey: 'vault:v1:wrapped',
                      iv: 'e'.repeat(24),
                      tag: 'f'.repeat(32),
                    },
                  })),
                } as never,
                parts: {
                  home: { method: 'GET', url: presignedUrl, headers: {}, expiresAt: new Date() },
                  untracked: {
                    method: 'GET',
                    url: presignedUrl,
                    headers: {},
                    expiresAt: new Date(),
                  },
                  patch: { method: 'GET', url: presignedUrl, headers: {}, expiresAt: new Date() },
                },
                dataKey: async () => restoreKey,
              },
            }
          : {}),
        driverId: sampleDriverId,
        prepared: {
          files: [],
          env: {},
          secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: 'synthetic-llm-secret' }],
        },
        argv: ['opencode'],
        credentials: ['synthetic-llm-secret', 'synthetic-mcp-secret'],
        created: async () => {},
        dispatched: () => {},
        vacated: () => {},
      },
      new AbortController().signal,
    )
    const [command] = await poll()
    return { assignment, preparing, command: command!, bundle }
  }

  return {
    hub,
    executor,
    assignments,
    leases,
    warn,
    runnerSession,
    call,
    json,
    poll,
    report,
    binary,
    prepare,
  }
}

describe('RunnerApiServer', () => {
  it('answers nothing but 401 without a valid runner token, on every path', async () => {
    const f = await start()
    for (const bearer of ['', `rnr_sandbox-1.${'b'.repeat(43)}`, `rnr_sandbox-2.${'a'.repeat(43)}`])
      for (const path of [runnerApiPaths.poll, '/runner/v1/unknown', '/health']) {
        const response = await f.json(path, {}, bearer)
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' })
        expect(response.headers.get('cache-control')).toBe('no-store')
      }
  })

  it('takes a token bound to a VM address only from that address, as the socket reports it', async () => {
    // A known path would wait for commands: an unknown one answers 404 once the runner is known.
    const bound = await start('@127.0.0.1')
    expect((await bound.json('/runner/v1/unknown', {})).status).toBe(404)
    const elsewhere = await start('@10.20.0.11')
    const refused = await elsewhere.json('/runner/v1/unknown', {})
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: 'UNAUTHORIZED' })
    expect(elsewhere.warn).toHaveBeenCalledWith(
      'runner sandbox-1: token from another address 127.0.0.1',
    )
    expect(JSON.stringify(elsewhere.warn.mock.calls)).not.toContain(token.slice(token.indexOf('.')))
  })

  it('refuses unknown paths, query strings, foreign bodies and oversized requests', async () => {
    const f = await start()
    expect((await f.json('/runner/v1/unknown', {})).status).toBe(404)
    expect((await f.json(`${runnerApiPaths.poll}?debug=1`, {})).status).toBe(404)
    expect((await f.call(runnerApiPaths.poll)).status).toBe(404)
    const text = await f.call(runnerApiPaths.poll, { method: 'POST', body: '{}' })
    expect(text.status).toBe(400)
    expect(await text.json()).toEqual({ error: 'BAD_REQUEST' })
    const malformed = await f.call(runnerApiPaths.poll, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    const extra = await f.json(runnerApiPaths.poll, {
      runnerSession: randomUUID(),
      capacity: 1,
      inventory: [],
      active: [],
      debug: true,
    })
    expect(extra.status).toBe(400)
    const huge = await f.json(runnerApiPaths.reports, { padding: 'x'.repeat(2 * 1024 * 1024) })
    expect(huge.status).toBe(413)
    expect(await huge.json()).toEqual({ error: 'TOO_LARGE' })
  })

  it('serves a prepare: its bundle, its restore key once zeroed, and the answers', async () => {
    const key = new Uint8Array(32).fill(9)
    const f = await start()
    const { assignment, preparing, command, bundle } = await f.prepare(key)
    expect(command.type).toBe('prepare')
    expect(JSON.stringify(command)).toContain('X-Amz-Signature')

    const served = await f.call(runnerBundlePath(assignment.id), { headers: f.binary(command) })
    expect(served.status).toBe(200)
    expect(served.headers.get('cache-control')).toBe('no-store')
    expect(served.headers.get('content-length')).toBe(String(bundle.byteLength))
    expect(Buffer.from(await served.arrayBuffer())).toEqual(bundle)

    const missing = await f.call(runnerKeyPath(assignment.id, 'restore'))
    expect(missing.status).toBe(400)
    const answer = await f.call(runnerKeyPath(assignment.id, 'restore'), {
      headers: f.binary(command),
    })
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('application/octet-stream')
    expect(answer.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await answer.arrayBuffer())).toEqual(Buffer.alloc(32, 9))
    await vi.waitFor(() => expect(key.every((byte) => byte === 0)).toBe(true))
    const seal = await f.call(runnerKeyPath(assignment.id, 'seal'), { headers: f.binary(command) })
    expect(seal.status).toBe(410)
    expect(await seal.json()).toEqual({ error: 'COMMAND_CLOSED' })

    for (const type of ['created', 'prepared'])
      expect(
        (
          await f.report(assignment.id, {
            type,
            commandId: command.commandId,
            containerId: 'container1',
          })
        ).status,
      ).toBe(200)
    await expect(preparing).resolves.toMatchObject({ containerId: 'container1' })
  })

  it('answers stale epochs, foreign sessions and output gaps with 409 bodies', async () => {
    const f = await start()
    const { assignment, preparing, command } = await f.prepare()
    await f.report(assignment.id, {
      type: 'prepared',
      commandId: command.commandId,
      containerId: 'container1',
    })
    const execution = await preparing
    const launching = execution.launch(60_000)
    const [launch] = await f.poll()
    await f.report(assignment.id, {
      type: 'running',
      commandId: launch!.commandId,
      execId: 'exec1',
    })
    const agent = await launching
    void agent.output(async () => {})
    const output = (from: number, to: number) => ({
      type: 'output',
      execId: 'exec1',
      from: { stdout: from, stderr: 0 },
      to: { stdout: to, stderr: 0 },
      events: [],
    })
    expect((await f.report(assignment.id, output(0, 10))).status).toBe(200)
    const gap = await f.report(assignment.id, output(20, 30))
    expect(gap.status).toBe(409)
    expect(await gap.json()).toEqual({
      error: 'CURSOR_MISMATCH',
      expected: { stdout: 10, stderr: 0 },
    })

    // Recovery took the turn over under epoch 2.
    void f.executor
      .adopt(
        {
          assignmentId: assignment.id,
          fence: { ...fence, epoch: 2 },
          containerId: 'container1',
          labels: { ...labels, leaseEpoch: 1 },
          purpose: 'removal',
        },
        new AbortController().signal,
      )
      .catch(() => {})
    const stale = await f.report(assignment.id, output(10, 20))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'FENCE_SUPERSEDED', fence: { ...fence, epoch: 2 } })
    const foreign = await f.json(runnerApiPaths.reports, {
      runnerSession: randomUUID(),
      assignmentId: assignment.id,
      epoch: 2,
      ...output(10, 20),
    })
    expect(foreign.status).toBe(409)
    expect(await foreign.json()).toEqual({ error: 'SESSION_RETIRED' })
  })

  it('puts back the commands of a poll whose connection closed before its answer', async () => {
    const f = await start()
    const commands = [{ commandId: randomUUID() }] as unknown as RunnerCommand[]
    const polling = Promise.withResolvers<void>()
    vi.spyOn(f.hub, 'poll').mockImplementationOnce(async (_runnerId, _request, signal) => {
      polling.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return { commands }
    })
    const requeue = vi.spyOn(f.hub, 'requeue').mockImplementation(() => {})
    const client = new AbortController()
    const answered = f
      .call(runnerApiPaths.poll, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runnerSession: f.runnerSession,
          capacity: 1,
          inventory: [],
          active: [],
        }),
        signal: client.signal,
      })
      .then(
        () => 'answered',
        () => 'aborted',
      )
    await polling.promise
    client.abort()
    expect(await answered).toBe('aborted')
    await vi.waitFor(() =>
      expect(requeue).toHaveBeenCalledExactlyOnceWith('sandbox-1', f.runnerSession, commands),
    )
  })

  it('asks runners to retry while core shuts down, never tells them their turns are lost', async () => {
    const f = await start()
    const waiting = f.poll()
    await vi.waitFor(() => expect(f.hub.session('sandbox-1')).toBe(f.runnerSession))
    // The hub closes first; the listener still takes requests until the server closes.
    f.hub.close()
    expect(await waiting).toEqual([])
    for (const response of [
      await f.json(runnerApiPaths.poll, {
        runnerSession: f.runnerSession,
        capacity: 1,
        inventory: [],
        active: [],
      }),
      await f.report(randomUUID(), { type: 'quiesced', commandId: randomUUID() }),
      await f.json(runnerApiPaths.reconcile, { runnerSession: f.runnerSession, inventory: [] }),
    ]) {
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'UNAVAILABLE' })
    }
    expect(f.warn).not.toHaveBeenCalled()
  })

  it('takes a capture upload only up to its limit', async () => {
    const f = await start()
    const { assignment, preparing, command } = await f.prepare()
    await f.report(assignment.id, {
      type: 'prepared',
      commandId: command.commandId,
      containerId: 'container1',
    })
    const execution = await preparing
    void execution
      .capture({
        home: {
          root: `/agent-home/${sampleDriverId}`,
          include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
          exclude: [],
        },
        baseSha: 'b'.repeat(40),
      })
      .catch(() => {})
    const [capture] = await f.poll()
    const put = (part: 'patch' | 'untracked', body: Uint8Array) =>
      f.call(runnerCandidatePath(assignment.id, part), {
        method: 'PUT',
        headers: { ...f.binary(capture!), 'content-type': 'application/octet-stream' },
        body,
      })
    const tooLarge = await put('patch', new Uint8Array(snapshotLimits.patchBytes + 1))
    expect(tooLarge.status).toBe(413)
    expect((await put('patch', Buffer.from('patch'))).status).toBe(200)
    expect((await put('untracked', new Uint8Array(snapshotLimits.patchBytes + 1))).status).toBe(200)
  })

  it('closes the bundle and candidate paths of a turn without a repository (plan 57, Б5)', async () => {
    const f = await start()
    const { assignment, preparing, command } = await f.prepare(undefined, { repository: false })
    expect(command).not.toHaveProperty('bundle')
    const bundle = await f.call(runnerBundlePath(assignment.id), { headers: f.binary(command) })
    expect(bundle.status).toBe(410)
    expect(await bundle.json()).toEqual({ error: 'COMMAND_CLOSED' })
    await f.report(assignment.id, {
      type: 'prepared',
      commandId: command.commandId,
      containerId: 'container1',
    })
    const execution = await preparing
    const capturing = execution.capture({
      home: {
        root: `/agent-home/${sampleDriverId}`,
        include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
        exclude: [],
      },
    })
    const [capture] = await f.poll()
    expect(capture).toMatchObject({ type: 'capture' })
    expect(capture).not.toHaveProperty('baseSha')
    for (const part of ['patch', 'untracked'] as const) {
      const put = await f.call(runnerCandidatePath(assignment.id, part), {
        method: 'PUT',
        headers: { ...f.binary(capture!), 'content-type': 'application/octet-stream' },
        body: Buffer.from('untrusted'),
      })
      expect(put.status).toBe(410)
      expect(await put.json()).toEqual({ error: 'COMMAND_CLOSED' })
    }
    const answered = await f.report(assignment.id, {
      type: 'captured',
      commandId: capture!.commandId,
      homeBytes: 12,
    })
    expect(answered.status).toBe(200)
    await expect(capturing).resolves.toEqual({ homeBytes: 12 })
  })

  it('logs a failed request by its code only: no URL, key or runner text', async () => {
    const f = await start()
    vi.spyOn(f.hub, 'report').mockRejectedValue(new Error(`upstream said ${presignedUrl}`))
    const response = await f.report(randomUUID(), {
      type: 'failed',
      code: 'EXEC_LOST',
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'INTERNAL' })
    expect(f.warn).toHaveBeenCalledOnce()
    const logged = JSON.stringify(f.warn.mock.calls)
    expect(logged).not.toContain('X-Amz')
    expect(logged).not.toContain('upstream said')
  })
})
