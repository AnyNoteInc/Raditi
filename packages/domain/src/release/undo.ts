import { z } from 'zod'

import { isPublicationPath } from '../git/publication.ts'
import { CONFIRM_TOKEN_TTL_SECONDS } from './confirm-token.ts'
import { dbObjectRefSchema, dbRecordRefSchema } from './db-objects.ts'
import { dbOperationKinds, type DbOperationKind } from './db-plan.ts'

/**
 * «Отменить выпуск» (docs/plan/53-chat-preview-release.md, «Отмена выпуска»): within seven days
 * of its installation the release a site runs now can be undone — a new version (patch) whose
 * tree is the tree of the version before it, plus the media it added, and the inverse of its
 * database plan, written with preconditions by the same skill, release API and deploy job as a
 * release. What changed on production since the release is left as it is and named; nothing
 * replaces the database; an undo is not undone.
 *
 * Before the confirmation core works out the plan of the undo (`release_undo_plans`): which
 * files go back, which records return, and which stay — each object of the release's plan read
 * on production. The client confirms that plan; the deploy job writes exactly it or nothing.
 */
export const UNDO_WINDOW_MS = 7 * 24 * 60 * 60_000

/** The last moment an undo of a release installed at `installedAt` may be confirmed. */
export const undoDeadline = (installedAt: Date): Date =>
  new Date(installedAt.getTime() + UNDO_WINDOW_MS)

export const undoExpired = (installedAt: Date, now: Date): boolean =>
  now.getTime() >= undoDeadline(installedAt).getTime()

export const undoPlanStatuses = ['pending', 'ready', 'failed'] as const
export type UndoPlanStatus = (typeof undoPlanStatuses)[number]

/** Why core could not work out a plan (`release_undo_plans.error_code`). */
export const undoPlanErrors = [
  /** The site's plugin did not answer. */
  'site_unreachable',
  /** The repository of the site did not answer or refused. */
  'repository',
  /** Another version is installed now: there is nothing of this release to undo. */
  'undo_outdated',
  /** A release of the site went on while the plan was made: it is made again. */
  'site_busy',
  'technical',
] as const
export type UndoPlanError = (typeof undoPlanErrors)[number]

/** A ready plan stands as long as a confirmation does: older ones are made again. */
export const UNDO_PLAN_TTL_MS = CONFIRM_TOKEN_TTL_SECONDS * 1000
/** A pending plan younger than this is waited for, not asked for again. */
export const UNDO_PLAN_PENDING_MS = 2 * 60_000

/**
 * What becomes of one object of the release's plan:
 * - `return` — production holds what the release wrote: it goes back (a new record to the trash);
 * - `already` — production holds what it held before the release: nothing to write;
 * - `changed` — someone changed it on the site after the release: it stays;
 * - `missing` — it is not on the site any more: nothing to write;
 * - `stays` — the release added structure (a table, columns): it stays by design;
 * - `kept_dependents` — a new record of the release that the site has built on since (comments,
 *   pages below it, menu items): it stays, so nothing of the site goes with it;
 * - `no_value` — what it held before the release is not kept any more: it stays.
 */
export const undoItemVerdicts = [
  'return',
  'already',
  'changed',
  'missing',
  'stays',
  'kept_dependents',
  'no_value',
] as const
export type UndoItemVerdict = (typeof undoItemVerdicts)[number]

/** Verdicts of objects the undo leaves as the site holds them, though the release changed them. */
export const undoKeptVerdicts = [
  'changed',
  'missing',
  'kept_dependents',
  'no_value',
] as const satisfies readonly UndoItemVerdict[]

export const undoPlanItemSchema = z.strictObject({
  /** The reference in the plan of the release. */
  objectRef: dbObjectRefSchema,
  /** A record the release created: the reference production gave it; null — none known. */
  productionRef: dbRecordRefSchema.nullable(),
  kind: z.enum(dbOperationKinds),
  fields: z.array(z.string().regex(/^[a-z_]{1,32}$/)).max(8),
  verdict: z.enum(undoItemVerdicts),
})
export type UndoPlanItem = z.infer<typeof undoPlanItemSchema>

export const undoFileChanges = [
  /** A file the release changed: its content before the release comes back. */
  'back',
  /** A file the release added: it is deleted. */
  'removed',
  /** A file the release deleted: it comes back. */
  'restored',
] as const
export type UndoFileChange = (typeof undoFileChanges)[number]

/** Paths a plan names; the counts are whole. */
export const UNDO_SUMMARY_PATHS = 200

const count = z.number().int().min(0).max(1_000_000)

/** The files of an undo as the client is shown them. */
export const undoFilesSummarySchema = z.strictObject({
  back: count,
  removed: count,
  restored: count,
  /** Media the release added: they stay on the site (`addOnlyPaths` only grow). */
  mediaKept: count,
  paths: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024).refine(isPublicationPath),
        change: z.enum(undoFileChanges),
      }),
    )
    .max(UNDO_SUMMARY_PATHS),
})
export type UndoFilesSummary = z.infer<typeof undoFilesSummarySchema>

/**
 * The verdict of one object of the release's plan, from what production holds now (`current`:
 * its state hash — recomputed from its fields —, or `absent`): a table stays; a new record goes to
 * the trash only while it holds what the release wrote and nothing of the site stands on it; a
 * text or a setting goes back only from what the release wrote. `written` — the state the
 * release left (a new record: the hash of its receipt), `prior` — the state before it.
 */
export function classifyUndoOperation(input: {
  kind: DbOperationKind
  written: string
  prior: string
  current: string | 'absent'
  /** Records of the site that stand on a new record (comments, pages below it, menu items). */
  dependents?: number
}): UndoItemVerdict {
  const { kind, written, prior, current } = input
  if (kind === 'schema_migration') return 'stays'
  if (current === 'absent') return 'missing'
  if (kind === 'post_create') {
    if (current !== written) return 'changed'
    return (input.dependents ?? 0) > 0 ? 'kept_dependents' : 'return'
  }
  if (current === written) return 'return'
  if (current === prior) return 'already'
  return 'changed'
}

/** How many records an undo returns, and how many it leaves though the release changed them. */
export function undoRecordCounts(items: readonly Pick<UndoPlanItem, 'verdict'>[]): {
  returned: number
  kept: number
} {
  return {
    returned: items.filter((item) => item.verdict === 'return').length,
    kept: items.filter((item) =>
      (undoKeptVerdicts as readonly UndoItemVerdict[]).includes(item.verdict),
    ).length,
  }
}

export interface UndoPlanFacts {
  /** The release undone. */
  releaseId: string
  /** `sites.installed_sha` the plan was made against: the release's commit. */
  installedSha: string
  /** The tree of the undo commit: the version before the release, and the media it added. */
  targetTree: string
  files: UndoFilesSummary
  items: readonly UndoPlanItem[]
  /** `canonicalDbUndoPlanJson` of the writes. */
  dbPlanJson: string
}

/** The text `release_undo_plans.plan_sha256` is the SHA-256 of; the domain does not hash. */
export function undoPlanMaterial(facts: UndoPlanFacts): string {
  return JSON.stringify([
    'raditi-undo-plan:v1',
    facts.releaseId.toLowerCase(),
    facts.installedSha,
    facts.targetTree,
    {
      back: facts.files.back,
      removed: facts.files.removed,
      restored: facts.files.restored,
      mediaKept: facts.files.mediaKept,
      paths: facts.files.paths.map((entry) => [entry.path, entry.change]),
    },
    facts.items.map((item) => [
      item.objectRef,
      item.productionRef,
      item.kind,
      [...item.fields],
      item.verdict,
    ]),
    facts.dbPlanJson,
  ])
}
