import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import {
  enqueueReleaseAdvance,
  insertFeedEvent,
  Prisma,
  requestUndoPlan,
  undoReturnsTo,
  type PrismaClient,
} from '@repo/db'
import {
  CONFIRM_TOKEN_TTL_SECONDS,
  DB_PLAN_BULK_OBJECTS,
  DomainError,
  formatVersion,
  maxVersion,
  nextVersion,
  undoConfirmTokenClaimsSchema,
  undoConfirmTokenMaterial,
  undoFilesSummarySchema,
  undoKeyMaterial,
  undoPlanItemSchema,
  undoRecordCounts,
  UNDO_PLAN_TTL_MS,
  ZERO_VERSION,
  type DbContentField,
  type ReleaseStatus,
  type UndoConfirmTokenClaims,
  type UndoFileChange,
  type UndoItemVerdict,
  type UndoPlanItem,
} from '@repo/domain'
import { z } from 'zod'

import { accessibleTask, isManagerRole, memberRole, taskNotFound } from './access.ts'
import { dbFieldText, dbObjectText } from './candidates.ts'
import { assertCommandAvailable, commandRefusal, dialogFacts } from './dialog-facts.ts'
import { underDialogLock } from './dialog-lock.ts'
import {
  commandUnavailable,
  releaseConfirmationExpired,
  releaseConfirmationInvalid,
  releaseInProgress,
  releaseReviewRequired,
} from './refusals.ts'

// «Отменить выпуск» (docs/plan/53-chat-preview-release.md, «Отмена выпуска»): the window asks core
// for the plan of the undo (`release.undoPrepare`), shows it when it is ready (`release.undoPlan`)
// with a confirmation bound to exactly that plan and number, and `release.undoConfirm` writes
// the undo — a row of `site_releases` of the kind `undo` in the dialog of the release — that core
// carries to the site as a release. Words of the model never stand for a confirmation.

/** The plan changed under the confirmation: the window asks for it again. */
export const undoPlanChanged = () =>
  new DomainError('RELEASE_UNDO_PLAN_CHANGED', 'The plan of the undo changed', 409)
/** The number of the undo is not the one to use now: the window asks for the plan again. */
export const undoVersionTaken = () =>
  new DomainError('RELEASE_UNDO_VERSION_TAKEN', 'The version of the undo is taken', 409)

/** Paths the window names; the counts are whole. */
const SHOWN_PATHS = 50
const MAX_TOKEN_CHARS = 1024

const hmac = (key: Uint8Array, claims: UndoConfirmTokenClaims): Buffer =>
  createHmac('sha256', key).update(undoConfirmTokenMaterial(claims)).digest()

/** `<claims>.<signature>`, as the confirmation of a release, over the text of an undo's. */
export function signUndoConfirmToken(key: Uint8Array, claims: UndoConfirmTokenClaims): string {
  const value = undoConfirmTokenClaimsSchema.parse(claims)
  return `${Buffer.from(JSON.stringify(value)).toString('base64url')}.${hmac(key, value).toString('base64url')}`
}

/** The claims of an undo's confirmation this process signed; a release's never pass. */
export function verifyUndoConfirmToken(
  key: Uint8Array,
  token: string,
  now: Date,
): UndoConfirmTokenClaims {
  const parts = token.length > MAX_TOKEN_CHARS ? [] : token.split('.')
  const [body, signature] = parts
  if (parts.length !== 2 || !body || !signature) throw releaseConfirmationInvalid()
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw releaseConfirmationInvalid()
  }
  const claims = undoConfirmTokenClaimsSchema.safeParse(json)
  if (!claims.success) throw releaseConfirmationInvalid()
  const given = Buffer.from(signature, 'base64url')
  const expected = hmac(key, claims.data)
  if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected))
    throw releaseConfirmationInvalid()
  if (now.getTime() >= claims.data.expiresAt * 1000) throw releaseConfirmationExpired()
  return claims.data
}

type Reader = Pick<Prisma.TransactionClient, 'site' | 'siteRelease'>

/** The number of an undo: a patch above the highest version the platform knows of the site. */
export async function undoVersionOf(db: Reader, siteId: string): Promise<string> {
  const site = await db.site.findUniqueOrThrow({
    where: { id: siteId },
    select: { installedVersion: true },
  })
  const releases = await db.siteRelease.findMany({ where: { siteId }, select: { version: true } })
  const base =
    maxVersion([site.installedVersion, ...releases.map((release) => release.version)]) ??
    ZERO_VERSION
  return formatVersion(nextVersion(base, 'patch'))
}

/** The dialog, its facts and the release of it the command is about, available or refused. */
async function undoable(
  db: PrismaClient | Prisma.TransactionClient,
  input: { userId: string; taskId: string; releaseId: string; now: Date },
) {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true, workspaceId: true, siteId: true, status: true },
  })
  if (task === null) throw taskNotFound()
  const facts = await dialogFacts(db, task, input.userId, input.now)
  assertCommandAvailable(facts.commands, 'undo')
  const undo = facts.undo!
  if (undo.releaseId !== input.releaseId) throw commandUnavailable('undo', 'not_installed')
  const release = await db.siteRelease.findUniqueOrThrow({
    where: { id: undo.releaseId },
    select: { id: true, version: true, approvedSha: true, installedBeforeSha: true },
  })
  if (release.approvedSha === null) throw commandUnavailable('undo', 'not_installed')
  return { task, facts, undo, release: { ...release, approvedSha: release.approvedSha } }
}

// ---------------------------------------------------------------------------------------------
// release.undoPrepare
// ---------------------------------------------------------------------------------------------

/**
 * Opening «Отменить выпуск»: an owner or an admin, of the version the dialog installed and the
 * site runs, within its seven days. Asks core for the plan (or finds the one still standing) in
 * one transaction with its job; nothing reaches the site.
 */
export async function prepareUndo(
  db: PrismaClient,
  input: { userId: string; taskId: string; releaseId: string; now: Date },
): Promise<{ planId: string }> {
  const { task, release } = await undoable(db, input)
  const plan = await db.$transaction((tx) =>
    requestUndoPlan(tx, {
      releaseId: release.id,
      siteId: task.siteId,
      installedSha: release.approvedSha,
      userId: input.userId,
    }),
  )
  return { planId: plan.id }
}

// ---------------------------------------------------------------------------------------------
// release.undoPlan
// ---------------------------------------------------------------------------------------------

/** One object of the release, said by the platform: what the undo does with it. */
export interface UndoRecordView {
  objectType: string
  objectId: string
  verdict: UndoItemVerdict
  /** «Страница 42: вернём заголовок и текст». */
  text: string
}

export type UndoPlanView =
  | { state: 'pending' }
  /** The plan is older than a confirmation lives, or of another installed version: ask again. */
  | { state: 'expired' }
  | { state: 'failed'; reason: 'site_unreachable' | 'repository' | 'technical' }
  | {
      state: 'ready'
      planId: string
      releaseId: string
      undoneVersion: string
      /** The version the site goes back to. */
      returnsTo: string
      /** The number the undo comes out as. */
      version: string
      until: Date
      files: {
        back: number
        removed: number
        restored: number
        mediaKept: number
        paths: { path: string; change: UndoFileChange }[]
        more: number
      }
      records: UndoRecordView[]
      nothingToUndo: boolean
      /** More objects go back than a change may hold without a look at each (rule 4). */
      review: boolean
      confirmToken: string
      expiresAt: Date
    }

const listed = (words: readonly string[]): string =>
  words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} и ${words.at(-1)}`

const objectWord = (type: string): string =>
  Object.hasOwn(dbObjectText, type) ? dbObjectText[type]! : 'Запись'

const keptReason: Readonly<Partial<Record<UndoItemVerdict, string>>> = Object.freeze({
  changed: 'её изменили на сайте после выпуска',
  missing: 'её удалили на сайте',
  no_value: 'прежнее содержимое больше не хранится',
  kept_dependents: 'на ней уже есть комментарии или на неё ссылается меню',
})

/** The words of one object of the release and its verdict — the platform's, never the agent's. */
export function undoItemText(item: UndoPlanItem): UndoRecordView {
  const ref = item.productionRef ?? item.objectRef
  const [objectType = '', objectId = ''] = ref.split(':')
  const view = (text: string) => ({ objectType, objectId, verdict: item.verdict, text })
  switch (item.kind) {
    case 'schema_migration':
      return view('Структура базы данных, которую добавил выпуск, останется')
    case 'post_create': {
      const name =
        item.productionRef === null
          ? `Новая ${objectType === 'page' ? 'страница' : 'запись'} выпуска`
          : `${objectWord(objectType)} ${objectId}, которую добавил выпуск,`
      if (item.verdict === 'return') return view(`${name} уйдёт в корзину`)
      if (item.verdict === 'missing') return view(`${name} уже убрана с сайта`)
      // A new page had no content before the release: what is gone is the record of the release.
      const reason =
        item.verdict === 'no_value' ? 'сведения о ней больше не хранятся' : keptReason[item.verdict]
      return view(`${name} останется: ${reason ?? 'её не трогаем'}`)
    }
    case 'option_update': {
      const name = 'Настройка сайта'
      if (item.verdict === 'return') return view(`${name}: вернём прежнее значение`)
      if (item.verdict === 'already') return view(`${name}: уже как до выпуска`)
      return view(`${name}: не вернём — ${keptReason[item.verdict] ?? 'её не трогаем'}`)
    }
    case 'content_update': {
      const name = `${objectWord(objectType)} ${objectId}`
      if (item.verdict === 'return') {
        const fields = item.fields.filter((field): field is DbContentField =>
          Object.hasOwn(dbFieldText, field),
        )
        return view(`${name}: вернём ${listed(fields.map((field) => dbFieldText[field]))}`)
      }
      if (item.verdict === 'already') return view(`${name}: уже как до выпуска`)
      return view(`${name}: не вернём — ${keptReason[item.verdict] ?? 'её не трогаем'}`)
    }
  }
}

const failedReason = (code: string | null): 'site_unreachable' | 'repository' | 'technical' =>
  code === 'site_unreachable' || code === 'repository' ? code : 'technical'

/**
 * The plan the window shows: pending while core works it out; ready — what the undo returns and
 * leaves, the version it goes back to and the number it comes out as, with the confirmation of
 * exactly this plan and number for ten minutes; expired — made too long ago or against another
 * version: the window asks for a new one.
 */
export async function readUndoPlan(
  db: PrismaClient,
  key: Uint8Array,
  input: { userId: string; taskId: string; releaseId: string; planId: string; now: Date },
): Promise<UndoPlanView> {
  const { task, undo, release } = await undoable(db, input)
  const plan = await db.releaseUndoPlan.findFirst({
    where: { id: input.planId, releaseId: release.id, siteId: task.siteId },
  })
  if (plan === null) throw taskNotFound()
  if (plan.status === 'pending') return { state: 'pending' }
  if (plan.status === 'failed')
    return plan.errorCode === 'site_busy' || plan.errorCode === 'undo_outdated'
      ? { state: 'expired' }
      : { state: 'failed', reason: failedReason(plan.errorCode) }
  if (
    input.now.getTime() - plan.createdAt.getTime() > UNDO_PLAN_TTL_MS ||
    plan.installedSha !== release.approvedSha ||
    plan.planSha256 === null ||
    plan.targetTree === null
  )
    return { state: 'expired' }
  const items = z.array(undoPlanItemSchema).parse(plan.items)
  const files = undoFilesSummarySchema.parse(plan.files)
  const version = await undoVersionOf(db, task.siteId)
  const expiresAt = Math.floor(input.now.getTime() / 1000) + CONFIRM_TOKEN_TTL_SECONDS
  return {
    state: 'ready',
    planId: plan.id,
    releaseId: release.id,
    undoneVersion: release.version,
    returnsTo: await undoReturnsTo(db, {
      siteId: task.siteId,
      installedBeforeSha: release.installedBeforeSha,
    }),
    version,
    until: undo.until!,
    files: {
      back: files.back,
      removed: files.removed,
      restored: files.restored,
      mediaKept: files.mediaKept,
      paths: files.paths.slice(0, SHOWN_PATHS),
      more: files.back + files.removed + files.restored - Math.min(files.paths.length, SHOWN_PATHS),
    },
    records: items.map(undoItemText),
    nothingToUndo: plan.nothingToUndo,
    review: undoRecordCounts(items).returned > DB_PLAN_BULK_OBJECTS,
    confirmToken: signUndoConfirmToken(key, {
      userId: input.userId,
      releaseId: release.id,
      planId: plan.id,
      planSha256: plan.planSha256,
      version,
      expiresAt,
    }),
    expiresAt: new Date(expiresAt * 1000),
  }
}

// ---------------------------------------------------------------------------------------------
// release.undoConfirm
// ---------------------------------------------------------------------------------------------

export interface ConfirmedUndo {
  undoId: string
  status: ReleaseStatus
  version: string
  /** The same confirmation was delivered before: nothing was written now. */
  repeated: boolean
}

/** Which constraint a lost race of two confirmations met. */
const takenBy = (error: unknown): 'open' | 'version' | null => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
    return null
  const target = JSON.stringify(error.meta ?? {})
  return target.includes('version') ? 'version' : 'open'
}

/**
 * `release.undoConfirm`: the confirmation is checked — its signature, its time, its user, its
 * release and its number — and in one transaction under the lock of the dialog the role, the
 * command, the plan (ready, of this release and site, its hash, something to undo), the client's
 * look at a bulk plan and the number are checked again. Then the undo is written `approved` with
 * its key, the press goes into the feed and `release.advance` into the outbox. The dialog of the
 * release stays as it is; nothing is reserved or charged (rule 7). A repeat of the same
 * confirmation returns the same undo.
 */
export async function confirmUndo(
  db: PrismaClient,
  key: Uint8Array,
  input: {
    userId: string
    taskId: string
    releaseId: string
    confirmToken: string
    version: string
    reviewed?: boolean | undefined
    now: Date
  },
): Promise<ConfirmedUndo> {
  const { userId, now } = input
  const claims = verifyUndoConfirmToken(key, input.confirmToken, now)
  if (
    claims.userId !== userId ||
    claims.version !== input.version ||
    claims.releaseId !== input.releaseId
  )
    throw releaseConfirmationInvalid()
  try {
    return await underDialogLock(db, input, async (tx, task) => {
      const earlier = await tx.siteRelease.findFirst({
        where: {
          taskId: task.id,
          kind: 'undo',
          undoesReleaseId: claims.releaseId,
          undoPlanId: claims.planId,
          version: claims.version,
        },
        select: { id: true, status: true, version: true },
      })
      if (earlier !== null)
        return {
          undoId: earlier.id,
          status: earlier.status,
          version: earlier.version,
          repeated: true,
        }
      if (!isManagerRole(await memberRole(tx, task.workspaceId, userId)))
        throw commandUnavailable('undo', 'not_allowed')
      const release = await tx.siteRelease.findFirst({
        where: { id: claims.releaseId, taskId: task.id, siteId: task.siteId, kind: 'release' },
        select: { id: true, version: true, approvedSha: true },
      })
      if (release === null || release.approvedSha === null) throw releaseConfirmationInvalid()
      const facts = await dialogFacts(tx, task, userId, now)
      const refusal = commandRefusal(facts.commands, 'undo')
      if (refusal !== null) throw commandUnavailable('undo', refusal)
      if (facts.undo?.releaseId !== release.id) throw commandUnavailable('undo', 'not_installed')
      const plan = await tx.releaseUndoPlan.findFirst({
        where: { id: claims.planId, releaseId: release.id, siteId: task.siteId },
        select: {
          status: true,
          planSha256: true,
          installedSha: true,
          nothingToUndo: true,
          items: true,
        },
      })
      if (
        plan?.status !== 'ready' ||
        plan.planSha256 !== claims.planSha256 ||
        plan.installedSha !== release.approvedSha ||
        plan.nothingToUndo
      )
        throw undoPlanChanged()
      const items = z.array(undoPlanItemSchema).safeParse(plan.items)
      if (!items.success) throw undoPlanChanged()
      const records = undoRecordCounts(items.data)
      if (records.returned > DB_PLAN_BULK_OBJECTS && input.reviewed !== true)
        throw releaseReviewRequired()
      if ((await undoVersionOf(tx, task.siteId)) !== claims.version) throw undoVersionTaken()

      const site = await tx.site.findUniqueOrThrow({
        where: { id: task.siteId },
        select: { installedSha: true },
      })
      const attempt =
        (await tx.siteRelease.count({ where: { kind: 'undo', undoesReleaseId: release.id } })) + 1
      const undo = await tx.siteRelease.create({
        data: {
          siteId: task.siteId,
          taskId: task.id,
          kind: 'undo',
          undoesReleaseId: release.id,
          undoPlanId: claims.planId,
          undoPlanSha256: claims.planSha256,
          attempt,
          releaseKey: createHash('sha256')
            .update(
              undoKeyMaterial({
                undoesReleaseId: release.id,
                planId: claims.planId,
                version: claims.version,
                attempt,
              }),
            )
            .digest('hex'),
          version: claims.version,
          tag: claims.version,
          bump: 'patch',
          // `main` holds the release undone (Р27); core pushes by CAS against `main` as it is.
          mainBeforeSha: release.approvedSha,
          installedBeforeSha: site.installedSha,
          committedAt: now,
          status: 'approved',
          approvedBy: userId,
          approvedAt: now,
          enqueues: 1,
        },
        select: { id: true, status: true, version: true },
      })
      await insertFeedEvent(tx, {
        taskId: task.id,
        row: {
          type: 'feed.undo',
          payload: {
            v: 1,
            stage: 'confirmed',
            undoId: undo.id,
            releaseId: release.id,
            undoneVersion: release.version,
            version: claims.version,
            authorId: userId,
          },
        },
      })
      await enqueueReleaseAdvance(tx, {
        releaseId: undo.id,
        status: 'approved',
        step: null,
        seq: 1,
      })
      return { undoId: undo.id, status: undo.status, version: undo.version, repeated: false }
    })
  } catch (error) {
    // Two confirmations at once: one undo of a release goes on at a time, a number is used once.
    const taken = takenBy(error)
    if (taken === 'version') throw undoVersionTaken()
    if (taken === 'open') throw releaseInProgress()
    throw error
  }
}

export type { UndoConfirmTokenClaims }
