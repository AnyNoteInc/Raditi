import { describe, expect, it } from 'vitest'

import type { FeedEvent } from './client-feed.ts'
import { feedFailureCodes, feedFailureRetry } from './client-feed-failures.ts'
import {
  answersFailure,
  failureAllowsRetry,
  keptRetryCodes,
  retryCommandRefusal,
  retryVerdict,
  type OpenFailure,
} from './task-retry.ts'
import { taskStatuses } from './task-status.ts'

const failure = (change: Partial<OpenFailure> = {}): OpenFailure => ({
  id: '41',
  code: 'technical',
  site: 'unchanged',
  answered: false,
  ...change,
})

const author = '01890a5d-ac96-774b-bcce-b302099a8057'
const request = (change: Record<string, unknown>) =>
  ({ type: 'feed.request', authorId: author, requestId: author, ...change }) as FeedEvent

describe('failureAllowsRetry', () => {
  it('offers a retry after a failure of the platform or a refused change, nothing else', () => {
    expect(
      feedFailureCodes.filter((code) => failureAllowsRetry({ code, site: 'unchanged' })),
    ).toEqual(['technical', 'forbidden_change', 'secret_found', 'unavailable'])
  })

  it('stays inside the codes the feed design allows a retry for', () => {
    for (const code of keptRetryCodes) expect(feedFailureRetry[code]).toBe(true)
  })

  // The texts of these codes advise splitting the task: the open field allows that.
  it.each(['timeout', 'too_large', 'task_limit'] as const)('offers none after %s', (code) => {
    expect(failureAllowsRetry({ code, site: 'unchanged' })).toBe(false)
  })

  it('offers none while content may be left on the production site', () => {
    expect(failureAllowsRetry({ code: 'technical', site: 'check' })).toBe(false)
    expect(failureAllowsRetry({ code: 'technical', site: 'restored' })).toBe(true)
  })
})

describe('answersFailure', () => {
  it.each<[string, FeedEvent, boolean]>([
    ['words', request({ kind: 'revision', text: 'Ещё', candidateRevision: 1 }), true],
    ['a retry', request({ kind: 'retry', failureEventId: '41' }), true],
    ['«Продолжить»', request({ kind: 'continue', questionEventId: '40' }), true],
    ['«Обновить»', request({ kind: 'command', command: 'update' }), true],
    ['«Отменить»', request({ kind: 'command', command: 'cancel' }), true],
    ['a command added later', request({ kind: 'command', command: null }), true],
    ['/reset', request({ kind: 'command', command: 'reset' }), false],
    [
      'a confirmed release',
      { type: 'feed.decision', kind: 'release', authorId: author, revision: 1, version: 'v0.1.0' },
      true,
    ],
    [
      'the end of a release',
      {
        type: 'feed.release',
        releaseId: author,
        version: 'v0.1.0',
        outcome: 'refused',
        reason: 'conflict',
        credits: null,
      },
      true,
    ],
    ['a stage of the platform', { type: 'feed.step', turn: 2, attempt: 1, step: 'work' }, false],
    ['a newer row', { type: 'newer' }, false],
  ])('%s → %s', (_name, row, answers) => {
    expect(answersFailure(row)).toBe(answers)
  })
})

describe('retryVerdict', () => {
  const waiting = { status: 'awaiting_approval' as const, billable: true, failure: failure() }

  it('offers a retry of the newest failure of a dialog that waits with its candidate', () => {
    expect(retryVerdict(waiting)).toEqual({ allowed: true, failureId: '41' })
  })

  it.each([
    ['no failure', { failure: null }],
    ['an answered failure', { failure: failure({ answered: true }) }],
    ['a failure that allows none', { failure: failure({ code: 'timeout' }) }],
    ['a failure that left the site in doubt', { failure: failure({ site: 'check' }) }],
    ['a task that is not billable', { billable: false }],
  ])('says nothing to retry with %s', (_name, change) => {
    expect(retryVerdict({ ...waiting, ...change })).toEqual({ allowed: false, refusal: 'nothing' })
  })

  it('answers every status by what the dialog is doing', () => {
    const refusals = Object.fromEntries(
      taskStatuses.map((status) => {
        const verdict = retryVerdict({ ...waiting, status })
        return [status, verdict.allowed ? 'allowed' : verdict.refusal]
      }),
    )
    expect(refusals).toEqual({
      queued: 'busy',
      preparing: 'busy',
      running: 'busy',
      // A question of the agent or «Продолжить?» without a candidate: nothing was kept.
      awaiting_user: 'nothing',
      awaiting_approval: 'allowed',
      deploying: 'releasing',
      verifying: 'releasing',
      done: 'finished',
      failed: 'finished',
      rolled_back: 'finished',
      cancelled: 'finished',
    })
  })
})

describe('retryCommandRefusal', () => {
  it('tells the verdict in the words of the command /retry', () => {
    expect(retryCommandRefusal({ allowed: true, failureId: '41' })).toBeNull()
    expect(retryCommandRefusal({ allowed: false, refusal: 'nothing' })).toBe('nothing_to_retry')
    expect(retryCommandRefusal({ allowed: false, refusal: 'busy' })).toBe('busy')
    expect(retryCommandRefusal({ allowed: false, refusal: 'releasing' })).toBe(
      'release_in_progress',
    )
    expect(retryCommandRefusal({ allowed: false, refusal: 'finished' })).toBe('finished')
  })
})
