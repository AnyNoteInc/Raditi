import { UnrecoverableError, type Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { LeadsProcessor } from './leads.processor.ts'
import { LeadsScheduler, LEADS_POLL_EVERY_MS, LEADS_POLL_SCHEDULER_ID } from './leads-scheduler.ts'

const ID = '01900000-0000-7000-8000-000000000001'
const job = (name: string, data: unknown = {}) => ({ name, data, id: '1' }) as Job

describe('LeadsProcessor', () => {
  const stand = () => {
    const jobs = { send: vi.fn(async () => {}), poll: vi.fn(async () => 0) }
    return { jobs, processor: new LeadsProcessor(jobs) }
  }

  it('sends the lead its job names and polls on a poll', async () => {
    const s = stand()
    await s.processor.process(job('lead.send', { leadId: ID }))
    await s.processor.process(job('lead.poll'))
    expect(s.jobs.send).toHaveBeenCalledWith(ID)
    expect(s.jobs.poll).toHaveBeenCalledOnce()
  })

  it('fails at once a job it cannot do later either', async () => {
    const s = stand()
    await expect(s.processor.process(job('lead.other'))).rejects.toBeInstanceOf(UnrecoverableError)
    await expect(s.processor.process(job('lead.send', { leadId: 'nope' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    expect(s.jobs.send).not.toHaveBeenCalled()
  })
})

describe('LeadsScheduler', () => {
  it('registers one poll every five seconds with a single attempt', async () => {
    const queue = { upsertJobScheduler: vi.fn(async () => ({}) as never) }
    expect(await new LeadsScheduler(queue, true).register()).toBe(true)
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      LEADS_POLL_SCHEDULER_ID,
      { every: LEADS_POLL_EVERY_MS },
      {
        name: 'lead.poll',
        opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 3600 } },
      },
    )
  })

  it('registers nothing without background work', () => {
    const queue = { upsertJobScheduler: vi.fn() }
    new LeadsScheduler(queue, false).onApplicationBootstrap()
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled()
  })
})
