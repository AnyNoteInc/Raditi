import { describe, expect, it } from 'vitest'

import { queueNames } from '../ports/job-queue.ts'
import {
  RELEASE_ADVANCE_JOB,
  RELEASE_QUEUE,
  releaseAdvanceDedupeKey,
  releaseAdvanceJobSchema,
} from './release-job.ts'

const id = '0196abcd-0000-7000-8000-00000000000a'

describe('the release job', () => {
  it('runs on deploys as release.advance with ids and the state it was put for', () => {
    expect(queueNames).toContain(RELEASE_QUEUE)
    expect(RELEASE_ADVANCE_JOB).toBe('release.advance')
    expect(
      releaseAdvanceJobSchema.safeParse({
        releaseId: id,
        status: 'deploying',
        step: 'files',
        seq: 1,
      }).success,
    ).toBe(true)
    expect(
      releaseAdvanceJobSchema.safeParse({ releaseId: id, status: 'approved', step: null, seq: 1 })
        .success,
    ).toBe(true)
    expect(
      releaseAdvanceJobSchema.safeParse({
        releaseId: id,
        status: 'approved',
        step: null,
        seq: 1,
        tag: 'v1.0.0',
      }).success,
    ).toBe(false)
  })

  it('keys the step and the counter, so a repeated wake-up is not lost', () => {
    expect(
      releaseAdvanceDedupeKey({ releaseId: id, status: 'deploying', step: 'files', seq: 2 }),
    ).toBe(`release.advance:${id}:deploying:files:2`)
    expect(releaseAdvanceDedupeKey({ releaseId: id, status: 'approved', step: null, seq: 1 })).toBe(
      `release.advance:${id}:approved:-:1`,
    )
  })
})
