import { RELEASE_ADVANCE_JOB, RELEASE_UNDO_PLAN_JOB } from '@repo/domain'
import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { ReleasesProcessor } from './releases.processor.ts'

const RELEASE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const job = (name: string, data: unknown) => ({ name, data }) as Job

function processor() {
  const skill = { advance: vi.fn(async () => {}) }
  const planner = { plan: vi.fn(async () => {}) }
  return { skill, planner, processor: new ReleasesProcessor(skill, planner) }
}

describe('ReleasesProcessor', () => {
  it('hands the skill the id of the release and the counter of its wake-up', async () => {
    const { skill, processor: worker } = processor()
    const data = { releaseId: RELEASE, status: 'deploying', step: 'files', seq: 4 }
    await worker.process(job(RELEASE_ADVANCE_JOB, data))
    expect(skill.advance).toHaveBeenCalledWith(data)
  })

  it('hands the planner of an undo the id of its plan', async () => {
    const { skill, planner, processor: worker } = processor()
    await worker.process(job(RELEASE_UNDO_PLAN_JOB, { planId: RELEASE, seq: 2 }))
    expect(planner.plan).toHaveBeenCalledWith({ planId: RELEASE, seq: 2 })
    await expect(
      worker.process(job(RELEASE_UNDO_PLAN_JOB, { planId: RELEASE, seq: 0 })),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(skill.advance).not.toHaveBeenCalled()
  })

  it('never retries a payload that fails its schema or a job it does not know', async () => {
    const { skill, processor: worker } = processor()
    for (const data of [
      { releaseId: RELEASE, status: 'approved', step: null, seq: 0 },
      { releaseId: RELEASE, status: 'approved', step: null, seq: 1, sha: 'a'.repeat(40) },
      { releaseId: 'nope', status: 'approved', step: null, seq: 1 },
    ])
      await expect(worker.process(job(RELEASE_ADVANCE_JOB, data))).rejects.toBeInstanceOf(
        UnrecoverableError,
      )
    await expect(worker.process(job('deploy.start', {}))).rejects.toBeInstanceOf(UnrecoverableError)
    expect(skill.advance).not.toHaveBeenCalled()
  })

  it('lets a failed run fail its job: the sweeper wakes the release again', async () => {
    const { skill, processor: worker } = processor()
    skill.advance.mockRejectedValueOnce(new Error('database is down'))
    await expect(
      worker.process(
        job(RELEASE_ADVANCE_JOB, { releaseId: RELEASE, status: 'approved', step: null, seq: 1 }),
      ),
    ).rejects.toThrow('database is down')
  })
})
