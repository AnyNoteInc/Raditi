import {
  DomainError,
  leaseLost,
  runnerLimits,
  type AgentEvent,
  type TurnOutputBatch,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { ExecStream } from './exec-stream.ts'
import { RunnerApiError } from './runner-api-error.ts'

const message = (text: string): AgentEvent => ({ type: 'message', text })
const batch = (from: number, to: number, events: AgentEvent[] = [message(`line ${to}`)]) => ({
  from: { stdout: from, stderr: 0 },
  to: { stdout: to, stderr: 0 },
  events,
})
const start = { execId: 'exec1', cursor: { stdout: 0, stderr: 0 }, eventCount: 0 }

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(RunnerApiError)
  return (error as RunnerApiError).body
}

function reading(credentials: string[] = []) {
  const stream = new ExecStream(start, credentials)
  const journal: TurnOutputBatch[] = []
  const record = vi.fn(async (value: TurnOutputBatch) => {
    journal.push(value)
  })
  const ended = stream.consume(record)
  return { stream, journal, record, ended }
}

describe('ExecStream', () => {
  it('journals batches from the cursor, acknowledges replays and asks for a gap to be re-read', async () => {
    const { stream, journal, record } = reading()
    await stream.deliver(batch(0, 10))
    await stream.deliver(batch(0, 10))
    await stream.deliver(batch(5, 10))
    expect(await refusal(stream.deliver(batch(20, 30)))).toEqual({
      error: 'CURSOR_MISMATCH',
      expected: { stdout: 10, stderr: 0 },
    })
    await stream.deliver(batch(10, 20))
    expect(record).toHaveBeenCalledTimes(2)
    expect(journal.map((entry) => entry.to.stdout)).toEqual([10, 20])
    expect(stream.cursor).toEqual({ stdout: 20, stderr: 0 })
  })

  it('journals a retry that overtakes its original only once', async () => {
    const { stream, record } = reading()
    const slow = Promise.withResolvers<void>()
    record.mockImplementationOnce(() => slow.promise)
    const first = stream.deliver(batch(0, 10))
    const retry = stream.deliver(batch(0, 10))
    slow.resolve()
    await Promise.all([first, retry])
    expect(record).toHaveBeenCalledOnce()
  })

  it('waits for the supervisor to read and resumes from a journal cursor', async () => {
    const stream = new ExecStream(
      { execId: 'exec1', cursor: { stdout: 40, stderr: 3 }, eventCount: runnerLimits.events - 1 },
      [],
    )
    const delivered = stream.deliver({
      from: { stdout: 40, stderr: 3 },
      to: { stdout: 50, stderr: 3 },
      events: [message('after restart')],
    })
    const record = vi.fn(async () => {})
    void stream.consume(record)
    await delivered
    expect(record).toHaveBeenCalledOnce()
    // The event limit spans the reconnect.
    expect(
      await refusal(
        stream.deliver({
          from: { stdout: 50, stderr: 3 },
          to: { stdout: 60, stderr: 3 },
          events: [message('one too many')],
        }),
      ),
    ).toEqual({ error: 'COMMAND_CLOSED' })
  })

  it('answers UNAVAILABLE while nobody reads the output yet', async () => {
    const stream = new ExecStream(start, [], 10)
    expect(await refusal(stream.deliver(batch(0, 10)))).toEqual({ error: 'UNAVAILABLE' })
    const record = vi.fn(async () => {})
    void stream.consume(record)
    await stream.deliver(batch(0, 10))
    expect(record).toHaveBeenCalledOnce()
  })

  it('refuses output with a turn credential whatever the runner filtered', async () => {
    const { stream, record, ended } = reading(['synthetic-llm-secret'])
    expect(
      await refusal(
        stream.deliver(
          batch(0, 10, [{ type: 'command', command: 'echo synthetic-llm-secret', exitCode: 0 }]),
        ),
      ),
    ).toEqual({ error: 'COMMAND_CLOSED' })
    expect(record).not.toHaveBeenCalled()
    await expect(ended).rejects.toMatchObject({ code: 'TURN_OUTPUT_REJECTED' })
    expect(await stream.wait()).toEqual({ code: null, reason: 'lost' })
  })

  it('tells the runner to remove the container only when the lease was lost', async () => {
    const lost = reading()
    lost.record.mockRejectedValue(leaseLost())
    expect(await refusal(lost.stream.deliver(batch(0, 10)))).toEqual({ error: 'LEASE_LOST' })
    await expect(lost.ended).rejects.toMatchObject({ code: 'LEASE_LOST' })

    const interrupted = reading()
    interrupted.record.mockRejectedValue(new DomainError('TURN_INTERRUPTED', 'lease_lost', 409))
    expect(await refusal(interrupted.stream.deliver(batch(0, 10)))).toEqual({
      error: 'LEASE_LOST',
    })

    const outage = reading()
    outage.record.mockRejectedValue(new Error('database unavailable'))
    expect(await refusal(outage.stream.deliver(batch(0, 10)))).toEqual({ error: 'COMMAND_CLOSED' })
    await expect(outage.ended).rejects.toThrow('database unavailable')
    // Journaled batches stay acknowledged; nothing new is taken.
    expect(await refusal(outage.stream.deliver(batch(10, 20)))).toEqual({ error: 'COMMAND_CLOSED' })
  })

  it('ends the output with the exit, after the batches before it', async () => {
    const { stream, journal, record, ended } = reading()
    const slow = Promise.withResolvers<void>()
    record.mockImplementationOnce(async (value) => {
      await slow.promise
      journal.push(value)
    })
    const delivered = stream.deliver(batch(0, 10))
    const exited = stream.exited({ code: 0, reason: 'exited' })
    let done = false
    void ended.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    slow.resolve()
    await Promise.all([delivered, exited, ended])
    expect(journal).toHaveLength(1)
    expect(await stream.wait()).toEqual({ code: 0, reason: 'exited' })
    await stream.deliver(batch(0, 10))
    expect(await refusal(stream.deliver(batch(10, 20)))).toEqual({ error: 'COMMAND_CLOSED' })
  })
})
