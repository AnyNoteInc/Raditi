import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_JOB,
  CANDIDATE_REBASE_JOB,
  MAX_SANDBOX_TURN_MS,
  TURN_PUBLICATION_GRACE_MS,
} from '@repo/domain'
import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { AGENT_TURN_LOCK_MS, TurnsProcessor } from './turns.processor.ts'

const TASK = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const job = (name: string, data: unknown) => ({ name, data }) as Job

function processor() {
  const passes = { run: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }
  const rebase = { run: vi.fn(async () => 'rebased' as const) }
  return { passes, rebase, processor: new TurnsProcessor(passes, rebase) }
}

describe('TurnsProcessor', () => {
  it('runs a pass, a cancel and an update by the name of the job', async () => {
    const { passes, rebase, processor: worker } = processor()

    await worker.process(job(AGENT_TURN_JOB, { taskId: TASK, attempt: 1, requestEventId: '7' }))
    await worker.process(job(AGENT_TURN_CANCEL_JOB, { taskId: TASK, requestEventId: '8' }))
    await worker.process(job(CANDIDATE_REBASE_JOB, { taskId: TASK, requestEventId: '9' }))

    expect(passes.run).toHaveBeenCalledWith({ taskId: TASK, attempt: 1, requestEventId: '7' })
    expect(passes.cancel).toHaveBeenCalledWith({ taskId: TASK, requestEventId: '8' })
    expect(rebase.run).toHaveBeenCalledWith({ taskId: TASK, requestEventId: '9' })
  })

  it('never retries a payload that fails its schema or a job it does not know', async () => {
    const { passes, processor: worker } = processor()

    await expect(
      worker.process(job(AGENT_TURN_JOB, { taskId: TASK, attempt: 0, requestEventId: '7' })),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(
      worker.process(
        job(AGENT_TURN_JOB, { taskId: TASK, attempt: 1, requestEventId: '7', text: 'слова' }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(worker.process(job('turn.unknown', {}))).rejects.toBeInstanceOf(UnrecoverableError)
    expect(passes.run).not.toHaveBeenCalled()
  })

  it('holds the lock of a job past the longest turn and its publication', () => {
    expect(AGENT_TURN_LOCK_MS).toBeGreaterThan(MAX_SANDBOX_TURN_MS + TURN_PUBLICATION_GRACE_MS)
  })
})
