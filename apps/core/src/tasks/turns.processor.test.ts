import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_JOB,
  CANDIDATE_EDIT_JOB,
  CHAT_NOTIFY_JOB,
  QUEUE_DRAIN_JOB,
  CANDIDATE_REBASE_JOB,
  CANDIDATE_REWIND_JOB,
} from '@repo/domain'
import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { AGENT_TURN_LOCK_MS, TurnsProcessor } from './turns.processor.ts'

const TASK = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const job = (name: string, data: unknown) => ({ name, data }) as Job

function processor() {
  const passes = { run: vi.fn(async () => {}), cancel: vi.fn(async () => {}) }
  const queue = { run: vi.fn(async () => 'moved' as const) }
  const notify = { run: vi.fn(async () => 'sent' as const) }
  return { passes, queue, notify, processor: new TurnsProcessor(passes, queue, notify) }
}

describe('TurnsProcessor', () => {
  it('tells the client of a chat that waits by its job (docs/plan/75, ВВ6)', async () => {
    const { notify, processor: worker } = processor()
    const job_ = { taskId: TASK, kind: 'answered' as const, attempt: 1, turnNo: 1 }
    await worker.process(job(CHAT_NOTIFY_JOB, job_))
    expect(notify.run).toHaveBeenCalledWith(job_)
  })

  it('drains the queue of a chat by its job (docs/plan/75, ВВ2)', async () => {
    const { queue, processor: worker } = processor()
    await worker.process(job(QUEUE_DRAIN_JOB, { taskId: TASK, attempt: 2, turnNo: 3 }))
    expect(queue.run).toHaveBeenCalledWith({ taskId: TASK, attempt: 2, turnNo: 3 })
  })

  it('runs a pass and a cancel by the name of the job', async () => {
    const { passes, processor: worker } = processor()

    await worker.process(job(AGENT_TURN_JOB, { taskId: TASK, attempt: 1, requestEventId: '7' }))
    await worker.process(job(AGENT_TURN_CANCEL_JOB, { taskId: TASK, requestEventId: '8' }))

    expect(passes.run).toHaveBeenCalledWith({ taskId: TASK, attempt: 1, requestEventId: '7' })
    expect(passes.cancel).toHaveBeenCalledWith({ taskId: TASK, requestEventId: '8' })
  })

  it('never takes a job of a repository: projects are gone (docs/plan/83-remove-projects.md)', async () => {
    const { processor: worker } = processor()
    const EDIT = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
    for (const [name, data] of [
      [CANDIDATE_REBASE_JOB, { taskId: TASK, requestEventId: '9' }],
      [CANDIDATE_REWIND_JOB, { taskId: TASK, requestEventId: '10' }],
      [CANDIDATE_EDIT_JOB, { taskId: TASK, editId: EDIT }],
    ] as const)
      await expect(worker.process(job(name, data))).rejects.toBeInstanceOf(UnrecoverableError)
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

  it('keeps a lock BullMQ renews while the worker lives, whatever the length of the pass', () => {
    // A pass has no time limit (plan 70, ВР8): the lock is not sized after one.
    expect(AGENT_TURN_LOCK_MS).toBe(5 * 60_000)
  })
})
