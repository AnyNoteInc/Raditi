import { randomUUID } from 'node:crypto'

import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { SiteImportProcessor } from './site-import.processor.ts'

const job = (name: string, data: unknown) => ({ name, data, id: 'job-1' }) as Job

describe('SiteImportProcessor', () => {
  it('hands the site of a job to the runner, in lower case', async () => {
    const run = vi.fn(async () => 'succeeded' as const)
    const processor = new SiteImportProcessor({ run })
    const siteId = randomUUID()

    await processor.process(
      job('site.provision', { siteId: siteId.toUpperCase(), stage: 'code_import' }),
    )

    expect(run).toHaveBeenCalledExactlyOnceWith(siteId, expect.any(AbortSignal))
  })

  it.each([
    ['an unknown job name', job('site.other', { siteId: randomUUID(), stage: 'code_import' })],
    [
      'a payload with more than ids',
      job('site.provision', { siteId: randomUUID(), stage: 'code_import', host: 'x' }),
    ],
    ['a site that is not an id', job('site.provision', { siteId: 'site', stage: 'code_import' })],
  ])('fails %s at once, without a retry', async (_, invalid) => {
    const run = vi.fn()
    await expect(new SiteImportProcessor({ run }).process(invalid)).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves a database_schema job alone: that stage is not of this queue', async () => {
    const run = vi.fn()
    await new SiteImportProcessor({ run }).process(
      job('site.provision', { siteId: randomUUID(), stage: 'database_schema' }),
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('aborts the running imports when the worker closes, so they release their stages', async () => {
    let signal: AbortSignal | undefined
    let release: (() => void) | undefined
    const run = vi.fn(
      (_: string, shutdown: AbortSignal) =>
        new Promise<'released'>((resolve) => {
          signal = shutdown
          release = () => resolve('released')
          shutdown.addEventListener('abort', () => release?.())
        }),
    )
    const processor = new SiteImportProcessor({ run })
    const processing = processor.process(
      job('site.provision', { siteId: randomUUID(), stage: 'code_import' }),
    )
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal!.aborted).toBe(false)

    processor.onClosing()

    await processing
    expect(signal!.aborted).toBe(true)
  })

  it('aborts them already when the modules of core are destroyed', () => {
    let signal: AbortSignal | undefined
    const processor = new SiteImportProcessor({
      run: vi.fn(async (_: string, shutdown: AbortSignal) => {
        signal = shutdown
        return 'skipped' as const
      }),
    })
    void processor.process(job('site.provision', { siteId: randomUUID(), stage: 'code_import' }))
    processor.onModuleDestroy()
    expect(signal?.aborted).toBe(true)
  })
})
