import { describe, expect, it } from 'vitest'

import { queueNames } from '../ports/job-queue.ts'
import {
  PREVIEW_BROWSER_JOB,
  PREVIEW_QUEUE,
  PREVIEW_SYNC_JOB,
  previewBrowserDedupeKey,
  previewBrowserJobSchema,
  previewSyncDedupeKey,
  previewSyncJobSchema,
} from './preview-job.ts'

const previewId = '0196abcd-0000-7000-8000-00000000000a'
const requestId = '0196abcd-0000-7000-8000-00000000000b'

describe('preview jobs', () => {
  it('runs on the previews queue under the names of the plan', () => {
    expect(queueNames).toContain(PREVIEW_QUEUE)
    expect([PREVIEW_SYNC_JOB, PREVIEW_BROWSER_JOB]).toEqual(['preview.sync', 'preview.browser'])
  })

  it('carries ids only', () => {
    expect(previewSyncJobSchema.parse({ previewId, revision: 0, seq: 1 })).toEqual({
      previewId,
      revision: 0,
      seq: 1,
    })
    expect(
      previewSyncJobSchema.safeParse({ previewId, revision: 1, seq: 1, path: '/x' }).success,
    ).toBe(false)
    expect(previewSyncJobSchema.safeParse({ previewId, revision: -1, seq: 1 }).success).toBe(false)
    expect(previewBrowserJobSchema.safeParse({ previewId, requestId }).success).toBe(true)
  })

  it('keys every step of the outbox apart', () => {
    expect(previewSyncDedupeKey({ previewId, revision: 2, seq: 3 })).toBe(
      `preview.sync:${previewId}:2:3`,
    )
    expect(previewSyncDedupeKey({ previewId, revision: 2, seq: 4 })).not.toBe(
      previewSyncDedupeKey({ previewId, revision: 2, seq: 3 }),
    )
    expect(previewBrowserDedupeKey({ previewId, requestId })).toBe(
      `preview.browser:${previewId}:${requestId}`,
    )
  })
})
