// RunnerTransport straight into a RunnerHub, for *.test.ts files: the runner and core in one
// process, with the answers the HTTP server would give (runner-api.server.ts) and wire copies of
// every body, so neither side shares objects with the other.
import { Buffer } from 'node:buffer'

import {
  runnerPollRequestSchema,
  runnerReconcileRequestSchema,
  runnerReportSchema,
} from '@repo/domain'
import { ZodError } from 'zod'

import { RunnerApiError } from '../runner-api/runner-api-error.ts'
import type { RunnerBinaryHeaders, RunnerHub } from '../runner-api/runner-hub.ts'
import { RunnerCallError, type RunnerCommandFence, type RunnerTransport } from './runner-side.ts'

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * A request of a connection that drops fails as if core were unreachable; a long poll ends
 * empty instead, so that the runner polls the next core without its backoff.
 */
function dropped<T>(connection: AbortSignal, route: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const drop = () =>
      route === 'poll' ? resolve({ commands: [] } as T) : reject(new RunnerCallError(route, null))
    if (connection.aborted) drop()
    else connection.addEventListener('abort', drop, { once: true })
  })
}

async function answerOn<T>(
  route: string,
  call: () => Promise<T>,
  connection: AbortSignal,
): Promise<T> {
  try {
    return await Promise.race([call(), dropped<T>(connection, route)])
  } catch (error) {
    if (error instanceof RunnerCallError) throw error
    if (error instanceof RunnerApiError) throw new RunnerCallError(route, error.status, error.body)
    if (error instanceof ZodError) throw new RunnerCallError(route, 400, { error: 'BAD_REQUEST' })
    throw new RunnerCallError(route, 500, { error: 'INTERNAL' })
  }
}

const headers = (fence: RunnerCommandFence): RunnerBinaryHeaders => ({
  session: fence.session,
  epoch: String(fence.epoch),
  command: fence.command,
})

export interface LoopbackTransport extends RunnerTransport {
  /** The core the runner talks to; a test swaps it to restart core. */
  hub: RunnerHub
  /** Core died: requests in flight fail as unreachable, the next ones reach `hub`. */
  reconnect(hub: RunnerHub): void
  /** Every data key the runner got, to check that it zeroed each one. */
  readonly keys: Uint8Array[]
  /** Called before each request reaches core: a test may throw a RunnerCallError here. */
  intercept?: (route: string, body?: unknown) => void
}

export function loopbackTransport(hub: RunnerHub, runnerId = 'sandbox-1'): LoopbackTransport {
  let connection = new AbortController()
  const answer = <T>(route: string, call: () => Promise<T>) =>
    answerOn(route, call, connection.signal)
  const transport: LoopbackTransport = {
    hub,
    reconnect(next) {
      connection.abort()
      connection = new AbortController()
      transport.hub = next
    },
    keys: [],
    poll: (request, signal) =>
      answer('poll', async () => {
        transport.intercept?.('poll', request)
        return wire(
          await transport.hub.poll(runnerId, runnerPollRequestSchema.parse(wire(request)), signal),
        )
      }),
    report: (report) =>
      answer('report', async () => {
        transport.intercept?.('report', report)
        await transport.hub.report(runnerId, runnerReportSchema.parse(wire(report)))
      }),
    reconcile: (request) =>
      answer('reconcile', async () => {
        transport.intercept?.('reconcile', request)
        return wire(
          await transport.hub.reconcile(
            runnerId,
            runnerReconcileRequestSchema.parse(wire(request)),
          ),
        )
      }),
    async *bundle(assignmentId, fence, sizeBytes) {
      const source = await answer('bundle', async () => {
        transport.intercept?.('bundle')
        return transport.hub.bundle(runnerId, assignmentId, headers(fence))
      })
      let sent = 0
      for await (const chunk of source.read()) {
        sent += chunk.byteLength
        if (sent > sizeBytes) throw new RunnerCallError('bundle', 200)
        yield Buffer.from(chunk)
      }
    },
    key: (assignmentId, purpose, fence) =>
      answer('key', async () => {
        transport.intercept?.('key')
        const key = await transport.hub.key(runnerId, assignmentId, purpose, headers(fence))
        // As the server does: the runner gets a copy, core's buffer is zeroed once sent.
        const copy = Uint8Array.from(key)
        key.fill(0)
        transport.keys.push(copy)
        return copy
      }),
    candidate: (assignmentId, part, fence, body) =>
      answer('candidate', async () => {
        transport.intercept?.('candidate')
        const store = await transport.hub.candidate(runnerId, assignmentId, part, headers(fence))
        store(Buffer.from(body))
      }),
  }
  return transport
}
