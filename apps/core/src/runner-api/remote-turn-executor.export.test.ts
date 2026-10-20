import { describe, expect, it } from 'vitest'

import { RemoteTurnExecutor } from './remote-turn-executor.ts'

describe('the working tree of a turn on a runner VM', () => {
  it('is refused until the runner protocol has a step for it (plan 53, M10)', async () => {
    await expect(RemoteTurnExecutor.prototype.exportWorkingTree.call({})).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
    })
  })
})
