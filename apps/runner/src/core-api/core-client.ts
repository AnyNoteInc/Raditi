import { Buffer } from 'node:buffer'
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'

import {
  runnerApiPaths,
  runnerBundlePath,
  runnerInboxPath,
  runnerCandidatePath,
  runnerConflictSchema,
  runnerErrorSchema,
  runnerHeaders,
  runnerKeyPath,
  runnerLimits,
  runnerTimings,
  type RunnerApiErrorCode,
  type RunnerConflict,
  type RunnerPollRequest,
  type RunnerReport,
  type runnerReconcileRequestSchema,
} from '@repo/domain'
import type { z } from 'zod'

export type RunnerReconcileRequest = z.infer<typeof runnerReconcileRequestSchema>
export type CandidatePart = 'patch' | 'untracked'
export type RunnerRefusal = RunnerConflict | { error: RunnerApiErrorCode }

/** What authorizes a binary request: this runner session, the command's epoch and its id. */
export interface RunnerCommandFence {
  session: string
  epoch: number
  command: string
}

/**
 * The runner's side of core's runner API (spec §8 «Раннер на песочной ВМ»). Answers are
 * returned unchecked: the runner validates them with the protocol schemas.
 */
export interface RunnerTransport {
  poll(request: RunnerPollRequest, signal: AbortSignal): Promise<unknown>
  report(report: RunnerReport): Promise<void>
  reconcile(request: RunnerReconcileRequest): Promise<unknown>
  /** The base bundle of an open prepare; never more than `sizeBytes`. */
  bundle(
    assignmentId: string,
    fence: RunnerCommandFence,
    sizeBytes: number,
  ): AsyncIterable<Uint8Array>
  /** A file of the client of an open prepare, by its place in the command; exactly `sizeBytes`. */
  inbox(
    assignmentId: string,
    index: number,
    fence: RunnerCommandFence,
    sizeBytes: number,
  ): AsyncIterable<Uint8Array>
  /** Exactly 32 bytes; the caller zeroes them right after use. */
  key(
    assignmentId: string,
    purpose: 'restore' | 'seal',
    fence: RunnerCommandFence,
  ): Promise<Uint8Array>
  candidate(
    assignmentId: string,
    part: CandidatePart,
    fence: RunnerCommandFence,
    body: Uint8Array,
  ): Promise<void>
}

/**
 * A failed call to core: its route, the status (null when core was not reached) and core's
 * refusal. Never the URL, the token or anything sent or received besides the refusal.
 */
export class RunnerCallError extends Error {
  constructor(
    readonly route: string,
    readonly status: number | null,
    readonly refusal?: RunnerRefusal,
  ) {
    super(`${route}: ${status === null ? 'core unreachable' : (refusal?.error ?? status)}`)
    this.name = 'RunnerCallError'
  }
}

/** Parses a refusal body; anything else is only its status. */
export function runnerRefusal(route: string, status: number, body: Buffer): RunnerCallError {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return new RunnerCallError(route, status)
  }
  const conflict = status === 409 ? runnerConflictSchema.safeParse(parsed) : undefined
  if (conflict?.success) return new RunnerCallError(route, status, conflict.data)
  const error = runnerErrorSchema.safeParse(parsed)
  return new RunnerCallError(route, status, error.success ? error.data : undefined)
}

const REQUEST_MS = 60_000
/** A long poll is held up to pollHoldMs; the socket may stay silent that long. */
const POLL_MS = runnerTimings.pollHoldMs + 15_000
const TRANSFER_MS = 5 * 60_000
/** 64 commands, prepares with their files among them. */
const POLL_ANSWER_BYTES = 32 * 1024 * 1024
const REFUSAL_BYTES = 4096
const KEY_BYTES = 32

export interface HttpRunnerTransportOptions {
  /** RUNNER_CORE_URL: the origin of core's runner API. */
  coreUrl: URL
  /** `rnr_<runner id>.<secret>` from RUNNER_TOKEN_FILE. */
  token: string
  /** RUNNER_CORE_CA_FILE: a private CA for core's certificate. */
  ca?: Uint8Array | null
}

async function readAll(
  route: string,
  response: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of response as AsyncIterable<Buffer>) {
      total += chunk.byteLength
      if (total > maxBytes) throw new RunnerCallError(route, response.statusCode ?? null)
      chunks.push(chunk)
    }
  } catch (error) {
    response.destroy()
    throw error instanceof RunnerCallError ? error : new RunnerCallError(route, null)
  }
  return Buffer.concat(chunks, total)
}

/**
 * RunnerTransport over HTTP(S) with keep-alive, on node:http so that bodies, long polls and
 * the private CA stay under explicit control. Request URLs, the token, data keys and bodies
 * never reach an error or a log.
 */
export class HttpRunnerTransport implements RunnerTransport {
  readonly #base: URL
  readonly #authorization: string
  readonly #agent: HttpAgent
  readonly #request: typeof httpRequest

  constructor(options: HttpRunnerTransportOptions) {
    this.#base = new URL(options.coreUrl)
    const https = this.#base.protocol === 'https:'
    this.#agent = https
      ? new HttpsAgent({ keepAlive: true, ...(options.ca ? { ca: Buffer.from(options.ca) } : {}) })
      : new HttpAgent({ keepAlive: true })
    this.#request = https ? httpsRequest : httpRequest
    this.#authorization = `Bearer ${options.token}`
  }

  close(): void {
    this.#agent.destroy()
  }

  poll(request: RunnerPollRequest, signal: AbortSignal): Promise<unknown> {
    return this.#json('poll', runnerApiPaths.poll, request, {
      signal,
      timeoutMs: POLL_MS,
      maxBytes: POLL_ANSWER_BYTES,
    })
  }

  async report(report: RunnerReport): Promise<void> {
    await this.#json('report', runnerApiPaths.reports, report)
  }

  reconcile(request: RunnerReconcileRequest): Promise<unknown> {
    return this.#json('reconcile', runnerApiPaths.reconcile, request)
  }

  async *bundle(
    assignmentId: string,
    fence: RunnerCommandFence,
    sizeBytes: number,
  ): AsyncIterable<Uint8Array> {
    const response = await this.#answer('bundle', 'GET', runnerBundlePath(assignmentId), {
      headers: fenceHeaders(fence),
      timeoutMs: TRANSFER_MS,
    })
    let total = 0
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        total += chunk.byteLength
        if (total > sizeBytes) throw new RunnerCallError('bundle', 200)
        yield chunk
      }
    } catch (error) {
      throw error instanceof RunnerCallError ? error : new RunnerCallError('bundle', null)
    } finally {
      response.destroy()
    }
  }

  async *inbox(
    assignmentId: string,
    index: number,
    fence: RunnerCommandFence,
    sizeBytes: number,
  ): AsyncIterable<Uint8Array> {
    const response = await this.#answer('inbox', 'GET', runnerInboxPath(assignmentId, index), {
      headers: fenceHeaders(fence),
      timeoutMs: TRANSFER_MS,
    })
    let total = 0
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        total += chunk.byteLength
        if (total > sizeBytes) throw new RunnerCallError('inbox', 200)
        yield chunk
      }
      if (total !== sizeBytes) throw new RunnerCallError('inbox', 200)
    } catch (error) {
      throw error instanceof RunnerCallError ? error : new RunnerCallError('inbox', null)
    } finally {
      response.destroy()
    }
  }

  async key(
    assignmentId: string,
    purpose: 'restore' | 'seal',
    fence: RunnerCommandFence,
  ): Promise<Uint8Array> {
    const response = await this.#answer('key', 'GET', runnerKeyPath(assignmentId, purpose), {
      headers: fenceHeaders(fence),
    })
    const chunks: Buffer[] = []
    let total = 0
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        chunks.push(chunk)
        total += chunk.byteLength
        if (total > KEY_BYTES) break
      }
      if (total !== KEY_BYTES) throw new RunnerCallError('key', 200)
      const key = new Uint8Array(KEY_BYTES)
      let offset = 0
      for (const chunk of chunks) {
        key.set(chunk, offset)
        offset += chunk.byteLength
      }
      return key
    } catch (error) {
      throw error instanceof RunnerCallError ? error : new RunnerCallError('key', null)
    } finally {
      // Only the returned copy holds the key; the caller zeroes it.
      for (const chunk of chunks) chunk.fill(0)
      response.destroy()
    }
  }

  async candidate(
    assignmentId: string,
    part: CandidatePart,
    fence: RunnerCommandFence,
    body: Uint8Array,
  ): Promise<void> {
    const response = await this.#answer(
      'candidate',
      'PUT',
      runnerCandidatePath(assignmentId, part),
      {
        headers: {
          ...fenceHeaders(fence),
          'content-type': 'application/octet-stream',
          'content-length': String(body.byteLength),
        },
        body,
        timeoutMs: TRANSFER_MS,
      },
    )
    await readAll('candidate', response, REFUSAL_BYTES)
  }

  async #json(
    route: string,
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(body))
    const response = await this.#answer(route, 'POST', path, {
      headers: { 'content-type': 'application/json', 'content-length': String(payload.byteLength) },
      body: payload,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    })
    const answer = await readAll(route, response, options.maxBytes ?? runnerLimits.bodyBytes)
    try {
      return JSON.parse(answer.toString('utf8'))
    } catch {
      throw new RunnerCallError(route, 200)
    }
  }

  /** A 200 answer; any other status is read as a refusal and thrown. */
  async #answer(
    route: string,
    method: string,
    path: string,
    options: {
      headers: Record<string, string>
      body?: Uint8Array
      signal?: AbortSignal
      timeoutMs?: number
    },
  ): Promise<IncomingMessage> {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const unreachable = () => reject(new RunnerCallError(route, null))
      let request: ReturnType<typeof httpRequest>
      try {
        request = this.#request(new URL(path, this.#base), {
          method,
          agent: this.#agent,
          headers: { ...options.headers, authorization: this.#authorization },
          timeout: options.timeoutMs ?? REQUEST_MS,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      } catch {
        unreachable()
        return
      }
      request.once('response', resolve)
      request.once('error', unreachable)
      request.once('timeout', () => request.destroy())
      request.end(options.body)
    })
    if (response.statusCode !== 200)
      throw runnerRefusal(
        route,
        response.statusCode ?? 500,
        await readAll(route, response, REFUSAL_BYTES).catch(() => Buffer.alloc(0)),
      )
    return response
  }
}

function fenceHeaders(fence: RunnerCommandFence): Record<string, string> {
  return {
    [runnerHeaders.session]: fence.session,
    [runnerHeaders.epoch]: String(fence.epoch),
    [runnerHeaders.command]: fence.command,
  }
}
