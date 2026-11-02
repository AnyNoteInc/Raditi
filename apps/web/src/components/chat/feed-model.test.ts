import { describe, expect, it } from 'vitest'

import { feedReducer, initialFeedState } from './feed-state'
import {
  candidateMessage,
  feedEntries,
  initAnswerIds,
  liveCandidateRow,
  liveSteps,
  openQuestion,
  redoneAfter,
  requestShown,
  stopRequested,
  undoFailedAfter,
  withoutRedoneRewinds,
} from './feed-model'
import {
  agentCommandRow,
  agentQuestionRow,
  AUTHOR_ID,
  candidateHead,
  candidateRow,
  ceilingRow,
  commandRow,
  failureRow,
  feedAnswer,
  REQUEST_ID,
  requestRow,
  resultRow,
  stepRow,
} from './testing'
import type { FeedRow } from './chat-types'

const headOf = (patch: Parameters<typeof feedAnswer>[0]) =>
  feedReducer(initialFeedState, { type: 'answer', answer: feedAnswer(patch), after: '0' }).head

describe('initAnswerIds (docs/plan/61-chats-first.md, К31)', () => {
  const ids = (rows: FeedRow[]) => [...initAnswerIds(rows)]

  it('takes the first result after `/init` and no other', () => {
    expect(
      ids([
        requestRow('1'),
        resultRow('2', 1),
        agentCommandRow('3'),
        stepRow('4', 2),
        resultRow('5', 2),
        requestRow('6', 'Спасибо'),
        resultRow('7', 3),
      ]),
    ).toEqual(['5'])
  })

  it('takes nothing after `/compact`: its result is a line of the platform', () => {
    expect(ids([agentCommandRow('1', 'compact'), resultRow('2', 2)])).toEqual([])
  })

  it('takes nothing when `/compact` came after `/init`: that command is what the result answers', () => {
    expect(ids([agentCommandRow('1'), agentCommandRow('2', 'compact'), resultRow('3', 2)])).toEqual(
      [],
    )
  })

  it('goes on past a press of the same work', () => {
    const retry: FeedRow = {
      id: '4',
      at: '2026-10-17T10:00:00.000Z',
      type: 'feed.request',
      kind: 'retry',
      authorId: AUTHOR_ID,
      requestId: REQUEST_ID,
    }
    expect(ids([agentCommandRow('1'), retry, resultRow('5', 2)])).toEqual(['5'])
  })

  // «продолжи» is the way on after a failure (28.10.2026), and its prompt carries `/init` again.
  it('goes on past a failure and the words after it, which go on with the same work', () => {
    expect(
      ids([
        agentCommandRow('1'),
        failureRow('2', 2),
        requestRow('3', 'продолжи'),
        resultRow('4', 3),
      ]),
    ).toEqual(['4'])
  })

  it('goes on past a question of the agent and its answer', () => {
    expect(
      ids([
        agentCommandRow('1'),
        agentQuestionRow('2', 2),
        requestRow('3', 'Да'),
        resultRow('4', 3),
      ]),
    ).toEqual(['4'])
  })

  it('finds no answer in a question or a failure: the result is what is kept', () => {
    expect(ids([agentCommandRow('1'), agentQuestionRow('2', 2)])).toEqual([])
    expect(ids([agentCommandRow('1'), failureRow('2', 2)])).toEqual([])
  })

  it('finds no answer to anything but `/init`', () => {
    const later: FeedRow = { ...agentCommandRow('1'), command: null } as FeedRow
    expect(ids([later, resultRow('2', 2)])).toEqual([])
    expect(ids([agentCommandRow('1'), later, resultRow('3', 2)])).toEqual([])
    expect(ids([commandRow('1', 'reset'), resultRow('2', 2)])).toEqual([])
    expect(ids([requestRow('1'), resultRow('2', 1)])).toEqual([])
  })
})

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

  it('puts the agent’s answer before the card of the changes it made', () => {
    // The platform writes the candidate of a pass just before its result.
    const rows: FeedRow[] = [requestRow('1'), candidateRow('2', 1), resultRow('3', 1)]
    expect(feedEntries(rows, null).map((entry) => entry.key)).toEqual(['1', '3', '2'])
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

  it('is closed by `/undo` of the turn that asked it', () => {
    const rewind: FeedRow = {
      id: '4',
      at: '2026-10-17T09:50:00.000Z',
      type: 'feed.rewind',
      turn: 1,
      files: false,
      site: 'none',
    }
    expect(openQuestion([agentQuestionRow('3', 1), rewind], 'awaiting_user')).toBeNull()
  })

  it('opens again when `/redo` took that `/undo` back, and only then', () => {
    const rewind = (id: string): FeedRow => ({
      id,
      at: '2026-10-17T09:50:00.000Z',
      type: 'feed.rewind',
      turn: 1,
      files: false,
      site: 'none',
    })
    const redo = (id: string): FeedRow => ({
      id,
      at: '2026-10-17T09:51:00.000Z',
      type: 'feed.redo',
      turn: 1,
      files: false,
      open: false,
    })
    const question = agentQuestionRow('3', 1)
    expect(openQuestion([question, rewind('4'), redo('5')], 'awaiting_user')).toBe(question)
    expect(
      openQuestion([question, rewind('4'), redo('5'), rewind('6')], 'awaiting_user'),
    ).toBeNull()
    expect(
      openQuestion([question, rewind('4'), redo('5'), rewind('6'), redo('7')], 'awaiting_user'),
    ).toBe(question)
    expect(withoutRedoneRewinds([question, rewind('4')]).map((row) => row.id)).toEqual(['3', '4'])
    expect(withoutRedoneRewinds([question, rewind('4'), redo('5')]).map((row) => row.id)).toEqual([
      '3',
      '5',
    ])
    expect(redoneAfter([question, rewind('4'), redo('5')], '4')).toBe(true)
    expect(redoneAfter([question, redo('5'), rewind('6')], '5')).toBe(false)
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

  it('carries the words of the turn it stands on again after `/undo`', () => {
    const rewind: FeedRow = {
      id: '7',
      at: '2026-10-17T09:50:00.000Z',
      type: 'feed.rewind',
      turn: 2,
      files: true,
      site: 'unchanged',
    }
    const rows = [
      resultRow('2', 1, 'Поменял цвет шапки.'),
      candidateRow('3', 1),
      resultRow('5', 2, 'Добавил баннер.'),
      candidateRow('6', 2, 2),
      rewind,
      candidateRow('8', 1, 3),
    ]
    expect(candidateMessage(rows, rows[5] as Parameters<typeof candidateMessage>[1])).toBe(
      'Поменял цвет шапки.',
    )
  })
})

describe('undoFailedAfter', () => {
  const failed = (id: string, outcome: 'rewind_failed' | 'failed' = 'rewind_failed'): FeedRow => ({
    id,
    at: '2026-10-17T09:50:00.000Z',
    type: 'feed.update',
    outcome,
    conflicts: 0,
  })

  it('is what core wrote after the press: «Запрос не отменён»', () => {
    expect(undoFailedAfter([commandRow('9', 'turn_undo'), failed('10')], '9')).toBe(true)
  })

  it('is not an earlier press that failed, and not a failed «Обновить»', () => {
    expect(undoFailedAfter([failed('10'), commandRow('11', 'turn_undo')], '11')).toBe(false)
    expect(undoFailedAfter([commandRow('9', 'turn_undo'), failed('10', 'failed')], '9')).toBe(false)
  })

  it('compares ids as numbers: `9` comes before `10`', () => {
    expect(undoFailedAfter([failed('100')], '99')).toBe(true)
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
  it('holds a chat with a browser that waits with its changes: no `/release` after the press', () => {
    const rows = [requestRow('1'), commandRow('2', 'cancel')]
    expect(stopRequested(rows, 'awaiting_approval', true)).toBe(true)
    // The same press in a chat without a browser closes it at once: nothing waits for core.
    expect(stopRequested(rows, 'awaiting_approval')).toBe(false)
  })

  it('is a `/cancel` taken while the agent works, until the dialog ends', () => {
    const rows = [requestRow('1'), stepRow('2', 1), commandRow('3', 'cancel')]
    expect(stopRequested(rows, 'running')).toBe(true)
    expect(stopRequested(rows, 'preparing')).toBe(true)
    expect(stopRequested(rows, 'cancelled')).toBe(false)
    expect(stopRequested(rows, undefined)).toBe(false)
    expect(stopRequested([requestRow('1'), commandRow('3', 'reset')], 'running')).toBe(false)
    // A dialog that waits was closed by the press itself.
    expect(stopRequested(rows, 'awaiting_user')).toBe(false)
  })

  it('is, for a task in the browser, a `/cancel` core has not acted on yet, in any status', () => {
    const question = agentQuestionRow('2', 1)
    const rows = [requestRow('1'), question, commandRow('3', 'cancel')]
    for (const status of ['queued', 'running', 'awaiting_user', 'awaiting_approval'] as const)
      expect(stopRequested(rows, status, true), status).toBe(true)
    expect(stopRequested(rows, 'cancelled', true)).toBe(false)
    expect(stopRequested(rows, undefined, true)).toBe(false)
    // Other commands after it hide nothing; words after it are what core reads instead.
    expect(stopRequested([...rows, commandRow('4', 'reset')], 'awaiting_user', true)).toBe(true)
    expect(
      stopRequested([...rows, requestRow('4', 'Всё же продолжайте')], 'awaiting_user', true),
    ).toBe(false)
    expect(stopRequested([requestRow('1'), question], 'awaiting_user', true)).toBe(false)
  })
})
