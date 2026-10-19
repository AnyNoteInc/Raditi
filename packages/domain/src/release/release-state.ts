import { conflict, type DomainError } from '../errors.ts'
import type { TaskStatus } from '../tasks/task-status.ts'

/**
 * A release of a candidate (docs/plan/53-chat-preview-release.md, Р27–Р33): `site_releases.status`
 * from the confirmation to the outcome, the steps of the deploy job, and what each outcome does
 * to the dialog. The truth is the row; every move is a conditional UPDATE under the site lease
 * `deploy` and the release barrier `site_leases.inflight_release_id`.
 */
export const releaseStatuses = [
  /** Confirmed by the client; nothing pushed yet. */
  'approved',
  /** The release commit and the tag are being pushed. */
  'publishing',
  /** `main` and the tag are on the repository; the deploy job is being started. */
  'published',
  /** The job reported `started`: it may write to the hosting from now on. */
  'deploying',
  /** Files and records are written; the site is being checked. */
  'verifying',
  'installed',
  /** The job undoes what it wrote. */
  'rolling_back',
  'rolled_back',
  /** Ended without a write to the hosting. */
  'failed',
  /** What the hosting holds cannot be proved: the site waits for an operator. */
  'unknown',
] as const
export type ReleaseStatus = (typeof releaseStatuses)[number]

/**
 * What a row of `site_releases` is (docs/plan/53, «Отмена выпуска»): a release of a candidate, or
 * the undo of an installed release — a new version with the tree of the one before it and the
 * inverse of its database plan, through the same skill, release API and deploy job.
 */
export const releaseKinds = ['release', 'undo'] as const
export type ReleaseKind = (typeof releaseKinds)[number]

/** Ended for good: the partial UNIQUE of `site_releases` lets the next release of the candidate in. */
export const terminalReleaseStatuses = [
  'installed',
  'rolled_back',
  'failed',
] as const satisfies readonly ReleaseStatus[]

const transitions: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  approved: ['publishing', 'failed'],
  // A refused push ends without a write; a lost answer is reconciled with ls-remote, not guessed.
  publishing: ['published', 'failed'],
  // The job did not start in time: revoked, nothing written.
  published: ['deploying', 'failed'],
  // A conflict found before the first write ends `failed`; a write without a report — `unknown`.
  deploying: ['verifying', 'rolling_back', 'failed', 'unknown'],
  verifying: ['installed', 'rolling_back', 'unknown'],
  rolling_back: ['rolled_back', 'unknown'],
  installed: [],
  rolled_back: [],
  failed: [],
  // `releases:resolve` decides; a «rollback only» attempt goes through rolling_back.
  unknown: ['installed', 'rolled_back', 'rolling_back'],
}

export function canReleaseTransition(from: ReleaseStatus, to: ReleaseStatus): boolean {
  return transitions[from].includes(to)
}

export function releaseNextStatuses(from: ReleaseStatus): readonly ReleaseStatus[] {
  return transitions[from]
}

export function assertReleaseTransition(from: ReleaseStatus, to: ReleaseStatus): void {
  if (!canReleaseTransition(from, to)) throw invalidTransition(from, to)
}

const invalidTransition = (from: ReleaseStatus, to: ReleaseStatus): DomainError =>
  conflict(`Release cannot move from ${from} to ${to}`)

export const isTerminalReleaseStatus = (status: ReleaseStatus): boolean =>
  (terminalReleaseStatuses as readonly ReleaseStatus[]).includes(status)

/** Statuses after which the hosting may hold a write of this release. */
export const releaseWroteStatuses = ['deploying', 'verifying', 'rolling_back', 'unknown'] as const

// ---------------------------------------------------------------------------------------------
// Steps of the deploy job (Р30, Р31)
// ---------------------------------------------------------------------------------------------

/**
 * In this order; `rollback` only after a write and a failure, and `reverify` — the check of the
 * site after a rollback (Р31) — only after `rollback succeeded`.
 */
export const releaseSteps = [
  'conflicts',
  'backup',
  'files',
  'db',
  'verify',
  'rollback',
  'reverify',
] as const
export type ReleaseStep = (typeof releaseSteps)[number]

/** `release_steps.state`. The first report of a job is `conflicts` `started`. */
export const releaseStepStates = ['started', 'succeeded', 'failed', 'unknown'] as const
export type ReleaseStepState = (typeof releaseStepStates)[number]

/** Steps that write to the hosting: a failure after one of them needs a rollback. */
export const writingReleaseSteps = ['files', 'db'] as const satisfies readonly ReleaseStep[]

/** Steps a job may report while the release is in a status; any other report is refused. */
const stepsByStatus: Readonly<Record<ReleaseStatus, readonly ReleaseStep[]>> = {
  approved: [],
  publishing: [],
  // The job's first report.
  published: ['conflicts'],
  deploying: ['conflicts', 'backup', 'files', 'db', 'verify', 'rollback'],
  verifying: ['verify', 'rollback'],
  rolling_back: ['rollback', 'reverify'],
  // An attempt «только возврат» starts with its rollback.
  unknown: ['rollback'],
  installed: [],
  rolled_back: [],
  failed: [],
}

/** The steps a job may report while the release is in `status`. */
export const releaseStepsAllowedIn = (status: ReleaseStatus): readonly ReleaseStep[] =>
  stepsByStatus[status]

function statusAfterReport(
  step: ReleaseStep,
  state: ReleaseStepState,
  wrote: boolean,
): ReleaseStatus | null {
  switch (step) {
    // A rollback writes to the hosting: what it left unknown or failed waits for the operator.
    // One that succeeded is not the end — the site is checked again (`reverify`).
    case 'rollback':
      return state === 'started' ? 'rolling_back' : state === 'succeeded' ? null : 'unknown'
    // A site that does not answer after the rollback waits for the operator as well.
    case 'reverify':
      return state === 'succeeded' ? 'rolled_back' : state === 'started' ? null : 'unknown'
    default:
      // Before the first write nothing on the hosting can be unknown: the release ends without one.
      if (state === 'unknown') return wrote ? 'unknown' : 'failed'
      if (state === 'failed') return wrote ? 'rolling_back' : 'failed'
      if (step === 'conflicts' && state === 'started') return 'deploying'
      if (step === 'verify' && state === 'started') return 'verifying'
      if (step === 'verify' && state === 'succeeded') return 'installed'
      return null
  }
}

/**
 * The status a step report moves the release to, or null when the status stays. `wrote` — a
 * writing step of this deploy attempt has reported `started`, this report included. A report
 * the current status does not take (a step out of its place, a move `canReleaseTransition`
 * refuses, any report of an ended release) throws a conflict: the release API refuses it.
 */
export function releaseStatusAfterStep(
  current: ReleaseStatus,
  step: ReleaseStep,
  state: ReleaseStepState,
  wrote: boolean,
): ReleaseStatus | null {
  if (!stepsByStatus[current].includes(step))
    throw conflict(`Release in ${current} takes no report of the step ${step}`)
  const next = statusAfterReport(step, state, wrote)
  if (next === null || next === current) return null
  assertReleaseTransition(current, next)
  return next
}

// ---------------------------------------------------------------------------------------------
// Outcome of a release → the dialog (Р6, Р8, Р27, Р31)
// ---------------------------------------------------------------------------------------------

/** What the dialog shows (`feed.release`): the four ends of a release, and a refusal before one. */
export const releaseOutcomes = ['installed', 'rolled_back', 'failed', 'unknown', 'refused'] as const
export type ReleaseOutcome = (typeof releaseOutcomes)[number]

/** What decides an outcome besides the status. */
export interface ReleaseOutcomeFacts {
  /**
   * The release commit reached `main`: `site_releases.main_pushed_at` is set — by the answer
   * of the CAS push or, after a lost answer, by `ls-remote`. Never guessed from `approved_sha`,
   * which is computed before the push.
   */
  mainMoved: boolean
}

/**
 * The outcome a status stands for; null while the release goes on. A `failed` release whose
 * commit never reached `main` — readiness refused in core (`approved → failed`) or the CAS push
 * of `main` refused (`publishing → failed`) — is `refused`: there is nothing to revert. Once
 * `main` moved, `failed` (the tag refused, the job silent, a conflict before the first write)
 * needs the revert commit.
 */
export function releaseOutcomeOf(
  status: ReleaseStatus,
  facts: ReleaseOutcomeFacts,
): ReleaseOutcome | null {
  switch (status) {
    case 'failed':
      return facts.mainMoved ? 'failed' : 'refused'
    case 'installed':
    case 'rolled_back':
    case 'unknown':
      return status
    default:
      return null
  }
}

/** One conditional UPDATE of `tasks.status`. */
export interface ReleaseTaskStep {
  from: readonly TaskStatus[]
  to: TaskStatus
}

export interface ReleaseTaskEffect {
  /** Applied in order, each its own conditional UPDATE; a task already past a step skips it. */
  steps: readonly ReleaseTaskStep[]
  /**
   * `charge` — `chargeTask` in a second transaction after the task is `done` (the sweeper
   * repeats it; a failed charge never holds the site); `release` — `releaseTask`; `keep` — the
   * hold stays and is extended while the dialog waits; `none` — the undo of a release, which has
   * no hold and is never charged (rule 7: «Отменить» is free).
   */
  credits: 'charge' | 'release' | 'keep' | 'none'
  /**
   * core pushes the deterministic revert commit to `main` before it frees the lease (Р27). Only
   * outcomes reached after `main` moved set it: `refused` never does.
   */
  revertMain: boolean
  /** The lease and the barrier stay for the operator (`releases:resolve`). */
  holdForOperator: boolean
}

/**
 * The table «outcome of a release → the dialog». An end without a write to the hosting — a
 * conflict, an outdated candidate, a job that did not start (`failed`), or a refusal before
 * `main` moved (`refused`) — returns the dialog to its candidate (`deploying →
 * awaiting_approval`), so it can be released again or changed.
 */
export const releaseTaskEffects: Readonly<Record<ReleaseOutcome, ReleaseTaskEffect>> =
  Object.freeze({
    installed: {
      steps: [
        { from: ['deploying'], to: 'verifying' },
        { from: ['verifying'], to: 'done' },
      ],
      credits: 'charge',
      revertMain: false,
      holdForOperator: false,
    },
    rolled_back: {
      steps: [{ from: ['deploying', 'verifying'], to: 'rolled_back' }],
      credits: 'release',
      revertMain: true,
      holdForOperator: false,
    },
    failed: {
      steps: [{ from: ['deploying'], to: 'awaiting_approval' }],
      credits: 'keep',
      revertMain: true,
      holdForOperator: false,
    },
    unknown: {
      steps: [],
      credits: 'keep',
      revertMain: false,
      holdForOperator: true,
    },
    // Ended before the release commit reached `main`: nothing to revert.
    refused: {
      steps: [{ from: ['deploying'], to: 'awaiting_approval' }],
      credits: 'keep',
      revertMain: false,
      holdForOperator: false,
    },
  })

/**
 * What an outcome does to the dialog, by the kind of the row. An undo leaves its dialog — the
 * dialog of the release it undoes, `done` and charged — where it is, and touches no credits: the
 * site, `main` and the operator are handled as for a release.
 */
export function releaseTaskEffectsOf(
  kind: ReleaseKind,
  outcome: ReleaseOutcome,
): ReleaseTaskEffect {
  const effect = releaseTaskEffects[outcome]
  return kind === 'release' ? effect : { ...effect, steps: [], credits: 'none' }
}

/**
 * While the release goes on: the status the dialog moves to with it (`awaiting_approval →
 * deploying` at the confirmation, `deploying → verifying` with the check). null — the dialog
 * stays where it is: a rollback leaves it in `deploying` or `verifying`, an outcome is in
 * `releaseTaskEffects`.
 */
export function taskStatusDuringRelease(status: ReleaseStatus): TaskStatus | null {
  switch (status) {
    case 'approved':
    case 'publishing':
    case 'published':
    case 'deploying':
      return 'deploying'
    case 'verifying':
      return 'verifying'
    default:
      return null
  }
}

/** What an operator may decide about an `unknown` release (`releases:resolve --outcome`). */
export const releaseResolutions = ['installed', 'rolled_back'] as const
export type ReleaseResolution = (typeof releaseResolutions)[number]
