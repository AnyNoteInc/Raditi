import { BROWSER_ENSURE_JOB } from '@repo/domain'
import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import type { BrowserSessions } from './browser-sessions.ts'
import { BrowserSessionsProcessor } from './browser-sessions.processor.ts'

const taskId = '00000000-0000-4000-8000-0000000000a1'
const sessionId = '00000000-0000-4000-8000-0000000000b1'
const job = (name: string, data: unknown) => ({ name, data }) as Job

function given(status: string | null, sessions: 'configured' | null = 'configured') {
  const db = {
    task: { findUnique: vi.fn(async () => (status === null ? null : { status })) },
    $queryRaw: vi.fn(async () => []),
    browserSession: { findUnique: vi.fn(async () => null) },
  }
  const started = { start: vi.fn(async () => undefined) }
  const processor = new BrowserSessionsProcessor(
    db as never,
    sessions === null ? null : (started as unknown as BrowserSessions),
  )
  return { db, started, processor }
}

describe('the processor of the browser-sessions queue', () => {
  it('starts the session the job names', async () => {
    const { started, processor } = given('running')
    await processor.process(job(BROWSER_ENSURE_JOB, { taskId, sessionId }))
    expect(started.start).toHaveBeenCalledExactlyOnceWith(
      { taskId, sessionId },
      expect.any(AbortSignal),
    )
  })

  it.each([
    [
      'its modules are destroyed',
      (processor: BrowserSessionsProcessor) => processor.onModuleDestroy(),
    ],
    ['its worker closes', (processor: BrowserSessionsProcessor) => processor.onClosing()],
  ])('stops the starts it runs when %s', async (_case, stop) => {
    const { started, processor } = given('running')
    await processor.process(job(BROWSER_ENSURE_JOB, { taskId, sessionId }))
    const [, signal] = started.start.mock.calls[0] as unknown as [object, AbortSignal]
    expect(signal.aborted).toBe(false)
    stop(processor)
    expect(signal.aborted).toBe(true)
  })

  it.each(['done', 'failed', 'cancelled', 'rolled_back', null])(
    'starts nothing for a task that is %s',
    async (status) => {
      const { started, processor } = given(status)
      await processor.process(job(BROWSER_ENSURE_JOB, { taskId, sessionId }))
      expect(started.start).not.toHaveBeenCalled()
    },
  )

  it('closes the session at once when core has no worker: the call waits for nothing', async () => {
    const { db, processor } = given('running', null)
    await processor.process(job(BROWSER_ENSURE_JOB, { taskId, sessionId }))
    expect(db.$queryRaw).toHaveBeenCalledOnce()
  })

  it('never retries a job that cannot pass its schema or is unknown', async () => {
    const { processor } = given('running')
    await expect(processor.process(job(BROWSER_ENSURE_JOB, { taskId }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    await expect(processor.process(job('browser.other', {}))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
  })
})
