import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  assertPreviewTransition,
  canPreviewTransition,
  previewDbModes,
  previewNextStatuses,
  previewSessionKinds,
  previewShowsRevision,
  previewStatuses,
  previewUnavailableReasons,
} from './preview-state.ts'

describe('preview statuses', () => {
  it('lists the statuses, modes and kinds of the plan', () => {
    expect(previewStatuses).toEqual([
      'pending',
      'building',
      'ready',
      'failed',
      'unavailable',
      'expired',
      'destroyed',
    ])
    expect(previewDbModes).toEqual(['copy', 'none'])
    expect(previewSessionKinds).toEqual(['user', 'browser'])
    expect(previewUnavailableReasons).toEqual(['no_database', 'no_core', 'not_supported'])
  })

  it('builds, serves, rebuilds and stops', () => {
    for (const [from, to] of [
      ['pending', 'building'],
      ['building', 'ready'],
      ['ready', 'building'],
      ['ready', 'expired'],
      ['expired', 'building'],
      ['building', 'unavailable'],
      ['unavailable', 'building'],
      ['failed', 'building'],
    ] as const)
      expect(canPreviewTransition(from, to), `${from} → ${to}`).toBe(true)
  })

  it('never serves without a build and never comes back from destroyed', () => {
    expect(canPreviewTransition('pending', 'ready')).toBe(false)
    expect(canPreviewTransition('expired', 'ready')).toBe(false)
    expect(previewNextStatuses('destroyed')).toEqual([])
    for (const status of previewStatuses)
      if (status !== 'destroyed') expect(canPreviewTransition(status, 'destroyed')).toBe(true)
  })

  it('throws a conflict on a move it does not allow', () => {
    try {
      assertPreviewTransition('destroyed', 'building')
      expect.unreachable()
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe('CONFLICT')
    }
  })

  it('shows a revision only when ready, clean and built to it', () => {
    const ready = { status: 'ready' as const, revision: 3, dirty: false }
    expect(previewShowsRevision(ready, 3)).toBe(true)
    expect(previewShowsRevision(ready, 2)).toBe(false)
    expect(previewShowsRevision({ ...ready, dirty: true }, 3)).toBe(false)
    expect(previewShowsRevision({ ...ready, status: 'building' }, 3)).toBe(false)
    expect(previewShowsRevision({ ...ready, revision: null }, 3)).toBe(false)
  })
})
