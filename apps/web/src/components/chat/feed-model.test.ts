import { describe, expect, it } from 'vitest'

import { feedReducer, initialFeedState } from './feed-state'
import {
  feedEntries,
  liveSteps,
  openQuestion,
  redoneAfter,
  requestShown,
  stopRequested,
  withoutRedoneRewinds,
} from './feed-model'
import {
  agentQuestionRow,
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

  it('puts the agent’s answer before the card of the changes it made', () => {
    // The platform writes the candidate of a pass just before its result.
    const rows: FeedRow[] = [requestRow('1'), candidateRow('2', 1), resultRow('3', 1)]
    expect(feedEntries(rows, null).map((entry) => entry.key)).toEqual(['1', '3', '2'])
  })

  it('gives a change of a document no entry of its own (plan 69, Ст22)', () => {
    const rows: FeedRow[] = [
      requestRow('1'),
      {
        id: '2',
        at: '2026-10-17T09:00:00.000Z',
        type: 'feed.doc_touch',
        docId: '0199a3f2-0000-7000-8000-0000000000d1',
        revision: 3,
      },
    ]
    // The turn has not ended: its document waits for the end of it, nothing of it shows yet.
    expect(feedEntries(rows, headOf({ status: 'running' })).map((entry) => entry.key)).toEqual([
      '1',
    ])
  })

  it('shows the documents of a turn once, after the agent’s answer (14.11.2026)', () => {
    const doc = '0199a3f2-0000-7000-8000-0000000000d1'
    const at = '2026-10-17T09:00:00.000Z'
    const rows: FeedRow[] = [
      requestRow('1'),
      { id: '2', at, type: 'feed.doc', docId: doc },
      { id: '3', at, type: 'feed.doc_touch', docId: doc, revision: 2 },
      resultRow('4', 1),
      requestRow('5'),
      // The second turn only changes the document begun in the first (production, 14.11.2026).
      { id: '6', at, type: 'feed.doc_touch', docId: doc, revision: 3 },
      resultRow('7', 2),
    ]
    const entries = feedEntries(rows, null)
    expect(entries.map((entry) => entry.key)).toEqual(['1', '4', 'docs-2', '5', '7', 'docs-6'])
    expect(entries[2]).toMatchObject({ kind: 'agentDocs', docIds: [doc] })
    expect(entries[5]).toMatchObject({ kind: 'agentDocs', docIds: [doc] })
  })

  it('puts the artifact of a turn into the card its answer placed, once (plan 88, Ар46)', () => {
    const doc = '0199a3f2-0000-7000-8000-0000000000d1'
    const other = '0199a3f2-0000-7000-8000-0000000000d2'
    const at = '2026-10-17T09:00:00.000Z'
    const artifact = (id: string, artifactId: string): FeedRow => ({
      id,
      at,
      type: 'feed.artifact',
      artifactId,
      kind: 'document',
      created: true,
    })
    const rows: FeedRow[] = [
      requestRow('1'),
      { id: '2', at, type: 'feed.doc_touch', docId: doc, revision: 2 },
      resultRow('3', 1),
      artifact('4', doc),
      requestRow('5'),
      resultRow('6', 2),
      // A turn whose document sent no signal while it ran: its own card after its answer.
      artifact('7', other),
    ]
    const entries = feedEntries(rows, null)
    expect(entries.map((entry) => entry.key)).toEqual(['1', '3', 'docs-2', '5', '6', 'docs-7'])
    expect(entries[2]).toMatchObject({ kind: 'agentDocs', docIds: [doc] })
    expect(entries[5]).toMatchObject({ kind: 'agentDocs', docIds: [other] })
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
