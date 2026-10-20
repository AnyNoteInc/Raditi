import {
  feedText,
  hasVisibleText,
  isDomainError,
  isFeedText,
  maxTaskAttempts,
  Money,
  type FeedCeilingReason,
  type FeedFailureCode,
  type FeedQuestionPayload,
  type TurnEvidence,
  type TurnResult,
} from '@repo/domain'

// How a pass of the agent ends, for the client (docs/research/2026-10-client-feed/
// feed-design.md, «Причины сбоя для клиента», «Вопрос агента»; docs/plan/53-chat-preview-release
// .md, Р5–Р8). Pure: codes and numbers in, feed payloads out. No error text, failure reason or
// agent output beyond the four free-text fields of the feed ever gets here.

type JournalReason = NonNullable<TurnEvidence['reason']>

/**
 * The client's code of a journal reason; null — not a failure (`cancelled` ends `cancelled`).
 * `technical` here never hides a more precise error code (feedFailureOf).
 */
const journalCodes = {
  cancelled: null,
  timeout: 'timeout',
  lease_lost: 'technical',
  run_failed: 'technical',
  snapshot_ambiguous: 'site_held',
  snapshot_credential: 'secret_found',
  publication_ambiguous: 'site_held',
  destroy_failed: 'site_held',
  exec_lost: 'technical',
  awaiting_runner: 'site_held',
} as const satisfies Record<JournalReason, FeedFailureCode | null>

/** `DomainError.code` → the client's code; anything not here is `technical`. */
const errorCodes: Readonly<Record<string, FeedFailureCode>> = Object.freeze({
  PUBLICATION_TOO_LARGE: 'too_large',
  SNAPSHOT_TOO_LARGE: 'too_large',
  TURN_OUTPUT_TOO_LARGE: 'too_large',
  PUBLICATION_FORBIDDEN: 'forbidden_change',
  PUBLICATION_SECRET: 'secret_found',
  REPOSITORY_TOO_LARGE: 'site_files',
  REPOSITORY_UNSUPPORTED: 'site_files',
  SITE_HELD: 'site_held',
  LLM_GATEWAY_UNAVAILABLE: 'unavailable',
  // The rate is being updated: a later pass may be taken.
  BILLING_CREDIT_RATE_MISSING: 'unavailable',
  CROSS_BORDER_NOT_CLEARED: 'not_accepted',
  LLM_PRICE_MISSING: 'not_accepted',
})

/** Reasons in `DomainError.details.reason` that name the failure better than its code. */
const detailCodes: Readonly<Record<string, FeedFailureCode>> = Object.freeze({
  snapshot_credential: 'secret_found',
  timeout: 'timeout',
})

export interface FailureFacts {
  /** `DomainError.code` of the failure, when it reached the handler. */
  errorCode?: string
  /** `DomainError.details.reason`, when it names one. */
  detailReason?: string
  /** The reason of the turn's last `failed` journal entry. */
  journalReason?: JournalReason
  /** The task carries `llm.policy_flagged`: the provider refused its content. */
  policyFlagged: boolean
}

/**
 * The one mapping of the live handler and the sweep: the policy mark first, then a reason that
 * names the failure (the error's, then the journal's), then the error code; whatever is unknown
 * is `technical`.
 */
export function feedFailureOf(facts: FailureFacts): FeedFailureCode {
  if (facts.policyFlagged) return 'content_refused'
  const detail = facts.detailReason === undefined ? undefined : detailCodes[facts.detailReason]
  if (detail) return detail
  const journal = facts.journalReason === undefined ? null : journalCodes[facts.journalReason]
  if (journal && journal !== 'technical') return journal
  return (facts.errorCode && errorCodes[facts.errorCode]) || 'technical'
}

/** The code and the named reason of a thrown error, nothing else of it. */
export function failureFactsOf(error: unknown): Pick<FailureFacts, 'errorCode' | 'detailReason'> {
  if (!isDomainError(error)) return {}
  const details = error.details as { reason?: unknown } | undefined
  const reason = typeof details?.reason === 'string' ? details.reason : undefined
  return { errorCode: error.code, ...(reason ? { detailReason: reason } : {}) }
}

/**
 * What a log line of a pass names as the cause of an error: the code of a domain error with
 * its detail reason, or the class of any other — never a message, which may quote a value.
 */
export function causeOf(error: unknown): string {
  const facts = failureFactsOf(error)
  if (facts.errorCode === undefined) return error instanceof Error ? error.name : 'unknown'
  return `${facts.errorCode}${facts.detailReason ? `/${facts.detailReason}` : ''}`
}

/** The agent's words as a feed row stores them, or null when nothing readable is left. */
export function agentWords(text: string, max: number): string | null {
  const shown = feedText(text)
  if (!hasVisibleText(shown) || !isFeedText(shown)) return null
  return [...shown].length <= max ? shown : null
}

/**
 * The agent's question (`feed.question` kind `agent`): its message as the intro and every
 * question it asked; null — no question left to show, the result is read as an answer.
 */
export function agentQuestionOf(
  result: TurnResult,
  turn: number,
): Extract<FeedQuestionPayload, { kind: 'agent' }> | null {
  const questions = result.questions
    .map((text) => agentWords(text, 500))
    .filter((text): text is string => text !== null)
    .map((text) => ({ text, options: [] }))
  const intro = agentWords(result.client_message, 2000)
  if (questions.length === 0 || intro === null) return null
  return { v: 1, kind: 'agent', turn, intro, questions }
}

/** What the platform asks about credits: why, and the three numbers of the task. */
export interface CeilingFacts {
  /**
   * The attempts of the chain: those that hold an active reserve (`chainAttempts`). An attempt
   * a failure gave back is not counted (spec §20, decision 4 of 11.10.2026).
   */
  chainAttempts: number
  /** Σ active reserve rows of the task, credits. */
  reserved: number
  /** The billable work of the chain in credits, not rounded. */
  used: InstanceType<typeof Money> | string | number
  /** What the reserves still hold for the client, RUB: zero — the client's credits ran out. */
  customerLeftRub: string
  /**
   * What the workspace could set aside for one more attempt now: the tariff part no larger than
   * what is left of the Moscow day (`AttemptCreditBudget.spendableNow`). A day that is taken
   * reads as credits that ran out — a pack carries the task on today.
   */
  spendableNow: number
}

/**
 * The platform's question «Продолжить?» (Р8; `feed.question` kind `ceiling`): the attempts of the
 * chain are used up, or the client's credits ran out and none are left to set aside, or the step of the
 * attempt is spent. Its text and buttons come from the catalogue when it is shown.
 */
export function ceilingQuestionOf(
  facts: CeilingFacts,
  turn: number,
): Extract<FeedQuestionPayload, { kind: 'ceiling' }> {
  const spent = new Money(facts.used).toDecimalPlaces(0, Money.ROUND_HALF_UP).toNumber()
  const reason: FeedCeilingReason =
    facts.chainAttempts >= maxTaskAttempts
      ? 'attempts'
      : new Money(facts.customerLeftRub).isZero() && facts.spendableNow < 1
        ? 'credits'
        : 'step'
  return {
    v: 1,
    kind: 'ceiling',
    turn,
    reason,
    spent,
    held: facts.reserved,
    left: Math.max(0, facts.reserved - spent),
  }
}
