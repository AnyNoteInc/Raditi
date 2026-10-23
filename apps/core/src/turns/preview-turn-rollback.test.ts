import { describe, expect, it, vi } from 'vitest'

import { PreviewTurnRollback } from './preview-turn-rollback.ts'

const fence = {
  siteId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61',
  taskId: '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60',
  operation: 'turn' as const,
  epoch: 3,
}

describe('PreviewTurnRollback', () => {
  it('refuses to replace a turn whose writes reached the production site', async () => {
    const $transaction = vi.fn()
    const db = { $queryRaw: vi.fn(async () => [{ writes: true }]), $transaction }

    await expect(
      new PreviewTurnRollback(db as never).rollback({ fence, turn: 2 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect($transaction).not.toHaveBeenCalled()
  })
})
