import { Logger } from '@nestjs/common'
import { renewalJobs } from '@repo/billing'
import { UnrecoverableError, type Job } from 'bullmq'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { BillingProcessor } from './billing.processor.ts'

const job = (name: string) => ({ name, id: `repeat:billing.${name}:1`, data: {} }) as Job

function setup() {
  const run = vi.fn((_job: string, _signal?: AbortSignal) => Promise.resolve())
  return { processor: new BillingProcessor({ run }), run }
}

beforeAll(() => {
  Logger.overrideLogger(false)
})

describe('BillingProcessor', () => {
  it.each(renewalJobs)('runs the pass the job %s names', async (name) => {
    const { processor, run } = setup()

    await processor.process(job(name))

    expect(run).toHaveBeenCalledExactlyOnceWith(name, expect.any(AbortSignal))
    expect(run.mock.calls[0]?.[1]?.aborted).toBe(false)
  })

  it('fails a job of a pass it does not know for good, without running anything', async () => {
    const { processor, run } = setup()

    await expect(processor.process(job('refunds'))).rejects.toBeInstanceOf(UnrecoverableError)

    expect(run).not.toHaveBeenCalled()
  })

  it('lets a failed pass fail its job: the next tick does the work again', async () => {
    const { processor, run } = setup()
    run.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))

    await expect(processor.process(job('charges'))).rejects.toThrow('connect ECONNREFUSED')
    // Reported, never thrown from the listeners.
    expect(() =>
      processor.onFailed(job('charges'), new Error('connect ECONNREFUSED')),
    ).not.toThrow()
    expect(() => processor.onFailed(undefined, new Error('stalled'))).not.toThrow()
    expect(() => processor.onError(new Error('Connection is closed.'))).not.toThrow()
  })

  it('tells the running pass to stop when the worker starts closing', async () => {
    const { processor, run } = setup()
    let signal: AbortSignal | undefined
    let finish: () => void = () => {}
    run.mockImplementationOnce((_name, given) => {
      signal = given
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    })

    const running = processor.process(job('charges'))
    expect(signal?.aborted).toBe(false)
    processor.onClosing()
    expect(signal?.aborted).toBe(true)
    finish()
    await running

    // A job the worker still picked up while closing starts already stopped.
    await processor.process(job('notices'))
    expect(run.mock.calls[1]?.[1]?.aborted).toBe(true)
  })
})
