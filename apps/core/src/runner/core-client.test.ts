import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:net'

import { MAX_SANDBOX_TURN_MS, type TurnOutputBatch, type TurnPlan } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hashRunnerToken, parseRunnerTokens } from '../config/runner-tokens.ts'
import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { RunnerApiServer } from '../runner-api/runner-api.server.ts'
import { RunnerAuthenticator } from '../runner-api/runner-auth.ts'
import { RunnerHub } from '../runner-api/runner-hub.ts'
import { sampleDriverId } from '../testing/ids.ts'
import {
  baseSha,
  bundleBytes,
  events,
  fence,
  home,
  image,
  labels,
  prepareInput,
  sandboxSide,
} from '../testing/runner-sandbox.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import {
  HttpRunnerTransport,
  RunnerCallError,
  runnerRefusal,
  SandboxRunner,
} from '@repo/runner-engine'

const token = `rnr_sandbox-1.${randomBytes(32).toString('base64url')}`
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

async function core() {
  const assignments = new MemoryTurnAssignments()
  const leases = { assert: vi.fn(async () => true) }
  const hub = new RunnerHub({ assignments, leases, logger: { warn: vi.fn() } })
  const server = new RunnerApiServer(
    hub,
    new RunnerAuthenticator(parseRunnerTokens(`sandbox-1:${hashRunnerToken(token)}`).hashes),
    { warn: vi.fn() },
  )
  const { port } = await server.listen(0, '127.0.0.1')
  closers.push(() => server.close())
  const transport = (secret = token) => {
    const client = new HttpRunnerTransport({
      coreUrl: new URL(`http://127.0.0.1:${port}`),
      token: secret,
    })
    closers.push(() => client.close())
    return client
  }
  return {
    assignments,
    hub,
    port,
    transport,
    executor: new RemoteTurnExecutor(hub, leases, assignments),
  }
}

describe('HttpRunnerTransport', () => {
  it('carries a whole turn between a runner and core over HTTP with the VM token', async () => {
    const c = await core()
    const side = sandboxSide()
    side.finish()
    const imported: Buffer[] = []
    side.importBundle.mockImplementation(async (_sandbox, bundle) => {
      for await (const chunk of bundle.read()) imported.push(Buffer.from(chunk))
    })
    const runner = new SandboxRunner({
      transport: c.transport(),
      executor: side.executor,
      maxTurns: 1,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    runner.start()
    closers.push(() => runner.stop())
    const assignment = (await c.assignments.open({
      fence,
      sessionId: labels.sessionId,
      turn: 1,
      executor: 'runner',
      plan: {} as TurnPlan,
      remainingMs: MAX_SANDBOX_TURN_MS,
    }))!

    const execution = await c.executor.prepare(
      prepareInput(assignment.id),
      new AbortController().signal,
    )
    const agent = await execution.launch(60_000)
    const journal: TurnOutputBatch[] = []
    await agent.output(async (batch) => void journal.push(batch))
    await execution.quiesce()
    const captured = await execution.capture({ home, baseSha })
    const key = new Uint8Array(32).fill(5)
    const sealed = await execution.seal({
      base: {
        workspaceId: labels.workspaceId,
        sessionId: labels.sessionId,
        turn: 1,
        image,
        driver: { id: sampleDriverId, version: '1.0.0' },
        home,
        git: {
          provider: 'gitea',
          branch: `agent/${labels.taskId}`,
          baseSha,
          headSha: 'c'.repeat(40),
        },
        schemaVersion: 1,
        createdAt: '2026-09-27T00:00:00.000Z',
      },
      dataKey: async () => key,
      put: {
        method: 'PUT',
        url: 'https://s3.invalid/raditi-sessions/sessions/session1/turns/0001/home.tar.zst?X-Amz-Signature=synthetic',
        headers: { 'if-none-match': '*' },
        expiresAt: new Date(),
      },
    })
    await execution.destroy('completed')

    expect(Buffer.concat(imported)).toEqual(bundleBytes)
    expect(journal.flatMap((batch) => batch.events)).toEqual(events)
    expect(Buffer.from(captured.patch)).toEqual(side.archives.patch)
    expect(Buffer.from(captured.untracked)).toEqual(Buffer.from(side.archives.untracked))
    expect(captured.homeBytes).toBe(side.archives.home.byteLength)
    const [put, body] = side.transfer.put.mock.calls[0]!
    expect(put.url).toContain('/turns/0001/home.tar.zst')
    expect(sealed.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    // Core zeroed its copy once it was sent; the runner zeroed its own after sealing.
    expect(key.every((byte) => byte === 0)).toBe(true)
    expect(side.sandbox.destroy).toHaveBeenCalledWith('completed')
  })

  it('refuses another token, and never names the address or the token of core', async () => {
    const c = await core()
    const request = { runnerSession: randomUUID(), inventory: [] }
    const refused = await c
      .transport(`rnr_sandbox-1.${randomBytes(32).toString('base64url')}`)
      .reconcile(request)
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RunnerCallError)
    expect(refused).toMatchObject({ status: 401, refusal: { error: 'UNAUTHORIZED' } })
    await expect(c.transport().reconcile(request)).resolves.toEqual({ remove: [] })

    // Nothing listens there.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as AddressInfo
        probe.close(() => resolve(free))
      })
    })
    const nowhere = new HttpRunnerTransport({ coreUrl: new URL(`http://127.0.0.1:${port}`), token })
    closers.push(() => nowhere.close())
    const unreachable = (await nowhere
      .reconcile(request)
      .catch((error: unknown) => error)) as RunnerCallError
    expect(unreachable).toMatchObject({ route: 'reconcile', status: null })
    expect(unreachable.message).toBe('reconcile: core unreachable')
    for (const secret of ['127.0.0.1', String(port), token, '/runner/v1'])
      expect(JSON.stringify({ ...unreachable, message: unreachable.message })).not.toContain(secret)
  })

  it('reads refusals as the protocol defines them, and anything else only as a status', () => {
    const body = (value: unknown) => Buffer.from(JSON.stringify(value))
    expect(
      runnerRefusal(
        'report',
        409,
        body({ error: 'CURSOR_MISMATCH', expected: { stdout: 7, stderr: 0 } }),
      ).refusal,
    ).toEqual({ error: 'CURSOR_MISMATCH', expected: { stdout: 7, stderr: 0 } })
    expect(runnerRefusal('report', 410, body({ error: 'COMMAND_CLOSED' })).refusal).toEqual({
      error: 'COMMAND_CLOSED',
    })
    const odd = runnerRefusal('report', 502, Buffer.from('<html>proxy error</html>'))
    expect(odd).toMatchObject({ status: 502, refusal: undefined, message: 'report: 502' })
    expect(runnerRefusal('report', 409, body({ error: 'LEASE_LOST', extra: 1 })).refusal).toBe(
      undefined,
    )
  })
})
