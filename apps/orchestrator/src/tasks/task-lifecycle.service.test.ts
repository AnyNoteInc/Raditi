import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'

import { TaskLifecycleService } from './task-lifecycle.service.ts'
import { TasksModule } from './tasks.module.ts'

describe('TaskLifecycleService', () => {
  const lifecycle = new TaskLifecycleService()

  it('follows the main path of spec §7', () => {
    const path = [
      'queued',
      'preparing',
      'running',
      'awaiting_approval',
      'deploying',
      'verifying',
      'done',
    ] as const
    for (let i = 1; i < path.length; i += 1) {
      const from = path[i - 1]
      const to = path[i]
      if (!from || !to) throw new Error('unreachable')
      expect(lifecycle.canTransition(from, to)).toBe(true)
      expect(() => lifecycle.assertTransition(from, to)).not.toThrow()
    }
  })

  it('rejects a transition the state machine does not allow with CONFLICT', () => {
    expect(lifecycle.canTransition('done', 'queued')).toBe(false)
    expect(() => lifecycle.assertTransition('queued', 'deploying')).toThrow(
      expect.objectContaining({ code: 'CONFLICT', httpStatus: 409 }),
    )
  })

  it('knows terminal statuses and the next steps', () => {
    expect(lifecycle.isTerminal('rolled_back')).toBe(true)
    expect(lifecycle.isTerminal('awaiting_user')).toBe(false)
    expect(lifecycle.nextStatuses('awaiting_approval')).toEqual([
      'deploying',
      'queued',
      'cancelled',
    ])
  })

  it('is provided by TasksModule', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TasksModule] }).compile()

    expect(moduleRef.get(TaskLifecycleService)).toBeInstanceOf(TaskLifecycleService)
    await moduleRef.close()
  })
})
