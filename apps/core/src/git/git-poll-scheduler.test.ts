import { Logger } from '@nestjs/common'
import { REPO_POLL_EVERY_MS } from '@repo/domain'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  GIT_POLL_SCHEDULER_ID,
  GIT_POLL_SCHEDULER_RETRY_MS,
  GitPollScheduler,
} from './git-poll-scheduler.ts'

const schedulers: GitPollScheduler[] = []

function setup(background = true, fail = 0) {
  let failures = fail
  const upsert = vi.fn(() =>
    failures-- > 0 ? Promise.reject(new Error('redis is away')) : Promise.resolve({ id: 'job' }),
  )
  const scheduler = new GitPollScheduler({ upsertJobScheduler: upsert as never }, background)
  schedulers.push(scheduler)
  return { scheduler, upsert }
}

beforeAll(() => {
  Logger.overrideLogger(false)
})
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.onModuleDestroy()
  vi.useRealTimers()
})

// The tick of `git.poll` (docs/plan/84-projects.md, ПР17; slice 84.21).
describe('GitPollScheduler', () => {
  it('upserts one scheduler of git.poll every 30 s with one attempt', async () => {
    const { scheduler, upsert } = setup()
    expect(await scheduler.register()).toBe(true)
    expect(upsert).toHaveBeenCalledWith(
      GIT_POLL_SCHEDULER_ID,
      { every: REPO_POLL_EVERY_MS },
      expect.objectContaining({
        name: 'git.poll',
        data: {},
        opts: expect.objectContaining({ attempts: 1 }),
      }),
    )
    expect(REPO_POLL_EVERY_MS).toBe(30_000)
  })

  it('registers nothing without background work', () => {
    const { scheduler, upsert } = setup(false)
    scheduler.onApplicationBootstrap()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('tries again after a failed registration', async () => {
    vi.useFakeTimers()
    const { scheduler, upsert } = setup(true, 1)
    expect(await scheduler.register()).toBe(false)
    await vi.advanceTimersByTimeAsync(GIT_POLL_SCHEDULER_RETRY_MS)
    expect(upsert).toHaveBeenCalledTimes(2)
  })
})
