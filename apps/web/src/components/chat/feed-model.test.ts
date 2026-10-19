import { describe, expect, it } from 'vitest'

import { feedReducer, initialFeedState } from './feed-state'
import {
  candidateMessage,
  feedEntries,
  liveCandidateRow,
  liveSteps,
  openQuestion,
  requestShown,
  stopRequested,
} from './feed-model'
import {
  agentQuestionRow,
  candidateHead,
  candidateRow,
  ceilingRow,
  commandRow,
  feedAnswer,
  REQUEST_ID,
  requestRow,
  resultRow,
  stepRow,
} from './testing'
import type { FeedRow } from './chat-types'

const headOf = (patch: Parameters<typeof feedAnswer>[0]) =>
  feedReducer(initialFeedState, { type: 'answer', answer: feedAnswer(patch), after: '0' }).head

describe('feedEntries', () => {
  it('folds the stages of a finished turn into one line with the time it worked', () => {
    const rows: FeedRow[] = [
      requestRow('1'),
      { ...stepRow('2', 1), at: '2026-10-17T09:00:00.000Z' },
      { ...stepRow('3', 1, 'save'), at: '2026-10-17T09:01:00.000Z' },
      { ...resultRow('4', 1), at: '2026-10-17T09:02:14.000Z' },
    ]
    const entries = feedEntries(rows, headOf({ status: 'awaiting_approval', task: { turnNo: 1 } }))
    expect(entries.map((entry) => entry.kind)).toEqual(['row', 'worked', 'row'])
    const worked = entries[1]
    expect(worked?.kind === 'worked' && worked.steps.map((step) => step.id)).toEqual(['2', '3'])
    expect(worked?.kind === 'worked' && worked.seconds).toBe(134)
  })

  it('leaves the stages of the turn at work to the live block', () => {
    const rows = [requestRow('1'), stepRow('2', 1)]
    const head = headOf({ status: 'running', task: { turnNo: 1 } })
    expect(feedEntries(rows, head).map((entry) => entry.key)).toEqual(['1'])
    expect(liveSteps(rows, head).map((row) => row.id)).toEqual(['2'])
    expect(liveSteps(rows, headOf({ status: 'awaiting_user', task: { turnNo: 1 } }))).toEqual([])
  })

  it('never shows a stage the page does not know', () => {
    const rows: FeedRow[] = [
      requestRow('1'),
      { id: '2', at: '2026-10-17T09:00:00.000Z', type: 'skipped' },
    ]
    expect(feedEntries(rows, null).map((entry) => entry.key)).toEqual(['1'])
  })
})

describe('openQuestion', () => {
  it('is the last question while nothing but a command came after it', () => {
    const question = agentQuestionRow('3', 1)
    expect(openQuestion([requestRow('1'), question], 'awaiting_user')).toBe(question)
    expect(
      openQuestion([requestRow('1'), question, commandRow('4', 'reset')], 'awaiting_user'),
    ).toBe(question)
    expect(openQuestion([question, requestRow('5', 'Ответ')], 'awaiting_user')).toBeNull()
  })

  it('is closed outside the statuses that wait for the client', () => {
    expect(openQuestion([agentQuestionRow('3', 1)], 'queued')).toBeNull()
  })

  it('keeps the question about credits open while the dialog waits with its changes', () => {
    const ceiling = ceilingRow('6', 2)
    expect(openQuestion([candidateRow('5', 1), ceiling], 'awaiting_approval')).toBe(ceiling)
    expect(openQuestion([agentQuestionRow('3', 1)], 'awaiting_approval')).toBeNull()
  })
})

describe('the candidate of the dialog', () => {
  it('is the row of the revision the dialog waits with', () => {
    const old = candidateRow('3', 1, 1)
    const current = candidateRow('6', 2, 2)
    const head = headOf({
      status: 'awaiting_approval',
      candidate: { ...candidateHead, revision: 2 },
    })
    expect(liveCandidateRow([old, current], head)).toBe(current)
    expect(liveCandidateRow([old, current], headOf({ status: 'done' }))).toBeNull()
  })

  it('carries the words of the agent of its turn', () => {
    const rows = [
      resultRow('2', 1, 'Первая правка.'),
      candidateRow('3', 1),
      resultRow('5', 2, 'Вторая.'),
      candidateRow('6', 2, 2),
    ]
    expect(candidateMessage(rows, rows[3] as Parameters<typeof candidateMessage>[1])).toBe(
      'Вторая.',
    )
    expect(candidateMessage(rows, null)).toBeNull()
  })
})

describe('requestShown', () => {
  it('finds a press of the browser by its id, in any case of the letters', () => {
    const rows = [requestRow('1'), resultRow('2', 1)]
    expect(requestShown(rows, REQUEST_ID)).toBe(true)
    expect(requestShown(rows, REQUEST_ID.toUpperCase())).toBe(true)
    expect(requestShown(rows, '0199a3f2-0000-7000-8000-0000000000ff')).toBe(false)
  })
})

describe('stopRequested', () => {
  it('is a `/cancel` taken while the agent works, until the dialog ends', () => {
    const rows = [requestRow('1'), stepRow('2', 1), commandRow('3', 'cancel')]
    expect(stopRequested(rows, 'running')).toBe(true)
    expect(stopRequested(rows, 'preparing')).toBe(true)
    expect(stopRequested(rows, 'cancelled')).toBe(false)
    expect(stopRequested(rows, undefined)).toBe(false)
    expect(stopRequested([requestRow('1'), commandRow('3', 'reset')], 'running')).toBe(false)
  })
})
