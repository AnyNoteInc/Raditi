import { describe, expect, it } from 'vitest'

import { agentCommandAnswerIds, agentCommandAnswers } from './agent-command-answers.ts'
import type { FeedAgentCommandId, FeedEvent } from './client-feed.ts'

type Row = FeedEvent & { id: string }

const authorId = '00000000-0000-4000-8000-000000000001'
const requestId = '00000000-0000-4000-8000-000000000002'

const command = (id: string, name: FeedAgentCommandId | null): Row => ({
  id,
  type: 'feed.request',
  kind: 'agent_command',
  command: name,
  authorId,
  requestId,
})
const words = (id: string, text: string): Row => ({
  id,
  type: 'feed.request',
  kind: 'answer',
  text,
  authorId,
  requestId,
  answersEventId: '1',
})
const result = (id: string, turn: number): Row => ({
  id,
  type: 'feed.result',
  turn,
  message: 'Готово.',
  site: 'none',
  next: 'awaiting_user',
  filesChanged: null,
  changeType: 'none',
  needsApproval: false,
  risk: 'low',
})
const failure = (id: string, turn: number): Row => ({
  id,
  type: 'feed.failure',
  turn,
  code: 'technical',
  site: 'unchanged',
  credits: 'returned',
  next: 'awaiting_user',
})

const question = (id: string): Row => ({
  id,
  type: 'feed.question',
  kind: 'ceiling',
  turn: 1,
  reason: 'credits',
  spent: 10,
  held: 0,
  left: 0,
})
const press = (id: string, name: 'update'): Row => ({
  id,
  type: 'feed.request',
  kind: 'command',
  command: name,
  authorId,
  requestId,
})
const candidate = (id: string, turn: number, revision: number): Row => ({
  id,
  type: 'feed.candidate',
  turn,
  revision,
  version: 'v0.1.0',
  bump: 'minor',
  files: { added: 1, modified: 0, deleted: 0 },
  media: 0,
  records: 0,
})
const updated = (id: string, outcome: 'conflict' | 'emptied' = 'conflict'): Row => ({
  id,
  type: 'feed.update',
  outcome,
  conflicts: outcome === 'conflict' ? 1 : 0,
})
const continued = (id: string): Row => ({
  id,
  type: 'feed.request',
  kind: 'continue',
  authorId,
  requestId,
  questionEventId: '2',
})

// docs/plan/61-chats-first.md, §5.14: the rule of the page and of «Обновить» in core.
describe('agentCommandAnswerIds', () => {
  it('takes the first result after the command and no other', () => {
    const rows = [command('1', 'compact'), result('2', 2), words('3', 'Спасибо'), result('4', 3)]
    expect([...agentCommandAnswerIds(rows, 'compact')]).toEqual(['2'])
    expect([...agentCommandAnswerIds(rows, 'init')]).toEqual([])
  })

  // `actionOf`: words that wait take the action away, so their turn is an ordinary one.
  it('lets words after a failed `/compact` take its place', () => {
    const rows = [command('1', 'compact'), failure('2', 2), words('3', 'продолжи'), result('4', 3)]
    expect([...agentCommandAnswerIds(rows, 'compact')]).toEqual([])
  })

  // `promptOf`: on a session that lives the words go with the words of `/init`.
  it('keeps `/init` past a failure and the words after it', () => {
    const rows = [command('1', 'init'), failure('2', 2), words('3', 'продолжи'), result('4', 3)]
    expect([...agentCommandAnswerIds(rows, 'init')]).toEqual(['4'])
  })

  // `startOf`: «Обновить» that moved the candidate makes the next pass a new session, with nothing
  // to shorten; one that moved nothing (`feed.update`) leaves the session to the compaction.
  it('lets «Обновить» that moved the candidate take a waiting `/compact` away', () => {
    const rows = [
      command('1', 'compact'),
      question('2'),
      press('3', 'update'),
      candidate('4', 1, 2),
      result('5', 2),
    ]
    expect([...agentCommandAnswerIds(rows, 'compact')]).toEqual([])
  })

  it('keeps a waiting `/compact` past «Обновить» that moved nothing', () => {
    const rows = [
      command('1', 'compact'),
      question('2'),
      press('3', 'update'),
      updated('4'),
      result('5', 2),
    ]
    expect([...agentCommandAnswerIds(rows, 'compact')]).toEqual(['5'])
  })

  // `#emptied`: the site holds the change, and the pass «Продолжить» queued goes on from the
  // revision that carries the pushed head — a new session, as after a moved candidate.
  it('lets «Обновить» that found the change on the site take a waiting `/compact` away', () => {
    const rows = [
      command('1', 'compact'),
      question('2'),
      continued('3'),
      press('4', 'update'),
      updated('5', 'emptied'),
      result('6', 2),
    ]
    expect([...agentCommandAnswerIds(rows, 'compact')]).toEqual([])
    // `/init` is told by the prompt of a new session as well.
    expect([...agentCommandAnswerIds(rows.with(0, command('1', 'init')), 'init')]).toEqual(['6'])
  })

  // The candidate of a pass comes before its result: the compaction's answer stays its answer.
  it('keeps the answer of `/compact` past the candidate of its own pass', () => {
    const rows = [command('1', 'compact'), candidate('2', 2, 2), result('3', 2)]
    expect([...agentCommandAnswerIds(rows, 'compact')]).toEqual(['3'])
  })

  // The moved session is the compaction's; `/init` is told by the prompt of a new session as well.
  it('keeps `/init` past «Обновить» that moved the candidate', () => {
    const rows = [command('1', 'init'), press('2', 'update'), candidate('3', 1, 2), result('4', 2)]
    expect([...agentCommandAnswerIds(rows, 'init')]).toEqual(['4'])
  })

  it('knows no command a later code added', () => {
    expect([...agentCommandAnswers([command('1', null), result('2', 2)])]).toEqual([])
  })
})

describe('agentCommandAnswers', () => {
  it('holds the answers of both commands', () => {
    const rows = [command('1', 'init'), result('2', 2), command('3', 'compact'), result('4', 3)]
    expect([...agentCommandAnswers(rows)].sort()).toEqual(['2', '4'])
  })
})
