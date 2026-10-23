import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { fakeCoreServer } from '../testing/fake-core-server.ts'
import { HttpRunnerTransport, RunnerCallError, runnerRefusal } from './core-client.ts'

const token = `rnr_sandbox-1.${randomBytes(32).toString('base64url')}`
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** Core's runner API with this VM token, and transports to it with a token of choice. */
async function core() {
  const server = await fakeCoreServer({ token })
  closers.push(() => server.close())
  const transport = (secret = token) => {
    const client = new HttpRunnerTransport({ coreUrl: server.url, token: secret })
    closers.push(() => client.close())
    return client
  }
  return { transport }
}

describe('HttpRunnerTransport', () => {
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
