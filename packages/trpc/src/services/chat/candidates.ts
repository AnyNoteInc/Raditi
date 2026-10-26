import type { PrismaClient } from '@repo/db'
import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  browserScreenshotKey,
  candidateFilesSchema,
  candidateMediaSchema,
  conflict,
  dbPlanSchema,
  dbPlanViewNeedsReview,
  dbPlanViewSchema,
  previewRuntimeMatchSchema,
  versionBumps,
  type CandidateCheckStatus,
  type CandidateFiles,
  type CandidateMedia,
  type CandidateStatus,
  type DbContentField,
  type DbPlanView,
  type ObjectStorage,
  type PreviewRuntimeMatch,
  type VersionBump,
} from '@repo/domain'
import { z } from 'zod'

import { accessibleTask, taskNotFound } from './access.ts'
import { versionProposal } from './versions.ts'

/** The words of a field of a record the release changes (Р3: the plugin writes these three). */
export const dbFieldText: Readonly<Record<DbContentField, string>> = Object.freeze({
  title: 'заголовок',
  content: 'текст',
  excerpt: 'описание',
})

/** «заголовок», «заголовок и текст», «заголовок, текст и описание». */
function listed(words: readonly string[]): string {
  if (words.length < 2) return words.join('')
  return `${words.slice(0, -1).join(', ')} и ${words.at(-1)}`
}

/**
 * The words of the records `content_update` writes (Р3: a published post or page, what the
 * platform's plugin writes), by the type part of the plan's `objectRef`. The operation names
 * its objects, so this is its vocabulary, not a branch on the stack; a type it does not name
 * here is said as «Запись».
 */
export const dbObjectText: Readonly<Record<string, string>> = Object.freeze({
  post: 'Запись',
  page: 'Страница',
})

const objectText = (objectType: string): string =>
  Object.hasOwn(dbObjectText, objectType) ? dbObjectText[objectType]! : 'Запись'

/** One record the release changes, said by the platform from its own plan — no words of the agent. */
export interface DbChange {
  /** The type of the record in the notation of the plan, e.g. `page`: an id, never shown. */
  objectType: string
  objectId: string
  fields: DbContentField[]
  /** «Страница 42: изменятся заголовок и текст». */
  text: string
}

/**
 * The words of an object of another kind of a plan (docs/plan/53, «Операции БД и миграции»),
 * until the panel shows the description of the plan with its values (`db_view`): a new record by
 * its type alone — its id is the preview's, never the site's —, a setting, the structure.
 */
const newRecordText: Readonly<Record<string, string>> = Object.freeze({
  post: 'Новая запись блога',
  page: 'Новая страница',
})

export function dbChangesOf(plan: unknown): DbChange[] {
  const parsed = dbPlanSchema.safeParse(plan)
  if (!parsed.success) throw conflict('The database plan of the candidate is unreadable')
  return parsed.data.map((operation) => {
    const [objectType = '', objectId = ''] = operation.objectRef.split(':')
    if (operation.kind !== 'content_update')
      return {
        objectType,
        // A table's name is the agent's text and may hold a value of the client's variable: only
        // the description, checked for one, names it.
        objectId: operation.kind === 'schema_migration' ? '' : objectId,
        fields: [],
        text:
          operation.kind === 'post_create'
            ? Object.hasOwn(newRecordText, objectType)
              ? newRecordText[objectType]!
              : 'Новая запись'
            : operation.kind === 'option_update'
              ? 'Настройка сайта: изменится значение'
              : 'База данных сайта: новая таблица или новые поля',
      }
    const verb = operation.fields.length > 1 ? 'изменятся' : 'изменится'
    const fields = listed(operation.fields.map((field) => dbFieldText[field]))
    return {
      objectType,
      objectId,
      fields: [...operation.fields],
      text: `${objectText(objectType)} ${objectId}: ${verb} ${fields}`,
    }
  })
}

export interface CandidateView {
  id: string
  taskId: string
  revision: number
  status: CandidateStatus
  turnNo: number
  createdAt: Date
  /** The version of the site the candidate stands on; null — not known (before the first release). */
  baseVersion: string | null
  files: CandidateFiles
  media: CandidateMedia
  /** The records of the plan in the platform's words, for a candidate without a description. */
  database: DbChange[]
  /**
   * The description of the plan with its values, as core keeps it with the revision
   * (docs/plan/53, «Операции БД и миграции»); null — the plan is empty, or the revision has none
   * (recorded before descriptions, or taken back when the client declared a variable since).
   */
  databaseView: DbPlanView | null
  /** `/release` asks the client to say they looked at every change: a bulk or shortened plan. */
  databaseReview: boolean
  checks: {
    id: string
    kind: string
    status: CandidateCheckStatus
    finishedAt: Date | null
    /** A screenshot of the agent's browser of the same look (Р22): readCheckScreenshot. */
    screenshot: boolean
  }[]
  /**
   * How the runtime of the dialog's preview stands to the site's (Р2, Р18), as its last build
   * found it: null — not known.
   */
  runtime: PreviewRuntimeMatch | null
  proposal: {
    /** The highest version known, the proposal counts from it. */
    base: string
    version: string
    bump: VersionBump
    /** The numbers the client may choose instead, one per kind of change. */
    choices: { version: string; bump: VersionBump }[]
  }
}

/**
 * A candidate of a dialog as the panel shows it (Р20): its files and media, the records of the
 * site the release changes, its checks and the number it would be released under now. Without
 * `revision` — the candidate the dialog waits with; null when the dialog has none.
 */
export async function readCandidate(
  db: PrismaClient,
  input: { userId: string; taskId: string; revision?: number | undefined },
): Promise<CandidateView | null> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true, siteId: true },
  })
  if (task === null) throw taskNotFound()
  const candidate = await db.taskCandidate.findFirst({
    where:
      input.revision === undefined
        ? { taskId: task.id, status: { in: ['current', 'stale'] } }
        : { taskId: task.id, revision: input.revision },
    orderBy: { revision: 'desc' },
    select: {
      id: true,
      revision: true,
      status: true,
      turnNo: true,
      createdAt: true,
      baseVersion: true,
      files: true,
      media: true,
      dbPlan: true,
      dbView: true,
      facts: true,
      checks: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, kind: true, status: true, finishedAt: true, artifactKey: true },
      },
    },
  })
  if (candidate === null) return null
  const files = candidateFilesSchema.safeParse(candidate.files)
  const media = candidateMediaSchema.safeParse(candidate.media)
  if (!files.success || !media.success) throw conflict('The candidate is unreadable')
  const preview = await db.previewEnvironment.findUnique({
    where: { taskId: task.id },
    select: { runtime: true },
  })
  // What core recorded of the preview's runtime; a record of another shape tells nothing.
  const runtime = z
    .object({ runtimeMatch: previewRuntimeMatchSchema.nullable().optional() })
    .safeParse(preview?.runtime)
  const proposal = await versionProposal(db, {
    siteId: task.siteId,
    baseVersion: candidate.baseVersion,
    facts: candidate.facts,
  })
  // What core wrote with the revision; a value of another shape is shown as none.
  const described = dbPlanViewSchema.safeParse(candidate.dbView)
  const view = described.success ? described.data : null
  return {
    id: candidate.id,
    taskId: task.id,
    revision: candidate.revision,
    status: candidate.status,
    turnNo: candidate.turnNo,
    createdAt: candidate.createdAt,
    baseVersion: candidate.baseVersion,
    files: files.data,
    media: media.data,
    database: dbChangesOf(candidate.dbPlan),
    databaseView: view,
    databaseReview: view !== null && dbPlanViewNeedsReview(view),
    checks: candidate.checks.map(({ artifactKey, ...check }) => ({
      ...check,
      // A stale check is of another revision: its look is no longer the preview's.
      screenshot: artifactKey !== null && check.status !== 'stale',
    })),
    runtime: runtime.success ? (runtime.data.runtimeMatch ?? null) : null,
    proposal: {
      base: proposal.base,
      version: proposal.version,
      bump: proposal.bump,
      choices: versionBumps.map((bump) => ({ version: proposal.choices[bump], bump })),
    },
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The screenshot of the agent's browser a check of a candidate keeps (Р21, Р22, N22), for the
 * «Проверки» tab: a member of the dialog's workspace reads the PNG of a check of its own dialog,
 * while the check is not stale. null — no such check, no screenshot, or the object is gone; the
 * key must be the dialog's own screenshot key and the bytes a PNG of at most
 * BROWSER_SCREENSHOT_MAX_BYTES, whatever the row says.
 */
export async function readCheckScreenshot(
  db: Pick<PrismaClient, 'candidateCheck'>,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; checkId: string },
): Promise<Buffer | null> {
  if (!z.uuid().safeParse(input.taskId).success || !z.uuid().safeParse(input.checkId).success)
    return null
  const check = await db.candidateCheck.findFirst({
    where: {
      id: input.checkId,
      kind: 'agent_browser',
      status: { not: 'stale' },
      candidate: { task: accessibleTask(input.userId, input.taskId) },
    },
    select: { artifactKey: true },
  })
  const key = check?.artifactKey ?? null
  // The dialog's own screenshot key, and nothing else of raditi-artifacts.
  const id = key ? /\/screenshots\/([0-9a-f-]{36})\.png$/.exec(key)?.[1] : undefined
  if (!key || !id || browserScreenshotKey(input.taskId, id) !== key) return null
  const object = await storage.get('artifacts', key)
  if (!object) return null
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of object) {
    length += chunk.byteLength
    if (length > BROWSER_SCREENSHOT_MAX_BYTES) return null
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? bytes : null
}
