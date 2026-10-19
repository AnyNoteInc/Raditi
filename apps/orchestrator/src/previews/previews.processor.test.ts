import { PREVIEW_BROWSER_JOB, PREVIEW_SYNC_JOB } from '@repo/domain'
import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import type { PreviewManager } from './preview-manager.ts'
import { PreviewsProcessor } from './previews.processor.ts'

const previewId = '00000000-0000-4000-8000-0000000000a1'
const requestId = '00000000-0000-4000-8000-0000000000b1'
const job = (name: string, data: unknown) => ({ name, data }) as Job

describe('the processor of the previews queue', () => {
  it('reads the preview a job names and asks the manager', async () => {
    const manager = {
      refresh: vi.fn(() => Promise.resolve(true)),
      serveBrowser: vi.fn(() => Promise.resolve(true)),
    }
    const processor = new PreviewsProcessor(manager as unknown as PreviewManager)
    await processor.process(job(PREVIEW_SYNC_JOB, { previewId, revision: 3, seq: 2 }))
    await processor.process(job(PREVIEW_BROWSER_JOB, { previewId, requestId }))
    expect(manager.refresh).toHaveBeenCalledWith(previewId, { requested: true })
    expect(manager.serveBrowser).toHaveBeenCalledWith(requestId)
  })

  it('never retries a job that cannot pass its schema or is unknown', async () => {
    const processor = new PreviewsProcessor(null)
    await expect(
      processor.process(job(PREVIEW_SYNC_JOB, { previewId: 'x' })),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(processor.process(job('preview.other', {}))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    // Previews are off here: a valid job is dropped.
    await expect(
      processor.process(job(PREVIEW_SYNC_JOB, { previewId, revision: 0, seq: 1 })),
    ).resolves.toBeUndefined()
  })
})
