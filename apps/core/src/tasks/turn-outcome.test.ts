import {
  DomainError,
  feedQuestionPayloadSchema,
  snapshotHasCredential,
  type TurnResult,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  agentQuestionOf,
  agentWords,
  ceilingQuestionOf,
  causeOf,
  failureFactsOf,
  feedFailureOf,
} from './turn-outcome.ts'

const result = (patch: Partial<TurnResult> = {}): TurnResult => ({
  summary: 'Поменял телефон в шапке',
  change_type: 'code',
  client_message: 'Телефон в шапке заменён.',
  files_changed: ['header.php'],
  questions: [],
  needs_approval: false,
  risk: 'low',
  ...patch,
})

describe('feedFailureOf', () => {
  it('maps error codes to the client catalogue and anything unknown to technical', () => {
    expect(feedFailureOf({ errorCode: 'PUBLICATION_TOO_LARGE', policyFlagged: false })).toBe(
      'too_large',
    )
    expect(feedFailureOf({ errorCode: 'PUBLICATION_FORBIDDEN', policyFlagged: false })).toBe(
      'forbidden_change',
    )
    expect(feedFailureOf({ errorCode: 'PUBLICATION_SECRET', policyFlagged: false })).toBe(
      'secret_found',
    )
    expect(feedFailureOf({ errorCode: 'REPOSITORY_UNSUPPORTED', policyFlagged: false })).toBe(
      'site_files',
    )
    expect(feedFailureOf({ errorCode: 'SITE_HELD', policyFlagged: false })).toBe('site_held')
    expect(feedFailureOf({ errorCode: 'CROSS_BORDER_NOT_CLEARED', policyFlagged: false })).toBe(
      'not_accepted',
    )
    expect(feedFailureOf({ errorCode: 'LLM_PRICE_MISSING', policyFlagged: false })).toBe(
      'not_accepted',
    )
    expect(feedFailureOf({ errorCode: 'LLM_GATEWAY_UNAVAILABLE', policyFlagged: false })).toBe(
      'unavailable',
    )
    expect(feedFailureOf({ errorCode: 'SOMETHING_NEW', policyFlagged: false })).toBe('technical')
    expect(feedFailureOf({ policyFlagged: false })).toBe('technical')
  })

  it('puts the policy mark first, then a named reason, then the code', () => {
    expect(feedFailureOf({ errorCode: 'PUBLICATION_SECRET', policyFlagged: true })).toBe(
      'content_refused',
    )
    expect(
      feedFailureOf({
        errorCode: 'SNAPSHOT_NOT_WRITTEN',
        detailReason: 'snapshot_credential',
        policyFlagged: false,
      }),
    ).toBe('secret_found')
    expect(feedFailureOf({ journalReason: 'timeout', policyFlagged: false })).toBe('timeout')
    expect(feedFailureOf({ journalReason: 'publication_ambiguous', policyFlagged: false })).toBe(
      'site_held',
    )
    // A journal that only says the run failed does not hide what the error says.
    expect(
      feedFailureOf({
        errorCode: 'PUBLICATION_FORBIDDEN',
        journalReason: 'run_failed',
        policyFlagged: false,
      }),
    ).toBe('forbidden_change')
  })

  it('takes only the code and the named reason of an error, never its message', () => {
    expect(failureFactsOf(snapshotHasCredential())).toEqual({
      errorCode: 'SNAPSHOT_NOT_WRITTEN',
      detailReason: 'snapshot_credential',
    })
    expect(failureFactsOf(new DomainError('X', 'secret text', 500))).toEqual({ errorCode: 'X' })
    expect(failureFactsOf(new Error('boom'))).toEqual({})
  })

  it('names the cause of a log line by codes and class, never by the message', () => {
    expect(causeOf(snapshotHasCredential())).toBe('SNAPSHOT_NOT_WRITTEN/snapshot_credential')
    expect(causeOf(new DomainError('X', 'secret text', 500))).toBe('X')
    expect(causeOf(new TypeError('secret text'))).toBe('TypeError')
    expect(causeOf('secret text')).toBe('unknown')
  })
})

describe('agentQuestionOf', () => {
  it('builds a question row the write schema takes', () => {
    const question = agentQuestionOf(
      result({ questions: ['Какой номер поставить?', 'Нужен ли код города?'] }),
      2,
    )
    expect(question).toEqual({
      v: 1,
      kind: 'agent',
      turn: 2,
      intro: 'Телефон в шапке заменён.',
      questions: [
        { text: 'Какой номер поставить?', options: [] },
        { text: 'Нужен ли код города?', options: [] },
      ],
    })
    expect(feedQuestionPayloadSchema.safeParse(question).success).toBe(true)
  })

  it('is null without a readable question: the result is read as an answer', () => {
    expect(agentQuestionOf(result(), 1)).toBeNull()
    expect(agentQuestionOf(result({ questions: ['​'] }), 1)).toBeNull()
    expect(agentWords('​​', 100)).toBeNull()
  })
})

describe('ceilingQuestionOf', () => {
  const facts = {
    chainAttempts: 1,
    reserved: 45,
    used: '44.6',
    customerLeftRub: '0',
    spendableNow: 0,
  }

  it('says the client credits ran out when nothing is left to set aside', () => {
    const question = ceilingQuestionOf(facts, 3)
    expect(question).toEqual({
      v: 1,
      kind: 'ceiling',
      turn: 3,
      reason: 'credits',
      spent: 45,
      held: 45,
      left: 0,
    })
    expect(feedQuestionPayloadSchema.safeParse(question).success).toBe(true)
  })

  it('says the step is spent while the client could continue', () => {
    expect(
      ceilingQuestionOf({ ...facts, customerLeftRub: '12.50', spendableNow: 30 }, 1),
    ).toMatchObject({ reason: 'step', spent: 45, left: 0 })
    expect(ceilingQuestionOf({ ...facts, spendableNow: 10 }, 1).reason).toBe('step')
  })

  it('says the attempts are used up at the third attempt of the chain', () => {
    expect(ceilingQuestionOf({ ...facts, chainAttempts: 3 }, 1).reason).toBe('attempts')
    // A retry after a failure started a new chain: its attempt number is not what counts.
    expect(ceilingQuestionOf({ ...facts, chainAttempts: 1 }, 1).reason).toBe('credits')
  })
})
