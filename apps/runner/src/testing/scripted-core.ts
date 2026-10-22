// A core in memory for the runner's tests: the runner protocol of @repo/domain without core's
// code. Only for *.test.ts.
import { Buffer } from 'node:buffer'

import type { RunnerPollRequest, RunnerReport } from '@repo/domain'
import { bundleBytes } from '@repo/local-turns/testing'
import { expect, vi } from 'vitest'

import { RunnerCallError, type RunnerTransport } from '../core-api/core-client.ts'

interface WaitingPoll {
  answer(commands: unknown[]): void
  /** Core wrote its answer: from now on a dropped connection loses it. */
  sent: boolean
}

/**
 * A core that answers only what a test sends it: polls wait for `send`, reports are kept. Like
 * the hub, a newer poll of the session answers the older ones empty, and like HTTP, a poll the
 * runner aborts after core wrote its answer loses that answer.
 */
export function scriptedCore() {
  const polls: RunnerPollRequest[] = []
  const reports: RunnerReport[] = []
  const waiting: WaitingPoll[] = []
  const transport = {
    poll: vi.fn((request: RunnerPollRequest, abort: AbortSignal) => {
      polls.push(structuredClone(request))
      for (const older of waiting.splice(0)) older.answer([])
      return new Promise<unknown>((resolve, reject) => {
        const poll: WaitingPoll = { answer: (commands) => resolve({ commands }), sent: false }
        waiting.push(poll)
        abort.addEventListener(
          'abort',
          () => {
            const index = waiting.indexOf(poll)
            if (index >= 0) waiting.splice(index, 1)
            // Written already: the answer goes down with the connection. Otherwise core requeues.
            if (poll.sent) reject(new RunnerCallError('poll', null))
            else resolve({ commands: [] })
          },
          { once: true },
        )
      })
    }),
    report: vi.fn(async (report: RunnerReport) => {
      reports.push(structuredClone(report))
    }),
    reconcile: vi.fn(async () => ({ remove: [] })),
    bundle: async function* () {
      yield Buffer.from(bundleBytes)
    },
    key: vi.fn(async (): Promise<Uint8Array> => new Uint8Array(32).fill(7)),
    candidate: vi.fn(async () => {}),
  } satisfies RunnerTransport
  return {
    transport,
    polls,
    reports,
    types: () => reports.map((report) => report.type),
    /** Answers the runner's waiting poll. */
    async send(...commands: unknown[]) {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
      waiting.shift()!.answer(commands)
    },
    /** Answers the waiting poll with `commands` that reach the runner only on `arrive()`. */
    async sendSlowly(...commands: unknown[]) {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
      const poll = waiting.shift()!
      poll.sent = true
      return { arrive: () => poll.answer(commands) }
    },
  }
}
