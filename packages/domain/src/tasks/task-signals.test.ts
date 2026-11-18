import { describe, expect, it } from 'vitest'

import { parseTaskSignal, readTaskSignal, taskSignalChannel } from './task-signals.ts'

const TASK = '01960000-0000-7000-8000-0000000000a1'

describe('signals of a changed chat', () => {
  it('reads the payload the triggers send, and nothing else', () => {
    expect(parseTaskSignal(`${TASK}:feed`)).toEqual({ taskId: TASK, kind: 'feed' })
    expect(parseTaskSignal(`${TASK.toUpperCase()}:activity`)).toEqual({
      taskId: TASK,
      kind: 'activity',
    })
    for (const payload of ['', TASK, `${TASK}:`, `${TASK}:other`, 'x:feed', `${TASK}x:feed`])
      expect(parseTaskSignal(payload)).toBeNull()
  })

  it('names one channel per task, whatever the case of its id', () => {
    expect(taskSignalChannel(TASK.toUpperCase())).toBe(`raditi:task:${TASK}`)
    expect(readTaskSignal('feed')).toBe('feed')
    expect(readTaskSignal('resync')).toBeNull()
  })
})
