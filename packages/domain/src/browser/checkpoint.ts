import { z } from 'zod'

import {
  feedObjectOf,
  type FeedObject,
  type FeedObjectKind,
  type FeedObjectStatus,
} from '../tasks/client-feed.ts'
import { browserSessionLimits } from './session.ts'

/**
 * What a task made on the site through its browser, and what the site says about it now
 * (docs/plan/57-browser-tasks.md, Б22–Б24). The worker records a checkpoint when a page shows the
 * editor of an object (`SiteAdapter.browserCheckpointOf`); after a save or publish click it is
 * `unverified` until a trusted read of the site (`SiteAdapter.browserVerification`) finds the
 * object (`verified`) or does not (`missing`). `done` needs a verified one; until then the agent
 * may not start another object or publish again, so an unclear outcome leaves no duplicate.
 */
export const browserCheckpointKinds = ['post'] as const
export type BrowserCheckpointKind = (typeof browserCheckpointKinds)[number]

export const browserCheckpointStates = ['seen', 'unverified', 'verified', 'missing'] as const
export type BrowserCheckpointState = (typeof browserCheckpointStates)[number]

/** Where an object stands on the site; `unknown` — a status the stack names otherwise. */
export const browserObjectStatuses = [
  'publish',
  'draft',
  'pending',
  'private',
  'future',
  'trash',
  'unknown',
] as const
export type BrowserObjectStatus = (typeof browserObjectStatuses)[number]

export const browserCheckpointLimits = Object.freeze({
  objectIdChars: 64,
  /** A title as the site keeps it; the feed shows fewer (`feedLimits.objectTitle`). */
  titleChars: 1000,
  /** Images or files one object holds, as counted. */
  attachments: 10_000,
  /**
   * Objects one task may save or publish through its browser (CLAUDE.md rule 4: a mass edit
   * needs `request_approval`, which is not built yet — N19, N20). The changes reach the live site
   * at once, so past this the worker refuses a save of another object, counted per task (Б34).
   */
  changedObjects: 20,
})

/** An absolute http(s) address, one line, no credentials. */
const siteAddress = z
  .string()
  .max(browserSessionLimits.urlChars)
  .refine((text) => {
    if (/[\s\p{Cc}]/u.test(text)) return false
    try {
      const url = new URL(text)
      const web = url.protocol === 'https:' || url.protocol === 'http:'
      return web && url.username === '' && url.password === ''
    } catch {
      return false
    }
  }, 'expected an http(s) address')

/** The id of an object in its stack: a number of WordPress, a code of another. */
export const browserObjectIdSchema = z
  .string()
  .min(1)
  .max(browserCheckpointLimits.objectIdChars)
  .regex(/^[A-Za-z0-9_-]+$/)

/** What the editor shows: which object, and the address that opens its editor again. */
export const browserCheckpointRefSchema = z.strictObject({
  kind: z.enum(browserCheckpointKinds),
  objectId: browserObjectIdSchema,
  editUrl: siteAddress,
})
export type BrowserCheckpointRef = z.infer<typeof browserCheckpointRefSchema>

const count = z.number().int().min(0).max(browserCheckpointLimits.attachments)

/** The object as a trusted read of the site found it (`browser_checkpoints.verified`). */
export const browserVerifiedObjectSchema = z.strictObject({
  kind: z.enum(browserCheckpointKinds),
  objectId: browserObjectIdSchema,
  title: z.string().max(browserCheckpointLimits.titleChars),
  status: z.enum(browserObjectStatuses),
  /** Its public address; absent — the site gives none (a draft may have none). */
  url: siteAddress.optional(),
  editUrl: siteAddress,
  /** Images in its content, files attached to it, whether it has a featured image. */
  images: count,
  files: count,
  featuredImage: z.boolean(),
})
export type BrowserVerifiedObject = z.infer<typeof browserVerifiedObjectSchema>

/** The feed's word for a status the site gave (`feedObjectStatuses`). */
const FEED_STATUS: Readonly<Record<BrowserObjectStatus, FeedObjectStatus>> = Object.freeze({
  publish: 'published',
  future: 'scheduled',
  draft: 'draft',
  pending: 'pending',
  private: 'private',
  trash: 'trashed',
  unknown: 'unconfirmed',
})
const FEED_KIND: Readonly<Record<BrowserCheckpointKind, FeedObjectKind>> = Object.freeze({
  post: 'post',
})

/**
 * The feed's object of a checkpoint after the last check (`feed.result.objects`,
 * `feed.cancelled.objects`, Б23, Б24): what the site confirmed — kind, title, status, links, no id
 * and nothing of its content —, or that it did not (`unconfirmed`) or the object is gone
 * (`missing`). A checkpoint the task only looked at (`seen`, nothing saved) is none at all.
 */
export function browserFeedObjectOf(checkpoint: {
  ref: BrowserCheckpointRef
  state: BrowserCheckpointState
  verified: BrowserVerifiedObject | null
}): FeedObject | null {
  const { ref, state, verified } = checkpoint
  if (state === 'seen') return null
  if (state === 'verified' && verified !== null)
    return feedObjectOf({
      kind: FEED_KIND[verified.kind],
      status: FEED_STATUS[verified.status],
      title: verified.title,
      url: verified.url ?? null,
      editUrl: verified.editUrl,
    })
  // `verified` without what was found is not trusted: the object stays unconfirmed.
  return state === 'missing'
    ? feedObjectOf({ kind: FEED_KIND[ref.kind], status: 'missing', title: null })
    : feedObjectOf({
        kind: FEED_KIND[ref.kind],
        status: 'unconfirmed',
        title: null,
        editUrl: ref.editUrl,
      })
}

// ---------------------------------------------------------------------------------------------
// How a checkpoint moves
// ---------------------------------------------------------------------------------------------

/** What a click on a button of the stack's editor does to the object (`browserCommitAction`). */
export const browserCommitActions = ['publish', 'save'] as const
export type BrowserCommitAction = (typeof browserCommitActions)[number]

/** The page saved or published the object (a commit click, Б22): nothing is known until a read. */
export const browserCheckpointCommitted = (): BrowserCheckpointState => 'unverified'

/**
 * After a trusted read: found, gone, or the read failed (the site did not answer, the session is
 * not signed in) — then what was known stays: a saved object is still `unverified`.
 */
export function browserCheckpointAfterRead(
  state: BrowserCheckpointState,
  reading: BrowserVerificationReading,
): BrowserCheckpointState {
  if (reading.state === 'verified') return 'verified'
  if (reading.state === 'missing') return 'missing'
  return state
}

/**
 * Whether the agent must verify before it starts another object or publishes again (Б22): some
 * object of the task was saved and the site has not confirmed it.
 */
export const browserCheckpointsBlock = (states: Iterable<BrowserCheckpointState>): boolean =>
  [...states].includes('unverified')

// ---------------------------------------------------------------------------------------------
// A trusted read of the site (`SiteAdapter.browserVerification`)
// ---------------------------------------------------------------------------------------------

/**
 * One request of a read, sent with the session's own cookies (Playwright's request context of
 * the page). A header may carry the trimmed text body of an earlier step (`{ fromStep }`): a
 * nonce the site issues to the signed-in session. The path is of the site's origin.
 */
export interface BrowserVerificationStep {
  id: string
  method: 'GET'
  path: string
  headers?: Readonly<Record<string, string | { fromStep: string }>>
  readAs: 'text' | 'json'
}

/**
 * The answer to a step: its status and body — a string for `text`, the parsed value for `json`,
 * null when the response did not read as asked or was larger than `replyBytes`.
 */
export interface BrowserVerificationReply {
  id: string
  status: number
  body: unknown
}

/** What a read of the site found. */
export type BrowserVerificationReading =
  | { state: 'verified'; object: BrowserVerifiedObject }
  | { state: 'missing' }
  | { state: 'unreadable' }

/** The plan of a read: its requests in order, and the stack's pure reading of the answers. */
export interface BrowserVerificationPlan {
  steps: readonly BrowserVerificationStep[]
  read(replies: readonly BrowserVerificationReply[]): BrowserVerificationReading
}

/** Bounds of a plan the browser adapter runs; a plan outside them is not run. */
export const browserVerificationLimits = Object.freeze({
  steps: 4,
  /** A text or JSON body of one reply. */
  replyBytes: 1024 * 1024,
  stepTimeoutMs: 10_000,
})

const STEP_ID = /^[a-z][a-z0-9-]{0,31}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
/** Headers of the read are the stack's own; never what the browser sets for a session. */
const RESERVED_HEADERS = new Set(['cookie', 'authorization', 'host', 'origin', 'referer'])

/**
 * Whether a plan is one the browser adapter may run: up to `steps` GET requests to paths of the
 * site (one leading `/`, printable ASCII, no `..`), unique ids, headers that are not the
 * session's own and take the body only of an earlier step.
 */
export function isBrowserVerificationPlan(plan: BrowserVerificationPlan): boolean {
  if (plan.steps.length === 0 || plan.steps.length > browserVerificationLimits.steps) return false
  const seen = new Set<string>()
  for (const step of plan.steps) {
    if (!STEP_ID.test(step.id) || seen.has(step.id) || step.method !== 'GET') return false
    if (
      !/^\/(?!\/)[\x21-\x7e]{0,2047}$/.test(step.path) ||
      /(?:^|\/)\.\.(?:\/|$|\?)/.test(step.path)
    )
      return false
    for (const [name, value] of Object.entries(step.headers ?? {})) {
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) return false
      if (typeof value === 'string' ? /\p{Cc}/u.test(value) : !seen.has(value.fromStep))
        return false
    }
    seen.add(step.id)
  }
  return true
}
