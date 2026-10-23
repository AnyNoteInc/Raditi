// Core's runner API on loopback for the runner's tests: the paths, the bearer check and the
// refusal bodies of the protocol (@repo/domain), without core's code. Polls are held like core
// holds them, until a newer poll of the session or the end. Only for *.test.ts.
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  runnerApiErrors,
  runnerApiPaths,
  runnerPollRequestSchema,
  runnerReconcileRequestSchema,
  runnerReportSchema,
  type RunnerApiErrorCode,
  type RunnerPollRequest,
  type RunnerReport,
} from '@repo/domain'

import type { RunnerReconcileRequest } from '../core-api/core-client.ts'

export interface FakeCoreOptions {
  /** The VM token core takes; any other bearer is refused with 401 UNAUTHORIZED. */
  token: string
  /** Which reported containers core has no owner for; none unless a test names them. */
  remove?: (request: RunnerReconcileRequest) => string[]
}

export interface FakeCore {
  /** RUNNER_CORE_URL of the runner under test. */
  url: URL
  /** What core took, in order: requests with the wrong bearer are not among them. */
  polls: RunnerPollRequest[]
  reconciles: RunnerReconcileRequest[]
  reports: RunnerReport[]
  /** Requests refused for their bearer. */
  unauthorized: number
  /** Answers the polls it holds with no command and stops. */
  close(): Promise<void>
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(json.byteLength),
  })
  response.end(json)
}

const refuse = (response: ServerResponse, error: RunnerApiErrorCode) =>
  send(response, runnerApiErrors[error], { error })

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function fakeCoreServer(options: FakeCoreOptions): Promise<FakeCore> {
  const held = new Set<ServerResponse>()
  const answerHeld = () => {
    for (const response of held) send(response, 200, { commands: [] })
    held.clear()
  }
  const core: Omit<FakeCore, 'url' | 'close'> = {
    polls: [],
    reconciles: [],
    reports: [],
    unauthorized: 0,
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      core.unauthorized += 1
      request.resume()
      return refuse(response, 'UNAUTHORIZED')
    }
    if (request.method !== 'POST') return refuse(response, 'NOT_FOUND')
    const body = await readJson(request).catch(() => undefined)
    switch (request.url) {
      case runnerApiPaths.poll: {
        const poll = runnerPollRequestSchema.safeParse(body)
        if (!poll.success) return refuse(response, 'BAD_REQUEST')
        core.polls.push(poll.data)
        // A newer poll of the session answers the older one empty, as core's hub does.
        answerHeld()
        held.add(response)
        response.once('close', () => held.delete(response))
        return
      }
      case runnerApiPaths.reconcile: {
        const reconcile = runnerReconcileRequestSchema.safeParse(body)
        if (!reconcile.success) return refuse(response, 'BAD_REQUEST')
        core.reconciles.push(reconcile.data)
        return send(response, 200, { remove: options.remove?.(reconcile.data) ?? [] })
      }
      case runnerApiPaths.reports: {
        const report = runnerReportSchema.safeParse(body)
        if (!report.success) return refuse(response, 'BAD_REQUEST')
        core.reports.push(report.data)
        return send(response, 200, { ok: true })
      }
      default:
        return refuse(response, 'NOT_FOUND')
    }
  }
  const server = createServer((request, response) => void handle(request, response))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return Object.assign(core, {
    url: new URL(`http://127.0.0.1:${port}`),
    async close() {
      answerHeld()
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    },
  })
}
