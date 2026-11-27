import { feedCandidateText } from '@repo/domain/tasks/client-feed-labels'
import { describe, expect, it } from 'vitest'

import { legacyRowText, type LegacyRow } from './feed-legacy'
import { candidateRow } from './testing'

describe('the rows of the sites of before (P33.7)', () => {
  it('reads a candidate as its title and one line of what it changed', () => {
    const shown = legacyRowText(candidateRow('6', 1) as LegacyRow)
    expect(shown.title).toBe(feedCandidateText.title)
    expect(shown.text.length).toBeGreaterThan(0)
    expect(shown.failed).toBe(false)
  })

  it('reads a press of the client without a title', () => {
    const shown = legacyRowText({
      id: '8',
      at: '2026-10-17T09:10:00.000Z',
      type: 'feed.decision',
      kind: 'release',
      authorId: '0199a3f2-0000-7000-8000-0000000000a1',
      revision: 1,
      version: 'v1.4.0',
    } as LegacyRow)
    expect(shown).toEqual({ title: null, text: 'Вы решили выпустить версию 1.4.0.', failed: false })
  })

  it('marks an update that failed as a failure', () => {
    const update = (outcome: 'conflict' | 'current') =>
      legacyRowText({
        id: '14',
        at: '2026-10-17T09:50:00.000Z',
        type: 'feed.update',
        outcome,
        conflicts: 1,
      } as LegacyRow).failed
    expect(update('conflict')).toBe(true)
    expect(update('current')).toBe(false)
  })
})
