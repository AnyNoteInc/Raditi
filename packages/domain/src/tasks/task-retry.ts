import type { ChatCommandRefusal } from '../release/chat-commands.ts'
import type { FeedEvent, FeedSiteState } from './client-feed.ts'
import { feedFailureRetry, type FeedFailureCode } from './client-feed-failures.ts'
import type { TaskStatus } from './task-status.ts'

// «Попробовать ещё» (docs/plan/53-chat-preview-release.md, «Попробовать ещё (18.10)»; the
// owner's answer 1 of 18.10.2026). A pass of a dialog that already has a candidate and fails —
// for any reason but money, which is the question «Продолжить?» — keeps the candidate and its
// preview: the dialog waits in `awaiting_approval` with the `feed.failure` row. The client may
// then repeat the pass as a new attempt with a new reserve, and the reserve of the failed one is
// given back. A dialog without a candidate ends `failed` as before; there is no retry of it.

/**
 * The codes after which a dialog that kept its candidate offers «Попробовать ещё»: a failure of
 * the platform, or a change the platform refused that the agent may well not repeat. A subset of
 * `feedFailureRetry` — the texts of `timeout`, `too_large` and `task_limit` advise splitting the
 * task, which the open field already allows; the same request in a heavier class would only fail
 * again, slower and dearer.
 */
export const keptRetryCodes = [
  'technical',
  'unavailable',
  'forbidden_change',
  'secret_found',
] as const satisfies readonly FeedFailureCode[]

/** Whether a failure row of a dialog with a candidate offers «Попробовать ещё». */
export function failureAllowsRetry(failure: {
  code: FeedFailureCode
  site: FeedSiteState
}): boolean {
  return (
    (keptRetryCodes as readonly FeedFailureCode[]).includes(failure.code) &&
    feedFailureRetry[failure.code] &&
    // Content may be left on the production site (the stands' path without a preview).
    failure.site !== 'check'
  )
}

/**
 * Whether a row written after a failure answers it, so that the failure is no longer offered for
 * a retry: the client's words, a press — «Попробовать ещё», «Обновить», «Отменить», «Продолжить»
 * —, a confirmed release and its end. `/reset` only rebuilds the preview and answers nothing; a
 * row of the platform (a stage, a candidate of «Обновить») is not the client's answer either.
 */
export function answersFailure(row: FeedEvent): boolean {
  switch (row.type) {
    case 'feed.request':
      return !(row.kind === 'command' && row.command === 'reset')
    case 'feed.decision':
    case 'feed.release':
      return true
    default:
      return false
  }
}

/** Why «Попробовать ещё» is not offered now. */
export const retryRefusals = [
  /** No failure waits for a retry: none, answered, or of a code that does not allow one. */
  'nothing',
  /** The agent is at work. */
  'busy',
  /** A release of the dialog is in work. */
  'releasing',
  /** The dialog has ended. */
  'finished',
] as const
export type RetryRefusal = (typeof retryRefusals)[number]

/** The newest `feed.failure` of a dialog, read with what came after it. */
export interface OpenFailure {
  /** `task_events.id` of the row. */
  id: string
  code: FeedFailureCode
  site: FeedSiteState
  /** A row the client wrote or pressed after it (`answersFailure`). */
  answered: boolean
}

export type RetryVerdict =
  { allowed: true; failureId: string } | { allowed: false; refusal: RetryRefusal }

const BUSY: readonly TaskStatus[] = ['queued', 'preparing', 'running']
const RELEASING: readonly TaskStatus[] = ['deploying', 'verifying']
const ENDED: readonly TaskStatus[] = ['done', 'failed', 'rolled_back', 'cancelled']

/**
 * Whether «Попробовать ещё» is offered: decided by the server alone (`canRetry` of the head of
 * the feed, the command `/retry`, the procedure `task.retry`). A dialog that waits with its
 * candidate after a failure that allows a retry, while nothing answered the failure. The three
 * attempts of a task do not stop it (spec §20, decision 4 of 11.10.2026), and neither does the
 * daily limit (the owner, 19.10.2026: `placementTariffRoom`): what bounds retries in a row is the
 * five credits a new reserve needs that can be spent, the free tariff credits its tariff part is
 * taken from and the bound on unpaid work, which the reserve checks when the press comes, so the
 * offer does not depend on them.
 */
export function retryVerdict(input: {
  status: TaskStatus
  billable: boolean
  failure: OpenFailure | null
}): RetryVerdict {
  const { status, failure } = input
  if (BUSY.includes(status)) return { allowed: false, refusal: 'busy' }
  if (RELEASING.includes(status)) return { allowed: false, refusal: 'releasing' }
  if (ENDED.includes(status)) return { allowed: false, refusal: 'finished' }
  if (
    status !== 'awaiting_approval' ||
    !input.billable ||
    failure === null ||
    failure.answered ||
    !failureAllowsRetry(failure)
  )
    return { allowed: false, refusal: 'nothing' }
  return { allowed: true, failureId: failure.id }
}

const commandRefusals: Readonly<Record<RetryRefusal, ChatCommandRefusal>> = Object.freeze({
  nothing: 'nothing_to_retry',
  busy: 'busy',
  releasing: 'release_in_progress',
  finished: 'finished',
})

/** The verdict as the command `/retry` tells it (`ChatCommandFacts.retry`); null — offered. */
export const retryCommandRefusal = (verdict: RetryVerdict): ChatCommandRefusal | null =>
  verdict.allowed ? null : commandRefusals[verdict.refusal]
