import { z } from 'zod'

import { attachmentLimits } from '../attachments/rules.ts'
import {
  browserHelpReasons,
  browserPlatformQuestionReasons,
  browserScreenshotLimits,
  browserSessionLimits,
} from '../browser/session.ts'
import { agentOutputLimits } from '../ports/agent-driver.ts'
import { chatCommandIds } from '../release/chat-commands.ts'
import { releaseOutcomes } from '../release/release-state.ts'
import { versionBumps, versionTagSchema } from '../release/semver.ts'
import { FEED_FAILURE_FALLBACK, feedFailureCodes } from './client-feed-failures.ts'
import {
  FEED_REQUEST_TEXT_LIMIT,
  feedText,
  hasVisibleText,
  isFeedText,
  looksLikeSecret,
} from './client-feed-text.ts'
import { REPOSITORY_ONLY, taskRequirementsSchema } from './task-requirements.ts'
import { taskStatuses } from './task-status.ts'

/**
 * The customer-facing feed of a task — docs/research/2026-10-client-feed/feed-design.md
 * (confirmed by the owner on 11.10.2026). Rows of `task_events` with a `feed.*` type are the
 * only ones a customer ever reads. Schemas and pure helpers only: who writes a row and when is
 * the business of the writers (web, the turn journal, the turn handler).
 *
 * Two schemas per type. Writing is strict: closed enums, no extra keys, free text in exactly
 * four fields (`request.text`, `question.intro`, `question.questions[].text` with its
 * `options[]`, `result.message`), the agent's words of a `browser` question (`question.message`)
 * and the titles of objects the platform read on the site (`objects[].title`) — everything else
 * is a number, an enum, an id or an address, so nothing raw (a failure reason, a path, a
 * command) can reach the customer. Reading is tolerant: rows are immutable and outlive the code
 * that wrote them.
 *
 * The vocabulary names no agent shell, CMS or provider (CLAUDE.md, rule 8).
 */
export const feedEventTypes = [
  'feed.request',
  'feed.step',
  'feed.question',
  'feed.result',
  'feed.failure',
  'feed.cancelled',
  // docs/plan/53-chat-preview-release.md: a candidate shown, the client's decision, the release.
  'feed.candidate',
  'feed.decision',
  'feed.release',
  // «Обновить» (`/update`) that left no new revision: what came of it (Р27).
  'feed.update',
  // «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): the confirmation and the outcome.
  'feed.undo',
  // A snapshot of the task's browser for the client (`web_screenshot`, docs/plan/57, Б20).
  'feed.screenshot',
] as const
export type FeedEventType = (typeof feedEventTypes)[number]

/** Every customer-visible type carries this prefix; the database CHECK relies on it. */
export const FEED_TYPE_PREFIX = 'feed.'
/** The only payload version so far. A removed field or a changed meaning takes a new one. */
export const FEED_VERSION = 1

export const feedLimits = Object.freeze({
  /** A payload as UTF-8 JSON. */
  payloadBytes: 32 * 1024,
  requestText: FEED_REQUEST_TEXT_LIMIT,
  attachments: attachmentLimits.perMessage,
  turn: 999_999,
  intro: agentOutputLimits.clientMessage,
  message: agentOutputLimits.clientMessage,
  questions: agentOutputLimits.questions,
  question: agentOutputLimits.question,
  questionOptions: agentOutputLimits.questionOptions,
  questionOption: agentOutputLimits.questionOption,
  filesChanged: 10_000,
  /** Rows of one `task.feed` answer. */
  page: 200,
  title: 120,
  /** The agent's words of its `web_help` request; a `browser` question holds up to `message`. */
  helpMessage: browserSessionLimits.helpChars,
  /**
   * Objects of the site a result, a failure or a cancellation names (docs/plan/57, Б23, Б24).
   * With the titles and the addresses below, twenty of them and the longest message still keep
   * a payload under 32 KiB.
   */
  objects: 20,
  objectTitle: 120,
  /** An address of an object: ASCII, as `URL.href` writes it. */
  objectUrl: 400,
})
const limits = feedLimits

// Kinds a row may be written with today. `revision` — words to a dialog that waits with a
// candidate; `command` — a command of the chat (docs/plan/53-chat-preview-release.md, Р6, Р34);
// `continue` — «Продолжить» after a question of the platform about credits (Р8), the kind the
// design reserved for it; `resume` — «Продолжить работу агента» of a task in the browser
// (docs/plan/57-browser-tasks.md, Б16).
export const feedRequestKinds = [
  'first',
  'answer',
  'retry',
  'revision',
  'command',
  'continue',
  'resume',
] as const
export type FeedRequestKind = (typeof feedRequestKinds)[number]

/** A stage of work the customer understands; `site` and `files` wait for trusted sources. */
export const feedSteps = ['work', 'save', 'site', 'files'] as const
export const feedStepSchema = z.enum(feedSteps)
export type FeedStep = z.infer<typeof feedStepSchema>

export const feedQuestionKinds = ['agent', 'ceiling', 'browser'] as const
export type FeedQuestionKind = (typeof feedQuestionKinds)[number]
export const feedCeilingReasons = ['step', 'credits', 'gift', 'attempts'] as const
export type FeedCeilingReason = (typeof feedCeilingReasons)[number]

/**
 * Why a `browser` question stops the work (docs/plan/57-browser-tasks.md, Б23): the agent asked
 * the customer to act in the browser of the task — sign in, pass a check, confirm, something
 * else it names (`web_help`) —, or the platform found the customer in control of the browser, or
 * nothing the task saved was confirmed on the site.
 */
export const feedBrowserReasons = [
  ...browserHelpReasons,
  ...browserPlatformQuestionReasons,
] as const
export type FeedBrowserReason = (typeof feedBrowserReasons)[number]

/**
 * An object of the site the platform names in a result, a failure or a cancellation of a task in
 * the browser (Б23, Б24): a post or a page, as its check read it there.
 */
export const feedObjectKinds = ['post', 'page'] as const
export type FeedObjectKind = (typeof feedObjectKinds)[number]
/**
 * The state read on the site, never the agent's word; `missing` — the site has no such object;
 * `unconfirmed` — the task saved it, but its state could not be read there or has no name here.
 */
export const feedObjectStatuses = [
  'published',
  'scheduled',
  'draft',
  'pending',
  'private',
  'trashed',
  'missing',
  'unconfirmed',
] as const
export type FeedObjectStatus = (typeof feedObjectStatuses)[number]

/**
 * What the platform knows about the site. Trusted: written from the platform's own records,
 * never from the agent's words. A result never says `restored`, a failure never `changed`.
 */
export const feedSiteStates = ['unchanged', 'changed', 'restored', 'check'] as const
export type FeedSiteState = (typeof feedSiteStates)[number]
const resultSites = ['unchanged', 'changed', 'check'] as const
const endedSites = ['unchanged', 'restored', 'check'] as const

/** What became of the held credits; null — not known or not applicable. Trusted. */
export const feedCreditsStates = ['returned', 'expired'] as const
export type FeedCreditsState = (typeof feedCreditsStates)[number]

/**
 * The status a result moved the task to: `awaiting_user` — a pass of a dialog with a repository
 * that changed nothing and asked nothing: the dialog stays open for the client's next words
 * (owner's decision of 26.10.2026, «не закрывай чат»).
 */
export const feedResultNexts = ['done', 'awaiting_approval', 'awaiting_user'] as const
export type FeedResultNext = (typeof feedResultNexts)[number]
/**
 * The status a failure moved the task to: `awaiting_approval` — the dialog kept its candidate
 * and its preview, and waits (docs/plan/53, «Попробовать ещё (18.10)»).
 */
export const feedFailureNexts = ['failed', 'awaiting_approval'] as const
export type FeedFailureNext = (typeof feedFailureNexts)[number]
const changeTypes = ['code', 'content', 'mixed', 'none'] as const
const risks = ['low', 'medium', 'high'] as const

export const feedCancelledBys = [
  'not_available',
  'queue_timeout',
  'customer',
  'declined',
  'stopped',
  'no_answer',
] as const
export type FeedCancelledBy = (typeof feedCancelledBys)[number]

// Nineteen digits reach past a bigint, and PostgreSQL answers that with an error of its own.
// Digits without leading zeros of the same length compare as text. No BigInt(): a refinement
// also runs on a string the pattern has already refused.
const MAX_BIGINT = '9223372036854775807'
const fitsBigint = (digits: string) =>
  digits.length < MAX_BIGINT.length || (digits.length === MAX_BIGINT.length && digits <= MAX_BIGINT)

/** `task_events.id` of a feed row: a bigint as a string of digits. */
export const feedEventIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine(fitsBigint, 'out of bigint range')
/** The cursor of a reader: the id of the last row seen, `0` before the first. */
export const feedCursorSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,18})$/)
  .refine(fitsBigint, 'out of bigint range')

const version = z.literal(FEED_VERSION)
const turnNo = z.number().int().min(1).max(limits.turn)
const count = z.number().int().nonnegative()

// The customer's own words: stored as written, so what cannot be stored is refused, not removed.
const forbiddenInRequest = /[^\P{Cc}\n\t]/u
const requestText = z
  .string()
  .trim()
  .min(1)
  // Aborts: the checks below are not run on a text of any length.
  .max(limits.requestText, { abort: true })
  .refine((text) => !forbiddenInRequest.test(text), 'control characters are not allowed')
  // Half of a surrogate pair: jsonb would refuse the row.
  .refine((text) => text.isWellFormed(), 'ill-formed text is not allowed')
  .refine(hasVisibleText, 'the request has no visible characters')
  // A backstop for a writer that forgot the check: the procedures call looksLikeSecret()
  // themselves to answer in the customer's words. The message never repeats the text.
  .refine((text) => !looksLikeSecret(text), 'looks like a password or a key')

/** The agent's words: a row stores only what feedText() leaves unchanged, with something to read. */
const agentText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(isFeedText, 'expected text passed through feedText()')
    .refine(hasVisibleText, 'the text has no visible characters')

// An address of an object: http(s) as `URL.href` writes it — ASCII, so its bytes are its length —
// and without a name or a password in it.
const objectUrl = z
  .url({ protocol: /^https?$/ })
  .max(limits.objectUrl)
  .regex(/^[!-~]+$/, 'expected an address as URL.href writes it')
  // Checks after a failed one still run: what is not an address is refused above.
  .refine((url) => {
    if (!URL.canParse(url)) return true
    const parsed = new URL(url)
    return parsed.username === '' && parsed.password === ''
  }, 'an address carries no credentials')

/** A title as the site holds it, on one line: what feedObjectOf() leaves. */
const objectTitle = agentText(limits.objectTitle).refine(
  (title) => !title.includes('\n'),
  'expected one line',
)

/** `objects[]` of a result, a failure or a cancellation: trusted, read by the platform. */
export const feedObjectSchema = z.strictObject({
  kind: z.enum(feedObjectKinds),
  /** null — the object has no title to show. */
  title: objectTitle.nullable(),
  status: z.enum(feedObjectStatuses),
  /** Where a visitor sees it; absent when it has no public address, as a draft. */
  url: objectUrl.optional(),
  /** Where it is edited on the site. */
  editUrl: objectUrl.optional(),
})
export type FeedObject = z.infer<typeof feedObjectSchema>
const objects = z.array(feedObjectSchema).max(limits.objects).optional()

const urlOf = (raw: string | null | undefined): string | undefined => {
  if (typeof raw !== 'string' || !URL.canParse(raw)) return undefined
  const href = new URL(raw).href
  return objectUrl.safeParse(href).success ? href : undefined
}

/**
 * An object as the platform read it on the site, made fit for a row: the title through
 * feedText() on one line, cut to its limit by whole characters (null when nothing is left to
 * read); an address as `URL.href` writes it, left out when it is not http(s), carries
 * credentials or is too long.
 */
export function feedObjectOf(read: {
  kind: FeedObjectKind
  status: FeedObjectStatus
  title: string | null
  url?: string | null
  editUrl?: string | null
}): FeedObject {
  let title: string | null = null
  if (typeof read.title === 'string') {
    // Cut before feedText(): NFC of an unbounded text takes time.
    const shown = feedText(read.title.slice(0, limits.objectTitle * 4))
      .replace(/\s+/gu, ' ')
      .trim()
    let cut = ''
    for (const char of shown) {
      if (cut.length + char.length > limits.objectTitle) break
      cut += char
    }
    cut = cut.trim()
    title = objectTitle.safeParse(cut).success ? cut : null
  }
  const url = urlOf(read.url)
  const editUrl = urlOf(read.editUrl)
  return {
    kind: read.kind,
    title,
    status: read.status,
    ...(url === undefined ? {} : { url }),
    ...(editUrl === undefined ? {} : { editUrl }),
  }
}

/**
 * The commands a `feed.request` of the kind `command` is written with: every command of the chat
 * but «Попробовать ещё», whose press is a row of its own kind (`retry`).
 */
export const feedCommandIds = chatCommandIds.filter(
  (id): id is Exclude<(typeof chatCommandIds)[number], 'retry'> => id !== 'retry',
)

const requestBase = {
  v: version,
  /** The name and the address are not stored: the name is looked up when the row is shown. */
  authorId: z.uuid(),
  /** Invented by the browser: a repeated request is recognised by it. */
  requestId: z.uuid(),
}
// Files come with words. Design reading: a retry is a press, so it carries none.
const attachments = z.array(z.uuid()).max(limits.attachments).optional()

/** `feed.request` v1 — what the customer wrote or pressed. */
export const feedRequestPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...requestBase, kind: z.literal('first'), text: requestText, attachments }),
  z.strictObject({
    ...requestBase,
    kind: z.literal('answer'),
    text: requestText,
    attachments,
    /**
     * The `feed.question` row this answers, or the `feed.result` that left the dialog open
     * (`next: 'awaiting_user'`, owner's decision of 26.10.2026).
     */
    answersEventId: feedEventIdSchema,
  }),
  // «Попробовать ещё» is a press, not a message.
  z.strictObject({
    ...requestBase,
    kind: z.literal('retry'),
    /**
     * The `feed.failure` row this answers: one attempt may fail twice, a row only once.
     * `task.retry` always writes it; optional only for the frozen sample of the design, written
     * before the procedure existed.
     */
    failureEventId: feedEventIdSchema.optional(),
  }),
  // Words to a dialog that waits with a candidate: a new pass on top of it.
  z.strictObject({
    ...requestBase,
    kind: z.literal('revision'),
    text: requestText,
    attachments,
    /** The candidate revision the words are about. */
    candidateRevision: z.number().int().min(1).max(limits.turn),
  }),
  // A command of the chat: a press, never words for the agent.
  z.strictObject({ ...requestBase, kind: z.literal('command'), command: z.enum(feedCommandIds) }),
  // «Продолжить» is a press: the next attempt with a reserve of its own (Р8).
  z.strictObject({
    ...requestBase,
    kind: z.literal('continue'),
    /** The `feed.question` of the kind `ceiling` this answers. */
    questionEventId: feedEventIdSchema,
  }),
  // «Продолжить работу агента» (docs/plan/57, Б16): the customer gave the browser back to the
  // agent. A press: no words, nothing else.
  z.strictObject({ ...requestBase, kind: z.literal('resume') }),
])
export type FeedRequestPayload = z.infer<typeof feedRequestPayloadSchema>

/** `feed.step` v1 — the work reached a stage. No text, no path, no counter. */
export const feedStepPayloadSchema = z.strictObject({
  v: version,
  turn: turnNo,
  /** `tasks.attempt` when written; informational. */
  attempt: z.number().int().min(1),
  step: feedStepSchema,
})
export type FeedStepPayload = z.infer<typeof feedStepPayloadSchema>

/**
 * `feed.question` v1 — the customer's answer is needed. The agent asks in words; the platform
 * asks about credits with a reason and three numbers, its text comes from the catalogue.
 */
export const feedQuestionPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    v: version,
    kind: z.literal('agent'),
    turn: turnNo,
    intro: agentText(limits.intro),
    questions: z
      .array(
        z.strictObject({
          text: agentText(limits.question),
          // The design bounds only the length; an empty option could not be a button.
          options: z.array(agentText(limits.questionOption)).max(limits.questionOptions),
        }),
      )
      .min(1)
      .max(limits.questions),
  }),
  z.strictObject({
    v: version,
    kind: z.literal('ceiling'),
    turn: turnNo,
    reason: z.enum(feedCeilingReasons),
    /** Credits: spent on the task, held for it, left of the hold. */
    spent: count,
    held: count,
    left: count,
  }),
  // A task in the browser waits for the customer (docs/plan/57, Б23); the text comes from the
  // catalogue by the reason.
  z.strictObject({
    v: version,
    kind: z.literal('browser'),
    turn: turnNo,
    reason: z.enum(feedBrowserReasons),
    /**
     * The agent's own words: its `web_help` request, or its `client_message` under a question of
     * the platform; shown under the catalogue text.
     */
    message: agentText(limits.message).optional(),
  }),
])
export type FeedQuestionPayload = z.infer<typeof feedQuestionPayloadSchema>

/** `feed.result` v1 — what this turn came to. No paths and no summary. */
export const feedResultPayloadSchema = z.strictObject({
  v: version,
  turn: turnNo,
  message: agentText(limits.message),
  site: z.enum(resultSites),
  /** The status this result moved the task to: stored, not derived again. */
  next: z.enum(feedResultNexts),
  /** Trusted count of files in the published candidate, or null when it is not known. */
  filesChanged: z.number().int().min(0).max(limits.filesChanged).nullable(),
  // The agent's own claims, informational: nothing about the site is said on their word.
  changeType: z.enum(changeTypes),
  needsApproval: z.boolean(),
  risk: z.enum(risks),
  /** What a task in the browser left on the site, as the platform confirmed it there (Б23). */
  objects,
})
export type FeedResultPayload = z.infer<typeof feedResultPayloadSchema>

/** `feed.failure` v1 — a code and two trusted facts; the reason text never gets here. */
export const feedFailurePayloadSchema = z.strictObject({
  v: version,
  /** null — the failure came before a turn was opened. */
  turn: turnNo.nullable(),
  code: z.enum(feedFailureCodes),
  site: z.enum(endedSites),
  credits: z.enum(feedCreditsStates).nullable(),
  /** The status the failure moved the task to; absent in rows of before 18.10.2026 — `failed`. */
  next: z.enum(feedFailureNexts).optional(),
  /** What a task in the browser had saved on the site, as the platform found it there (Б24). */
  objects,
})
export type FeedFailurePayload = z.infer<typeof feedFailurePayloadSchema>

/** `feed.cancelled` v1 — the task was stopped. */
export const feedCancelledPayloadSchema = z.strictObject({
  v: version,
  turn: turnNo.nullable(),
  by: z.enum(feedCancelledBys),
  /** Who cancelled, when a person did. */
  authorId: z.uuid().optional(),
  site: z.enum(endedSites),
  credits: z.enum(feedCreditsStates).nullable(),
  /** What a task in the browser had saved on the site, as the platform found it there (Б24). */
  objects,
})
export type FeedCancelledPayload = z.infer<typeof feedCancelledPayloadSchema>

const count999 = z.number().int().min(0).max(limits.filesChanged)
const revisionNo = z.number().int().min(1).max(limits.turn)

/**
 * `feed.candidate` v1 — a pass left changes to look at and release (Р5, Р6). Trusted counts
 * and the proposed number; the files themselves are in the panel, never in the feed.
 */
export const feedCandidatePayloadSchema = z.strictObject({
  v: version,
  turn: turnNo,
  revision: revisionNo,
  /** The proposed version, `vX.Y.Z`; shown without the letter. */
  version: versionTagSchema,
  bump: z.enum(versionBumps),
  files: z.strictObject({ added: count999, modified: count999, deleted: count999 }),
  media: count999,
  /** Records of the site the release will change. */
  records: count999,
})
export type FeedCandidatePayload = z.infer<typeof feedCandidatePayloadSchema>

export const feedDecisionKinds = ['release'] as const
export type FeedDecisionKind = (typeof feedDecisionKinds)[number]

/** `feed.decision` v1 — the client confirmed a release of a revision under a version (Р25). */
export const feedDecisionPayloadSchema = z.strictObject({
  v: version,
  kind: z.enum(feedDecisionKinds),
  authorId: z.uuid(),
  revision: revisionNo,
  version: versionTagSchema,
})
export type FeedDecisionPayload = z.infer<typeof feedDecisionPayloadSchema>

export const feedReleaseOutcomes = releaseOutcomes
export type FeedReleaseOutcome = (typeof feedReleaseOutcomes)[number]
/** Why a release did not end `installed`, in the client's terms. */
export const feedReleaseReasons = [
  'conflict',
  'outdated',
  'not_started',
  'site_check',
  'technical',
  // R8b (17.10): refusals before `main` moved that the client can act on.
  'not_allowed',
  'checks_failed',
  'site_inactive',
  'client_variable',
  // R8c (17.10): the site failed its check before the deploy wrote anything.
  'site_broken_before',
  // «Операции БД и миграции» (18.10): refusals before anything was written.
  'plugin_outdated',
  'slug_taken',
  'values_unavailable',
  'created_id_in_code',
  'site_unreachable',
] as const
export type FeedReleaseReason = (typeof feedReleaseReasons)[number]

/** `feed.release` v1 — how a release ended, or that it was refused before it began. */
export const feedReleasePayloadSchema = z.strictObject({
  v: version,
  releaseId: z.uuid(),
  version: versionTagSchema,
  outcome: z.enum(feedReleaseOutcomes),
  /** null for `installed` and when there is nothing to add. */
  reason: z.enum(feedReleaseReasons).nullable(),
  credits: z.enum(feedCreditsStates).nullable(),
  /**
   * After a rollback (docs/plan/53, «Операции БД и миграции»): new records it left because
   * someone changed them after the release, and new tables or columns, which stay. Absent — none.
   */
  kept: z.strictObject({ records: count999, tables: count999 }).optional(),
})
export type FeedReleasePayload = z.infer<typeof feedReleasePayloadSchema>

/**
 * What came of an «Обновить» that left no new revision (a new one is a `feed.candidate`):
 * - `emptied` — the site has every change of the dialog already: nothing is left to release;
 * - `conflict` — the change does not carry onto the site as it is now: the same places changed;
 * - `current` — the dialog already stands on the site as it is now;
 * - `withdrawn` — the client wrote to the dialog before the update was made: it was not made;
 * - `failed` — the update could not be made.
 */
export const feedUpdateOutcomes = ['emptied', 'conflict', 'current', 'withdrawn', 'failed'] as const
export type FeedUpdateOutcome = (typeof feedUpdateOutcomes)[number]

/** `feed.update` v1 — the answer to an «Обновить» that did not record a new revision. */
export const feedUpdatePayloadSchema = z.strictObject({
  v: version,
  outcome: z.enum(feedUpdateOutcomes),
  /** Files of the dialog's change that `main` changed too (`conflict`); 0 otherwise. */
  conflicts: count999,
})
export type FeedUpdatePayload = z.infer<typeof feedUpdatePayloadSchema>

/** Why an undo did not end `installed`: a release's reasons, and the version it undoes is gone. */
export const feedUndoReasons = [...feedReleaseReasons, 'undo_outdated'] as const
export type FeedUndoReason = (typeof feedUndoReasons)[number]
/** The moments of an undo the dialog shows: the client's confirmation, then its outcome. */
export const feedUndoStages = ['confirmed', ...feedReleaseOutcomes] as const
export type FeedUndoStage = (typeof feedUndoStages)[number]

const undoNames = {
  v: version,
  /** The row of the undo (`site_releases`, kind `undo`). */
  undoId: z.uuid(),
  /** The release it undoes: a release of this dialog. */
  releaseId: z.uuid(),
  undoneVersion: versionTagSchema,
  /** The new version the undo comes out as. */
  version: versionTagSchema,
}
/** Objects the undo returns, and those it leaves because the site changed them since. */
const undoRecords = z.strictObject({ returned: count999, kept: count999 })

/**
 * `feed.undo` v1 — «Отменить выпуск»: the client confirmed it (`confirmed`), or how it ended.
 * `returnsTo` — the version the site goes back to; `records` — from the plan the client confirmed.
 */
export const feedUndoPayloadSchema = z.discriminatedUnion('stage', [
  z.strictObject({ ...undoNames, stage: z.literal('confirmed'), authorId: z.uuid() }),
  z.strictObject({
    ...undoNames,
    stage: z.enum(feedReleaseOutcomes),
    returnsTo: versionTagSchema,
    /** null for `installed` and `unknown`. */
    reason: z.enum(feedUndoReasons).nullable(),
    records: undoRecords,
  }),
])
export type FeedUndoPayload = z.infer<typeof feedUndoPayloadSchema>

/**
 * `feed.screenshot` v1 — a snapshot of the shown page of the task's browser, which the agent took
 * for the client (`web_screenshot`, owner's request of 26.10.2026). The image is in the inbox
 * bucket under the task (`browserTaskScreenshotKey`); the row names it by id and its number among
 * the task's snapshots, with its size in pixels. No address, no title: what the page showed is in
 * the image alone, which only the client sees (Б20).
 */
export const feedScreenshotPayloadSchema = z.strictObject({
  v: version,
  screenshotId: z.uuid(),
  number: z.number().int().min(1).max(browserScreenshotLimits.perTask),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
})
export type FeedScreenshotPayload = z.infer<typeof feedScreenshotPayloadSchema>

/** The writing schema of each type. */
export const feedPayloadSchemas = Object.freeze({
  'feed.request': feedRequestPayloadSchema,
  'feed.step': feedStepPayloadSchema,
  'feed.question': feedQuestionPayloadSchema,
  'feed.result': feedResultPayloadSchema,
  'feed.failure': feedFailurePayloadSchema,
  'feed.cancelled': feedCancelledPayloadSchema,
  'feed.candidate': feedCandidatePayloadSchema,
  'feed.decision': feedDecisionPayloadSchema,
  'feed.release': feedReleasePayloadSchema,
  'feed.update': feedUpdatePayloadSchema,
  'feed.undo': feedUndoPayloadSchema,
  'feed.screenshot': feedScreenshotPayloadSchema,
}) satisfies Record<FeedEventType, z.ZodType>

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
/** Size of a payload as it is stored: UTF-8 JSON. */
export const feedPayloadBytes = (payload: unknown): number => utf8Bytes(JSON.stringify(payload))

const row = <T extends FeedEventType, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ type: z.literal(type), payload })

/**
 * The row schema with a given size limit. With well-formed text the field limits already keep
 * a payload under 32 KiB, so the limit is a second line of defence; it is a parameter so that
 * a test can reach it.
 */
export const feedRowSchemaWithin = (maxBytes: number) =>
  z
    .discriminatedUnion('type', [
      row('feed.request', feedRequestPayloadSchema),
      row('feed.step', feedStepPayloadSchema),
      row('feed.question', feedQuestionPayloadSchema),
      row('feed.result', feedResultPayloadSchema),
      row('feed.failure', feedFailurePayloadSchema),
      row('feed.cancelled', feedCancelledPayloadSchema),
      row('feed.candidate', feedCandidatePayloadSchema),
      row('feed.decision', feedDecisionPayloadSchema),
      row('feed.release', feedReleasePayloadSchema),
      row('feed.update', feedUpdatePayloadSchema),
      row('feed.undo', feedUndoPayloadSchema),
      row('feed.screenshot', feedScreenshotPayloadSchema),
    ])
    .superRefine((value, ctx) => {
      if (feedPayloadBytes(value.payload) > maxBytes)
        ctx.addIssue({ code: 'custom', message: 'feed payload is too large' })
    })

/** A row on its way into `task_events`: the type, its strict payload and the size limit. */
export const feedRowSchema = feedRowSchemaWithin(limits.payloadBytes)
export type FeedRow = z.infer<typeof feedRowSchema>

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** A string enum read tolerantly: a value this code does not know becomes `fallback`. */
const known = <T extends string, F>(values: readonly T[], fallback: F) =>
  z.string().transform((value): T | F => values.find((item) => item === value) ?? fallback)

// The agent's words pass feedText() again on the way out: a marker never reaches the screen,
// whoever wrote the row. A text with nothing to read makes the row unreadable, not an empty card.
const shownText = (max: number) =>
  z.string().max(max).transform(feedText).pipe(z.string().refine(hasVisibleText))

const readCredits = z.union([z.null(), known(feedCreditsStates, null)])
const readEndedSite = known(endedSites, 'check' as const)

// An object is a fact next to the row's own: what cannot be read of it is left out, never the
// row. A kind or a state added later reads as null, a broken title as none, a broken address as
// absent; an object without a kind or a state at all is dropped, and so is the list past its
// limit.
const readObject = z.object({
  kind: known(feedObjectKinds, null),
  title: shownText(limits.objectTitle).nullable().catch(null),
  status: known(feedObjectStatuses, null),
  url: objectUrl.optional().catch(undefined),
  editUrl: objectUrl.optional().catch(undefined),
})
export type FeedObjectRead = z.infer<typeof readObject>
const readObjects = z
  .array(z.unknown())
  .transform((items) =>
    items.slice(0, limits.objects).flatMap((item) => {
      const read = readObject.safeParse(item)
      return read.success ? [read.data] : []
    }),
  )
  .optional()
  .catch(undefined)

const readRequest = {
  first: z.object({
    kind: z.literal('first'),
    text: z.string().min(1).max(limits.requestText),
    authorId: z.uuid(),
    requestId: z.uuid(),
    attachments,
  }),
  answer: z.object({
    kind: z.literal('answer'),
    text: z.string().min(1).max(limits.requestText),
    authorId: z.uuid(),
    requestId: z.uuid(),
    answersEventId: feedEventIdSchema,
    attachments,
  }),
  retry: z.object({
    kind: z.literal('retry'),
    authorId: z.uuid(),
    requestId: z.uuid(),
    failureEventId: feedEventIdSchema.optional(),
  }),
  revision: z.object({
    kind: z.literal('revision'),
    text: z.string().min(1).max(limits.requestText),
    authorId: z.uuid(),
    requestId: z.uuid(),
    candidateRevision: revisionNo,
    attachments,
  }),
  // A command added later reads as a press without a name: the row is kept, the text is general.
  command: z.object({
    kind: z.literal('command'),
    authorId: z.uuid(),
    requestId: z.uuid(),
    command: known(chatCommandIds, null),
  }),
  continue: z.object({
    kind: z.literal('continue'),
    authorId: z.uuid(),
    requestId: z.uuid(),
    questionEventId: feedEventIdSchema,
  }),
  resume: z.object({
    kind: z.literal('resume'),
    authorId: z.uuid(),
    requestId: z.uuid(),
  }),
} satisfies Record<FeedRequestKind, z.ZodType>
// A kind added later: the text is shown when there is one.
const readOtherRequest = z.object({
  text: z.string().min(1).max(limits.requestText).optional().catch(undefined),
  authorId: z.uuid().optional().catch(undefined),
})

const readStep = z.object({
  turn: turnNo,
  attempt: z.number().int().min(1),
  step: known(feedSteps, null),
})

const readAgentQuestion = z.object({
  kind: z.literal('agent'),
  turn: turnNo,
  intro: shownText(limits.intro),
  questions: z
    .array(
      z.object({
        text: shownText(limits.question),
        options: z.array(shownText(limits.questionOption)).max(limits.questionOptions),
      }),
    )
    .min(1)
    .max(limits.questions),
})
const readCeilingQuestion = z.object({
  kind: z.literal('ceiling'),
  turn: turnNo,
  // No fallback: a question needs an action, an unknown reason is shown as a newer row.
  reason: z.enum(feedCeilingReasons),
  spent: count,
  held: count,
  left: count,
})
const readBrowserQuestion = z.object({
  kind: z.literal('browser'),
  turn: turnNo,
  // No fallback: a question needs an action, an unknown reason is shown as a newer row.
  reason: z.enum(feedBrowserReasons),
  // The text of the question comes from the catalogue by the reason: the agent's words only add
  // to it, so words that cannot be shown are left out, not the question.
  message: shownText(limits.message).optional().catch(undefined),
})

const readResult = z.object({
  turn: turnNo,
  message: shownText(limits.message),
  site: known(resultSites, 'check' as const),
  /** null — the screen is drawn by the status of the task. */
  next: known(feedResultNexts, null),
  filesChanged: z.number().int().min(0).max(limits.filesChanged).nullable(),
  changeType: known(changeTypes, null),
  needsApproval: z.boolean(),
  risk: known(risks, null),
  objects: readObjects,
})

const readFailure = z.object({
  turn: turnNo.nullable(),
  code: known(feedFailureCodes, FEED_FAILURE_FALLBACK),
  site: readEndedSite,
  credits: readCredits,
  // Absent, or a value this code does not know: read as `failed` — nothing is promised about
  // the candidate.
  next: z.enum(feedFailureNexts).optional().catch(undefined),
  objects: readObjects,
})

const readCandidate = z.object({
  turn: turnNo,
  revision: revisionNo,
  version: versionTagSchema,
  /** null — a kind of number this code does not know: the text names the version alone. */
  bump: known(versionBumps, null),
  files: z.object({ added: count999, modified: count999, deleted: count999 }),
  media: count999,
  records: count999,
})

const readDecision = z.object({
  kind: z.enum(feedDecisionKinds),
  authorId: z.uuid(),
  revision: revisionNo,
  version: versionTagSchema,
})

const readRelease = z.object({
  releaseId: z.uuid(),
  version: versionTagSchema,
  // No fallback: an outcome decides what the client is told about the site.
  outcome: z.enum(feedReleaseOutcomes),
  reason: z.union([z.null(), known(feedReleaseReasons, null)]),
  credits: readCredits,
  kept: z.object({ records: count999, tables: count999 }).optional().catch(undefined),
})

const readUpdate = z.object({
  // No fallback: an outcome decides what the client is told about the dialog.
  outcome: z.enum(feedUpdateOutcomes),
  conflicts: count999,
})

const readUndoNames = {
  undoId: z.uuid(),
  releaseId: z.uuid(),
  undoneVersion: versionTagSchema,
  version: versionTagSchema,
}
const readUndoConfirmed = z.object({
  ...readUndoNames,
  stage: z.literal('confirmed'),
  authorId: z.uuid(),
})
const readUndoOutcome = z.object({
  ...readUndoNames,
  // No fallback: an outcome decides what the client is told about the site.
  stage: z.enum(feedReleaseOutcomes),
  returnsTo: versionTagSchema,
  reason: z.union([z.null(), known(feedUndoReasons, null)]),
  records: z.object({ returned: count999, kept: count999 }),
})

const readScreenshot = z.object({
  screenshotId: z.uuid(),
  number: z.number().int().min(1),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
})

const readCancelled = z.object({
  turn: turnNo.nullable(),
  /** null — a way of cancelling added later: the plate is shown without a reason. */
  by: known(feedCancelledBys, null),
  authorId: z.uuid().optional(),
  site: readEndedSite,
  credits: readCredits,
  objects: readObjects,
})

/**
 * A row as the customer's screen gets it: the fields of its schema without `v`.
 *
 * - `newer` — a `feed.*` type, a version, a question kind or a ceiling reason this code does
 *   not know yet: «Здесь появилось новое сообщение. Обновите страницу, чтобы его увидеть.»
 * - `unreadable` — a row of a known version that does not match its schema: «Не удалось
 *   показать это сообщение. Напишите нам, если оно важно.»
 * - `skipped` — a stage this code does not know. The only row a reader may leave out.
 */
export type FeedEvent =
  | ({ type: 'feed.request' } & (
      | z.infer<typeof readRequest.first>
      | z.infer<typeof readRequest.answer>
      | z.infer<typeof readRequest.retry>
      | z.infer<typeof readRequest.revision>
      | z.infer<typeof readRequest.command>
      | z.infer<typeof readRequest.continue>
      | z.infer<typeof readRequest.resume>
      | ({ kind: 'other' } & z.infer<typeof readOtherRequest>)
    ))
  | { type: 'feed.step'; turn: number; attempt: number; step: FeedStep }
  | ({ type: 'feed.question' } & (
      | z.infer<typeof readAgentQuestion>
      | z.infer<typeof readCeilingQuestion>
      | z.infer<typeof readBrowserQuestion>
    ))
  | ({ type: 'feed.result' } & z.infer<typeof readResult>)
  | ({ type: 'feed.failure' } & z.infer<typeof readFailure>)
  | ({ type: 'feed.cancelled' } & z.infer<typeof readCancelled>)
  | ({ type: 'feed.candidate' } & z.infer<typeof readCandidate>)
  | ({ type: 'feed.decision' } & z.infer<typeof readDecision>)
  | ({ type: 'feed.release' } & z.infer<typeof readRelease>)
  | ({ type: 'feed.update' } & z.infer<typeof readUpdate>)
  | ({ type: 'feed.undo' } & (z.infer<typeof readUndoConfirmed> | z.infer<typeof readUndoOutcome>))
  | ({ type: 'feed.screenshot' } & z.infer<typeof readScreenshot>)
  | { type: 'newer' }
  | { type: 'unreadable' }
  | { type: 'skipped' }
export type FeedEventKind = FeedEvent['type']

/** A row of a `task.feed` answer: ids are strings (bigint), `at` is an ISO time. */
export type FeedItem = FeedEvent & { id: string; at: string }

const NEWER: FeedEvent = Object.freeze({ type: 'newer' })
const UNREADABLE: FeedEvent = Object.freeze({ type: 'unreadable' })
const SKIPPED: FeedEvent = Object.freeze({ type: 'skipped' })

type Payload = Record<string, unknown>
type Reader = (payload: Payload) => FeedEvent

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

function readWith<T extends object>(
  schema: z.ZodType<T>,
  payload: Payload,
  build: (data: T) => FeedEvent,
): FeedEvent {
  const parsed = schema.safeParse(payload)
  return parsed.success ? build(parsed.data) : UNREADABLE
}

/** Readers by type and version; a version stays here while its rows live. */
const readers: Record<FeedEventType, Record<number, Reader>> = {
  'feed.request': {
    1: (payload) => {
      if (typeof payload.kind !== 'string') return UNREADABLE
      if (!includes(feedRequestKinds, payload.kind))
        return readWith(readOtherRequest, payload, (data) => ({
          type: 'feed.request',
          kind: 'other',
          ...data,
        }))
      const schema: z.ZodType<z.infer<(typeof readRequest)[FeedRequestKind]>> =
        readRequest[payload.kind]
      return readWith(schema, payload, (data) => ({ type: 'feed.request', ...data }))
    },
  },
  'feed.step': {
    1: (payload) =>
      readWith(readStep, payload, ({ step, ...data }) =>
        step === null ? SKIPPED : { type: 'feed.step', ...data, step },
      ),
  },
  'feed.question': {
    1: (payload) => {
      if (typeof payload.kind !== 'string') return UNREADABLE
      if (!includes(feedQuestionKinds, payload.kind)) return NEWER
      if (payload.kind === 'agent')
        return readWith(readAgentQuestion, payload, (data) => ({ type: 'feed.question', ...data }))
      if (payload.kind === 'browser') {
        if (typeof payload.reason === 'string' && !includes(feedBrowserReasons, payload.reason))
          return NEWER
        return readWith(readBrowserQuestion, payload, (data) => ({
          type: 'feed.question',
          ...data,
        }))
      }
      if (typeof payload.reason === 'string' && !includes(feedCeilingReasons, payload.reason))
        return NEWER
      return readWith(readCeilingQuestion, payload, (data) => ({ type: 'feed.question', ...data }))
    },
  },
  'feed.result': {
    1: (payload) => readWith(readResult, payload, (data) => ({ type: 'feed.result', ...data })),
  },
  'feed.failure': {
    1: (payload) => readWith(readFailure, payload, (data) => ({ type: 'feed.failure', ...data })),
  },
  'feed.cancelled': {
    1: (payload) =>
      readWith(readCancelled, payload, (data) => ({ type: 'feed.cancelled', ...data })),
  },
  'feed.candidate': {
    1: (payload) =>
      readWith(readCandidate, payload, (data) => ({ type: 'feed.candidate', ...data })),
  },
  'feed.decision': {
    1: (payload) => {
      // A decision this code does not know may be a consent: shown as a newer row.
      if (typeof payload.kind === 'string' && !includes(feedDecisionKinds, payload.kind))
        return NEWER
      return readWith(readDecision, payload, (data) => ({ type: 'feed.decision', ...data }))
    },
  },
  'feed.release': {
    1: (payload) => {
      if (typeof payload.outcome === 'string' && !includes(feedReleaseOutcomes, payload.outcome))
        return NEWER
      return readWith(readRelease, payload, (data) => ({ type: 'feed.release', ...data }))
    },
  },
  'feed.update': {
    1: (payload) => {
      if (typeof payload.outcome === 'string' && !includes(feedUpdateOutcomes, payload.outcome))
        return NEWER
      return readWith(readUpdate, payload, (data) => ({ type: 'feed.update', ...data }))
    },
  },
  'feed.undo': {
    1: (payload) => {
      if (payload.stage === 'confirmed')
        return readWith(readUndoConfirmed, payload, (data) => ({ type: 'feed.undo', ...data }))
      if (typeof payload.stage === 'string' && !includes(feedReleaseOutcomes, payload.stage))
        return NEWER
      return readWith(readUndoOutcome, payload, (data) => ({ type: 'feed.undo', ...data }))
    },
  },
  'feed.screenshot': {
    1: (payload) =>
      readWith(readScreenshot, payload, (data) => ({ type: 'feed.screenshot', ...data })),
  },
}

export const isFeedEventType = (type: string): type is FeedEventType =>
  includes(feedEventTypes, type)

/**
 * The one way to read a stored row. Never throws and leaves out nothing silently except an
 * unknown stage (`skipped`): a hidden row could be a failure, a question or a consent card.
 */
export function readFeedRow(type: string, payload: unknown): FeedEvent {
  try {
    if (!isFeedEventType(type)) {
      // Design reading: only `feed.*` rows are visible to a customer, so any other type here
      // is a broken row, not a newer one.
      return type.startsWith(FEED_TYPE_PREFIX) ? NEWER : UNREADABLE
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return UNREADABLE
    const fields = payload as Payload
    const v = fields.v
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return UNREADABLE
    const reader = Object.hasOwn(readers[type], v) ? readers[type][v] : undefined
    return reader ? reader(fields) : NEWER
  } catch {
    return UNREADABLE
  }
}

// ---------------------------------------------------------------------------------------------
// The head of a task, returned with its feed
// ---------------------------------------------------------------------------------------------

export const taskWaitingReasons = ['agents', 'site'] as const
export type TaskWaitingReason = (typeof taskWaitingReasons)[number]
export const taskModes = ['work', 'chat'] as const
export type TaskMode = (typeof taskModes)[number]

/**
 * The state of the task read in the same snapshot as its rows. A status change is not a feed
 * row: the truth is `tasks.status`, the transient screens are drawn from this head.
 */
export const feedTaskHeadSchema = z.strictObject({
  id: z.uuid(),
  // Design reading: `tasks.title` is a nullable column, set once from the first request.
  title: z.string().max(limits.title).nullable(),
  mode: z.enum(taskModes),
  status: z.enum(taskStatuses),
  attempt: z.number().int().min(1),
  turnNo: z.number().int().min(0).max(limits.turn),
  /** Why the task waits in the queue; meaningful only in `queued`. */
  waiting: z.enum(taskWaitingReasons).nullable(),
  /** The site is held for the operator by this task. */
  held: z.boolean(),
  /** Whether «Попробовать ещё» is shown — the server decides. */
  canRetry: z.boolean(),
  /** When the last `feed.request` was written. */
  workingSince: z.iso.datetime().nullable(),
  /** When the `work` stage of the current turn was written. */
  runningSince: z.iso.datetime().nullable(),
  /**
   * What the task works with (docs/plan/57, Б2): its site's repository, the browser of the task
   * or both. A head built without it is of a task that has the repository alone.
   */
  requirements: taskRequirementsSchema.default(() => ({ ...REPOSITORY_ONLY })),
})
export type FeedTaskHead = z.infer<typeof feedTaskHeadSchema>
