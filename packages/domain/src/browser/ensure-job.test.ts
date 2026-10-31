import { describe, expect, it } from 'vitest'

import { queueNames } from '../ports/job-queue.ts'
import {
  BROWSER_ENSURE_JOB,
  BROWSER_ENSURE_WINDOW_MS,
  BROWSER_SESSION_QUEUE,
  browserEnsureDedupeKey,
  browserEnsureJobSchema,
  browserEnsureWindow,
} from './ensure-job.ts'

const job = {
  taskId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60',
  sessionId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a63',
}

describe('the job that starts a browser', () => {
  it('has a queue of its own: turns waiting for a browser never hold the job that starts it', () => {
    expect(queueNames).toContain(BROWSER_SESSION_QUEUE)
    expect(BROWSER_SESSION_QUEUE).not.toBe('agent-turns')
    expect(BROWSER_SESSION_QUEUE).not.toBe('previews')
  })

  it('carries two ids and nothing else', () => {
    expect(browserEnsureJobSchema.parse(job)).toEqual(job)
    expect(browserEnsureJobSchema.safeParse({ ...job, signIn: 'x' }).success).toBe(false)
    expect(browserEnsureJobSchema.safeParse({ taskId: job.taskId }).success).toBe(false)
  })

  it('takes one key per session and window: a second call of the window is the same job', () => {
    const at = new Date('2026-10-31T10:00:10.000Z')
    const window = browserEnsureWindow(at)
    expect(browserEnsureWindow(new Date(at.getTime() + 5_000))).toBe(window)
    expect(browserEnsureWindow(new Date(at.getTime() + BROWSER_ENSURE_WINDOW_MS))).toBe(window + 1)
    expect(browserEnsureDedupeKey(job, window)).toBe(
      `${BROWSER_ENSURE_JOB}:${job.sessionId}:${window}`,
    )
  })
})
