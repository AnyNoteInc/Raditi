import { createHash, randomBytes } from 'node:crypto'

import {
  assembleDocMarkdown,
  DomainError,
  docLimitReached,
  docNotFound,
  docPendingSections,
  docSectionUnknown,
  newPageSlug,
  pageLimits,
  pageLimitReached,
  pageNotFound,
  type DocSectionState,
  type PageKind,
  type PageRefusalReason,
} from '@repo/domain'

import { Prisma, type PrismaClient } from './generated/prisma/client.ts'

// The pages and documents of a workspace (docs/plan/69-pages.md, Ст6, Ст7, Ст13–Ст16, Ст19–Ст21).
// A page has one slug for ever and the bytes of its current version alone; a document has its
// sections, the Markdown of its current version, and the history of both as numbers and sums.
// Every change takes the row lock of its page or document first, so that concurrent turns and the
// cabinet count versions and positions one at a time; the counts of a workspace take its row with
// FOR NO KEY UPDATE, which leaves the inserts that only reference it alone.

type Db = Pick<PrismaClient, '$transaction'>
type Tx = Prisma.TransactionClient

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8')

/** The placeholder of a section the agent inserted without saying what it is for. */
export const INSERTED_SECTION_INTENT = 'Новый раздел'

/**
 * What a section said when core scanned it: the heading and the text, as one sum. A write after
 * the scan changes it, and then the section is not marked checked (Ст19).
 */
export const sectionDigest = (heading: string | null, markdown: string | null): string =>
  sha256(`${heading ?? ''}\u0000${markdown ?? ''}`)

async function lockPage(tx: Tx, pageId: string, workspaceId?: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM pages WHERE id = ${pageId}::uuid FOR UPDATE`
  if (rows.length === 0) throw pageNotFound()
  const page = await tx.page.findUniqueOrThrow({ where: { id: pageId } })
  if (workspaceId !== undefined && page.workspaceId !== workspaceId) throw pageNotFound()
  return page
}

async function lockDocument(tx: Tx, documentId: string, workspaceId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM chat_documents WHERE id = ${documentId}::uuid FOR UPDATE`
  if (rows.length === 0) throw docNotFound()
  const document = await tx.chatDocument.findUniqueOrThrow({ where: { id: documentId } })
  if (document.workspaceId !== workspaceId) throw docNotFound()
  return document
}

/** The workspace's row for its counts, and that the chat is its own; `missing` — what to throw. */
async function lockWorkspaceOfChat(
  tx: Tx,
  workspaceId: string,
  taskId: string,
  missing: () => Error,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT w.id FROM workspaces w
    WHERE w.id = ${workspaceId}::uuid
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${taskId}::uuid AND t.workspace_id = w.id)
    FOR NO KEY UPDATE OF w`
  if (rows.length === 0) throw missing()
}

/** The client took the page down: a new version waits for them to put it back. */
const pageTakenDown = () =>
  new DomainError(
    'PAGE_TAKEN_DOWN',
    'The client took this page down: only they can put it back, in the cabinet. Tell them so, or publish a new page.',
    409,
  )

/** The file of this turn is reserved for another page already. */
const pageReservedOtherwise = () =>
  new DomainError(
    'PAGE_RESERVED',
    'This file is already published as another page in this turn: use another file name.',
    409,
  )

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

// ———————————————————————————————————————— pages

export type PagePublicationTarget = { fileName: string } | { documentId: string }

export interface PagePublicationInput {
  workspaceId: string
  taskId: string
  turnNo: number
  title: string
  target: PagePublicationTarget
  /** A new version of this page; absent — a new page (or the page of the document). */
  pageId?: string
}

export interface PagePublication {
  pageId: string
  slug: string
  /** The number the version gets when the end of the turn makes it (Ст16). */
  version: number
}

/**
 * The agent's `page_publish` (Ст6, Ст7): a page is reserved — new, the page of the document, or
 * the one named — and the publication waits for the end of the turn. The same file or document
 * asked again in the same turn is the same reservation, even when the two calls race.
 */
export async function reservePagePublication(
  db: Db,
  input: PagePublicationInput,
  now: Date = new Date(),
): Promise<PagePublication> {
  try {
    return await reserveOnce(db, input, now)
  } catch (error) {
    // The twin call of the same turn won the unique key: its reservation is this one.
    if (isUniqueViolation(error)) return reserveOnce(db, input, now)
    throw error
  }
}

async function reserveOnce(
  db: Db,
  input: PagePublicationInput,
  now: Date,
): Promise<PagePublication> {
  const { workspaceId, taskId, turnNo, title, target } = input
  const fileName = 'fileName' in target ? target.fileName : null
  const documentId = 'documentId' in target ? target.documentId : null
  return db.$transaction(async (tx) => {
    const known = await tx.pageReservation.findFirst({
      where: { taskId, turnNo, ...(fileName ? { fileName } : { documentId }) },
      include: { page: true },
    })
    if (known) {
      if (known.page.workspaceId !== workspaceId) throw pageNotFound()
      // The same call again is the same reservation; the same file for another page is not.
      if (input.pageId !== undefined && input.pageId !== known.pageId) throw pageReservedOtherwise()
      return { pageId: known.pageId, slug: known.page.slug, version: known.page.currentVersion + 1 }
    }
    // Two turns cannot both take the last place.
    await lockWorkspaceOfChat(tx, workspaceId, taskId, pageNotFound)
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const lastHour = await tx.pageReservation.count({
      where: { createdAt: { gt: hourAgo }, page: { workspaceId } },
    })
    if (lastHour >= pageLimits.publishesPerHour) throw pageLimitReached('publishesPerHour')

    let page = input.pageId ? await lockPage(tx, input.pageId, workspaceId) : null
    // A version of a page taken down would answer 410: the client puts it back, not the agent;
    // one the operator took down is gone for the workspace (Ст15, Ст31).
    if (page?.state === 'taken_down')
      throw page.takenDownBy === 'operator' ? pageNotFound() : pageTakenDown()
    // A page of a document gets its versions from the document, a page of a file from files.
    if (page !== null && (page.documentId === null) !== (documentId === null)) throw pageNotFound()
    if (page !== null && documentId !== null && page.documentId !== documentId) throw pageNotFound()
    if (page === null && documentId !== null) {
      const document = await lockDocument(tx, documentId, workspaceId)
      page = await tx.page.findUnique({ where: { documentId: document.id } })
    }
    if (page === null) {
      // Published and taken-down pages count; a reservation that never came true does not
      // (the sweeper removes those, plan 69, slice 69.6).
      const pages = await tx.page.count({ where: { workspaceId, state: { not: 'pending' } } })
      if (pages >= pageLimits.pagesPerWorkspace) throw pageLimitReached('pagesPerWorkspace')
      const kind: PageKind =
        documentId !== null ? 'doc' : /\.(md|markdown)$/i.test(fileName ?? '') ? 'markdown' : 'html'
      page = await tx.page.create({
        data: {
          workspaceId,
          taskId,
          turnNo,
          kind,
          slug: newPageSlug((size) => randomBytes(size)),
          title,
          documentId,
          sourceFileName: fileName,
        },
      })
    }
    await tx.pageReservation.create({
      data: { pageId: page.id, taskId, turnNo, fileName, documentId, title },
    })
    return { pageId: page.id, slug: page.slug, version: page.currentVersion + 1 }
  })
}

/** The publications of one turn that wait for its end. */
export function pendingPageReservations(
  db: Pick<PrismaClient, 'pageReservation'>,
  taskId: string,
  turnNo: number,
) {
  return db.pageReservation.findMany({
    where: { taskId, turnNo, outcome: null },
    orderBy: { createdAt: 'asc' },
    include: { page: { select: { id: true, slug: true, kind: true, workspaceId: true } } },
  })
}

export interface PageVersionInput {
  pageId: string
  /** The workspace the caller acts for: a page of another one is not found (Ст20). */
  workspaceId?: string
  bytes: Uint8Array
  source: 'outbox' | 'doc' | 'file'
  title?: string
  taskId?: string | null
  turnNo?: number | null
  /** The reservation this version fulfils: of this page and still open, or nothing is written. */
  reservationId?: string
}

/**
 * The next version of a page: its number only grows, its bytes replace the former ones (Ст16),
 * a pending page goes live. A taken-down page stays down — the client puts it back.
 */
export async function applyPageVersion(
  db: Db,
  input: PageVersionInput,
): Promise<{ version: number }> {
  if (input.bytes.byteLength > pageLimits.contentBytes) throw pageLimitReached('contentBytes')
  return db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    const no = page.currentVersion + 1
    if (input.reservationId) {
      const closed = await tx.pageReservation.updateMany({
        where: { id: input.reservationId, pageId: page.id, outcome: null },
        data: { outcome: 'done', versionNo: no, settledAt: new Date() },
      })
      if (closed.count !== 1) throw pageNotFound()
    }
    await tx.pageVersion.create({
      data: {
        pageId: page.id,
        no,
        sizeBytes: input.bytes.byteLength,
        sha256: sha256(input.bytes),
        source: input.source,
        taskId: input.taskId ?? null,
        turnNo: input.turnNo ?? null,
      },
    })
    const bytes = new Uint8Array(input.bytes)
    await tx.pageContent.upsert({
      where: { pageId: page.id },
      create: { pageId: page.id, versionNo: no, bytes },
      update: { versionNo: no, bytes },
    })
    await tx.page.update({
      where: { id: page.id },
      data: {
        currentVersion: no,
        ...(page.state === 'pending' ? { state: 'live' } : {}),
        ...(input.title ? { title: input.title } : {}),
      },
    })
    return { version: no }
  })
}

/** A reservation the end of its turn could not fulfil (`feed.page_left`). */
export async function settlePageReservation(
  db: Pick<PrismaClient, 'pageReservation'>,
  reservationId: string,
  outcome: 'missing' | 'refused' | 'failed',
): Promise<void> {
  await db.pageReservation.updateMany({
    where: { id: reservationId, outcome: null },
    data: { outcome, settledAt: new Date() },
  })
}

export interface ServedPage {
  id: string
  state: 'pending' | 'live' | 'taken_down'
  kind: PageKind
  passwordHash: string | null
  passwordEpoch: number
  /** The current version; null while pending. */
  content: { version: number; bytes: Uint8Array } | null
}

/** What the page server answers a slug with: one query, the database alone (Ст4). */
export async function servedPage(
  db: Pick<PrismaClient, 'page'>,
  slug: string,
): Promise<ServedPage | null> {
  const page = await db.page.findUnique({
    where: { slug },
    select: {
      id: true,
      state: true,
      kind: true,
      passwordHash: true,
      passwordEpoch: true,
      content: { select: { versionNo: true, bytes: true } },
    },
  })
  if (!page) return null
  return {
    id: page.id,
    state: page.state as ServedPage['state'],
    kind: page.kind as PageKind,
    passwordHash: page.passwordHash,
    passwordEpoch: page.passwordEpoch,
    content:
      page.state === 'pending' || !page.content
        ? null
        : { version: page.content.versionNo, bytes: page.content.bytes },
  }
}

/** The client sets or clears the password (Ст13); the cookies of the former one stop. */
export async function setPagePassword(
  db: Db,
  input: { workspaceId: string; pageId: string; passwordHash: string | null },
): Promise<{ passwordEpoch: number }> {
  return db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    const updated = await tx.page.update({
      where: { id: page.id },
      data: { passwordHash: input.passwordHash, passwordEpoch: page.passwordEpoch + 1 },
    })
    return { passwordEpoch: updated.passwordEpoch }
  })
}

/** Who takes a page down: the client of its workspace, or the operator for any page. */
export type PageTakeDown =
  { pageId: string; by: 'client'; workspaceId: string } | { pageId: string; by: 'operator' }

/** «Снять с публикации» (Ст15, Ст31): 410 until it is put back; nothing is deleted. */
export async function takeDownPage(db: Db, input: PageTakeDown): Promise<void> {
  await db.$transaction(async (tx) => {
    const page = await lockPage(
      tx,
      input.pageId,
      input.by === 'client' ? input.workspaceId : undefined,
    )
    if (page.state === 'pending') throw pageNotFound()
    // The operator's word stands over the client's: a page the client took down is taken over.
    if (page.state === 'taken_down' && (input.by === 'client' || page.takenDownBy === 'operator'))
      return
    await tx.page.update({
      where: { id: page.id },
      data: { state: 'taken_down', takenDownAt: new Date(), takenDownBy: input.by },
    })
  })
}

/**
 * «Вернуть на публикацию»: the same address, the current version. A page the operator took down
 * the client cannot put back.
 */
export async function restorePage(
  db: Db,
  input: { pageId: string; workspaceId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    if (page.state !== 'taken_down') return
    if (page.takenDownBy === 'operator') throw pageNotFound()
    await tx.page.update({
      where: { id: page.id },
      data: { state: 'live', takenDownAt: null, takenDownBy: null },
    })
  })
}

/**
 * The pages of a workspace for its section «Страницы» and for `page_list` (Ст20, Ст30). Whether
 * a password is set, never its hash: the list goes to the cabinet and to the model.
 */
export async function listWorkspacePages(db: Pick<PrismaClient, 'page'>, workspaceId: string) {
  const pages = await db.page.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      slug: true,
      title: true,
      kind: true,
      state: true,
      currentVersion: true,
      taskId: true,
      documentId: true,
      takenDownBy: true,
      updatedAt: true,
      passwordHash: true,
    },
  })
  return pages.map(({ passwordHash, ...page }) => ({ ...page, hasPassword: passwordHash !== null }))
}

// ———————————————————————————————————————— documents

export interface ChatDocumentSkeleton {
  workspaceId: string
  taskId: string
  title: string
  sections: readonly { key: string; intent: string }[]
}

/** `doc_create` (Ст21): the skeleton, every section pending with its intent. */
export async function createChatDocument(db: Db, input: ChatDocumentSkeleton) {
  if (input.sections.length > pageLimits.docSections) throw docLimitReached('docSections')
  return db.$transaction(async (tx) => {
    await lockWorkspaceOfChat(tx, input.workspaceId, input.taskId, docNotFound)
    const documents = await tx.chatDocument.count({ where: { workspaceId: input.workspaceId } })
    if (documents >= pageLimits.docsPerWorkspace) throw docLimitReached('docsPerWorkspace')
    return tx.chatDocument.create({
      data: {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        title: input.title,
        sections: {
          create: input.sections.map((section, position) => ({
            sectionKey: section.key,
            intent: section.intent,
            position,
          })),
        },
      },
      select: { id: true, revision: true },
    })
  })
}

/** Positions 0, 1, … in this order: the reader orders by position, then by id. */
async function renumber(tx: Tx, order: readonly string[]): Promise<void> {
  for (const [position, id] of order.entries())
    await tx.chatDocumentSection.update({ where: { id }, data: { position } })
}

async function orderedSections(tx: Tx, documentId: string) {
  return tx.chatDocumentSection.findMany({
    where: { documentId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  })
}

/** The ids in order with `id` put after the section `after` (`null` — first). */
function placed(
  sections: readonly { id: string; sectionKey: string }[],
  id: string,
  after: string | null,
): string[] {
  const rest = sections.filter((each) => each.id !== id)
  if (after === null) return [id, ...rest.map((each) => each.id)]
  const index = rest.findIndex((each) => each.sectionKey === after)
  if (index === -1) throw docSectionUnknown(after)
  const ids = rest.map((each) => each.id)
  return [...ids.slice(0, index + 1), id, ...ids.slice(index + 1)]
}

export interface DocSectionWrite {
  workspaceId: string
  documentId: string
  key: string
  heading: string
  markdown: string
  /** A new section after this key (`null` — first); absent — the section must exist. */
  after?: string | null
  taskId: string
  turnNo: number
}

/**
 * `doc_section_write` (Ст21): the section replaced whole, unchecked until the end of the turn
 * (Ст19). The document as a whole stays under `pageLimits.docBytes`. A section inserted here
 * gets a neutral intent — never the heading, which is unchecked text and would outlive a refusal.
 */
export async function writeDocSection(
  db: Db,
  input: DocSectionWrite,
): Promise<{ revision: number }> {
  return db.$transaction(async (tx) => {
    const document = await lockDocument(tx, input.documentId, input.workspaceId)
    const sections = await orderedSections(tx, document.id)
    const others = sections.filter((section) => section.sectionKey !== input.key)
    const bytes =
      utf8(document.title) +
      utf8(input.heading) +
      utf8(input.markdown) +
      others.reduce((sum, each) => sum + utf8(each.heading ?? '') + utf8(each.markdown ?? ''), 0)
    if (bytes > pageLimits.docBytes) throw docLimitReached('docBytes')
    const written = {
      heading: input.heading,
      markdown: input.markdown,
      state: 'written' satisfies DocSectionState,
      writtenTaskId: input.taskId,
      writtenTurn: input.turnNo,
      checkedTurn: null,
      refusal: null,
    }
    let section = sections.find((each) => each.sectionKey === input.key)
    if (section) {
      await tx.chatDocumentSection.update({ where: { id: section.id }, data: written })
    } else {
      if (input.after === undefined) throw docSectionUnknown(input.key)
      if (sections.length >= pageLimits.docSections) throw docLimitReached('docSections')
      section = await tx.chatDocumentSection.create({
        data: {
          documentId: document.id,
          sectionKey: input.key,
          intent: INSERTED_SECTION_INTENT,
          position: sections.length,
          ...written,
        },
      })
    }
    if (input.after !== undefined)
      await renumber(tx, placed(await orderedSections(tx, document.id), section.id, input.after))
    const updated = await tx.chatDocument.update({
      where: { id: document.id },
      data: { revision: { increment: 1 } },
    })
    return { revision: updated.revision }
  })
}

/** `doc_section_remove`. */
export async function removeDocSection(
  db: Db,
  input: { workspaceId: string; documentId: string; key: string },
): Promise<{ revision: number }> {
  return db.$transaction(async (tx) => {
    const document = await lockDocument(tx, input.documentId, input.workspaceId)
    const sections = await orderedSections(tx, document.id)
    const section = sections.find((each) => each.sectionKey === input.key)
    if (!section) throw docSectionUnknown(input.key)
    await tx.chatDocumentSection.delete({ where: { id: section.id } })
    await renumber(
      tx,
      sections.filter((each) => each.id !== section.id).map((each) => each.id),
    )
    const updated = await tx.chatDocument.update({
      where: { id: document.id },
      data: { revision: { increment: 1 } },
    })
    return { revision: updated.revision }
  })
}

/** `doc_section_move`: after `after`, `null` — first. */
export async function moveDocSection(
  db: Db,
  input: { workspaceId: string; documentId: string; key: string; after: string | null },
): Promise<{ revision: number }> {
  return db.$transaction(async (tx) => {
    const document = await lockDocument(tx, input.documentId, input.workspaceId)
    const sections = await orderedSections(tx, document.id)
    const section = sections.find((each) => each.sectionKey === input.key)
    if (!section) throw docSectionUnknown(input.key)
    await renumber(tx, placed(sections, section.id, input.after))
    const updated = await tx.chatDocument.update({
      where: { id: document.id },
      data: { revision: { increment: 1 } },
    })
    return { revision: updated.revision }
  })
}

export interface ReadDocSection {
  key: string
  /** The client gets the heading only of a checked section: it is text of the agent too. */
  heading: string | null
  intent: string
  state: DocSectionState
  /** The agent reads what it wrote; the cabinet — only what core checked (Ст19). */
  markdown: string | null
  checked: boolean
  refusal: PageRefusalReason | null
}

/**
 * `doc_read` for the agent (`reader: 'agent'`) and the card of the cabinet (`'client'`): the
 * client gets no heading and no text of a section core has not checked yet.
 */
export async function readChatDocument(
  db: Pick<PrismaClient, 'chatDocument'>,
  input: { workspaceId: string; documentId: string; reader: 'agent' | 'client' },
) {
  const document = await db.chatDocument.findUnique({
    where: { id: input.documentId },
    include: {
      sections: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      page: { select: { id: true, slug: true, state: true, currentVersion: true } },
    },
  })
  if (!document || document.workspaceId !== input.workspaceId) throw docNotFound()
  return {
    id: document.id,
    title: document.title,
    revision: document.revision,
    version: document.currentVersion,
    taskId: document.taskId,
    page: document.page,
    sections: document.sections.map((section): ReadDocSection => {
      const shown = input.reader === 'agent' || section.checkedTurn !== null
      return {
        key: section.sectionKey,
        heading: shown ? section.heading : null,
        intent: section.intent,
        state: section.state as DocSectionState,
        checked: section.checkedTurn !== null,
        refusal: section.refusal as PageRefusalReason | null,
        markdown: shown ? section.markdown : null,
      }
    }),
  }
}

/** `doc_finish` (Ст19, Ст21): refused while a section is pending; done at the end of the turn. */
export async function requestDocFinish(
  db: Db,
  input: { workspaceId: string; documentId: string; taskId: string; turnNo: number },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const document = await lockDocument(tx, input.documentId, input.workspaceId)
    const pending = await tx.chatDocumentSection.count({
      where: { documentId: document.id, state: 'pending' },
    })
    if (pending > 0) throw docPendingSections(pending)
    await tx.chatDocument.update({
      where: { id: document.id },
      data: { finishTaskId: input.taskId, finishTurnNo: input.turnNo },
    })
  })
}

/**
 * The sections of a chat core has not checked yet, up to this turn: a turn that failed before
 * its end leaves its sections to the end of the next one (Ст19). Each with its digest, which
 * the verdict hands back.
 */
export async function uncheckedSectionsOfTurn(
  db: Pick<PrismaClient, 'chatDocumentSection'>,
  taskId: string,
  turnNo: number,
) {
  const sections = await db.chatDocumentSection.findMany({
    where: {
      writtenTaskId: taskId,
      writtenTurn: { lte: turnNo },
      checkedTurn: null,
      state: 'written',
    },
    select: { id: true, documentId: true, sectionKey: true, heading: true, markdown: true },
  })
  return sections.map((section) => ({
    ...section,
    digest: sectionDigest(section.heading, section.markdown),
  }))
}

export interface TurnSectionsVerdict {
  taskId: string
  turnNo: number
  /**
   * Every section core scanned, by the digest it scanned: `refusal` null — it passed. A section
   * not named here, or written again since its scan, stays unchecked.
   */
  sections: readonly { sectionId: string; digest: string; refusal: PageRefusalReason | null }[]
}

export interface SettledDocument {
  documentId: string
  /** Sections sent back to pending. */
  refused: number
  revision: number
  /** The version this end of turn made, or null. */
  version: number | null
}

/**
 * The end of a turn (Ст19): the scanned sections become visible or pending again; then every
 * document with a `doc_finish` waiting becomes its next version once all its sections are
 * written and checked. A `doc_finish` of this chat that a refusal broke is dropped — the agent
 * hears of it in `feed.doc_left`; one that waits for another chat's sections stays for that
 * chat's end of turn.
 */
export async function settleTurnSections(
  db: Db,
  verdict: TurnSectionsVerdict,
): Promise<SettledDocument[]> {
  return db.$transaction(async (tx) => {
    const scanned = await tx.chatDocumentSection.findMany({
      where: { id: { in: verdict.sections.map((each) => each.sectionId) } },
      select: { documentId: true },
    })
    const finishing = await tx.chatDocument.findMany({
      where: { finishTaskId: verdict.taskId },
      select: { id: true },
    })
    const documentIds = [
      ...new Set([...scanned.map((each) => each.documentId), ...finishing.map((each) => each.id)]),
    ].sort()
    const verdictOf = new Map(verdict.sections.map((each) => [each.sectionId, each]))
    const out: SettledDocument[] = []
    for (const documentId of documentIds) {
      const head = await tx.chatDocument.findUniqueOrThrow({ where: { id: documentId } })
      const document = await lockDocument(tx, documentId, head.workspaceId)
      let refused = 0
      let changed = false
      for (const section of await orderedSections(tx, documentId)) {
        const said = verdictOf.get(section.id)
        if (
          said === undefined ||
          section.state !== 'written' ||
          section.checkedTurn !== null ||
          section.writtenTaskId !== verdict.taskId ||
          sectionDigest(section.heading, section.markdown) !== said.digest
        )
          continue
        changed = true
        if (said.refusal !== null) {
          refused += 1
          await tx.chatDocumentSection.update({
            where: { id: section.id },
            data: {
              state: 'pending',
              heading: null,
              markdown: null,
              writtenTaskId: null,
              writtenTurn: null,
              checkedTurn: null,
              refusal: said.refusal,
            },
          })
        } else {
          await tx.chatDocumentSection.update({
            where: { id: section.id },
            data: { checkedTurn: section.writtenTurn },
          })
        }
      }
      let version: number | null = null
      let dropFinish = false
      if (document.finishTaskId !== null) {
        const all = await orderedSections(tx, documentId)
        if (all.every((each) => each.state === 'written' && each.checkedTurn !== null)) {
          const markdown = assembleDocMarkdown({
            title: document.title,
            sections: all.map((each) => ({
              key: each.sectionKey,
              heading: each.heading,
              markdown: each.markdown,
              intent: each.intent,
              state: each.state as DocSectionState,
            })),
          })
          version = document.currentVersion + 1
          await tx.chatDocumentVersion.create({
            data: {
              documentId,
              no: version,
              sizeBytes: utf8(markdown),
              sha256: sha256(markdown),
              taskId: document.finishTaskId,
              turnNo: document.finishTurnNo,
            },
          })
          await tx.chatDocumentContent.upsert({
            where: { documentId },
            create: { documentId, versionNo: version, markdown },
            update: { versionNo: version, markdown },
          })
          dropFinish = true
        } else if (
          document.finishTaskId === verdict.taskId &&
          all.some((each) => each.state === 'pending')
        ) {
          dropFinish = true
        }
      }
      if (!changed && version === null && !dropFinish) continue
      const updated = await tx.chatDocument.update({
        where: { id: documentId },
        data: {
          revision: { increment: 1 },
          ...(version !== null ? { currentVersion: version } : {}),
          ...(dropFinish ? { finishTaskId: null, finishTurnNo: null } : {}),
        },
      })
      out.push({ documentId, refused, revision: updated.revision, version })
    }
    return out
  })
}

/** «Скачать .md» and the page of a document: the Markdown of its current version. */
export async function currentDocMarkdown(
  db: Pick<PrismaClient, 'chatDocument'>,
  input: { workspaceId: string; documentId: string },
): Promise<{ version: number; markdown: string } | null> {
  const document = await db.chatDocument.findUnique({
    where: { id: input.documentId },
    select: { workspaceId: true, content: { select: { versionNo: true, markdown: true } } },
  })
  if (!document || document.workspaceId !== input.workspaceId) throw docNotFound()
  return document.content
    ? { version: document.content.versionNo, markdown: document.content.markdown }
    : null
}
