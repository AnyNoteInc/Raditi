import { describe, expect, it } from 'vitest'

import { workspaceTransitKey } from './workspace-transit-key.ts'

describe('workspaceTransitKey', () => {
  it('names the Transit key of a workspace: turn and content snapshots share it', () => {
    expect(workspaceTransitKey('01960000-0000-7000-8000-000000000003')).toBe(
      'ws-01960000-0000-7000-8000-000000000003',
    )
    // The Vault adapter refuses an unsafe name before any request; this only spells it.
    expect(workspaceTransitKey('ws1')).toBe('ws-ws1')
  })
})
