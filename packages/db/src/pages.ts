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
  pageDeleted,
  pageLimitReached,
  pageForbidden,
  pageHasChildren,
  pagePathSchema,
  pagePathTaken,
  pageSegmentSchema,
  checkPageFile,
  pageCustomNamesAllowed,
  pageFilePathSchema,
  pageNameSchema,
  pageSiteLimitReached,
  pageSitesLimit,
  parentPagePath,
  liveSubscriptionStatuses,
  pageNotFound,
  pageTakenDownByOperator,
  pageVersionChanged,
  type DocSectionState,
  type DocView,
  type PageKind,
  type PageRefusalReason,
} from '@repo/domain'

import { insertFeedEvent } from './feed-events.ts'
import { Prisma, type PrismaClient } from './generated/prisma/client.ts'

// The pages and documents of a workspace (docs/plan/69-pages.md, Ст6, Ст7, Ст13–Ст16, Ст19–Ст21).
// A page is a node of a site (docs/plan/73-pages-sites.md, Дер11, Дер12): the site holds the slug
// for ever, the page its path and the bytes of its current version alone; a document has its
// sections, the Markdown of its current version, and the history of both as numbers and sums.
// Every change takes the row lock of its page or document first, so that concurrent turns and the
// cabinet count versions and positions one at a time; the counts of a workspace take its row with
// FOR NO KEY UPDATE, which leaves the inserts that only reference it alone.

type Db = Pick<PrismaClient, '$transaction'>
type Tx = Prisma.TransactionClient

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const utf8 = (text: string) => Buffer.byteLength(text, 'utf8')

/** What a refused title and intent of a document become (Ст19): nothing of the agent's text. */
export const NEUTRAL_TITLE = 'Документ'
export const NEUTRAL_INTENT = 'Раздел'

/** The workspace of a chat, as a list for `in`: none — the chat is gone. */
async function workspacesOf(tx: Tx, taskId: string): Promise<string[]> {
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { workspaceId: true } })
  return task ? [task.workspaceId] : []
}

/** Whether a turn of a chat ended: the chat is past it, or no pass of it is running. */
async function turnEnded(tx: Tx, taskId: string, turnNo: number): Promise<boolean> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { turnNo: true, status: true },
  })
  if (!task) return true
  return task.turnNo > turnNo || !['preparing', 'running'].includes(task.status)
}

/** The placeholder of a section the agent inserted without saying what it is for. */
export const INSERTED_SECTION_INTENT = 'Новый раздел'

/**
 * What a section said when core scanned it: the heading and the text, as one sum. A write after
 * the scan changes it, and then the section is not marked checked (Ст19).
 */
export const sectionDigest = (heading: string | null, markdown: string | null): string =>
  sha256(`${heading ?? ''}\u0000${markdown ?? ''}`)

/**
 * A page under its row lock, with its site (docs/plan/73-pages-sites.md, Дер11). The site first,
 * then the page: every change of a site's pages — a version, a move, a deletion, a new page — goes
 * workspace → site → page, so no two of them wait on each other in opposite orders. FOR NO KEY
 * UPDATE: a new page under it, or a reservation of it, only takes KEY SHARE and is not held up.
 */
async function lockPage(tx: Tx, pageId: string, workspaceId?: string) {
  const tree = await tx.page.findUnique({ where: { id: pageId }, select: { treeId: true } })
  if (!tree) throw pageNotFound()
  await tx.$queryRaw`SELECT id FROM page_trees WHERE id = ${tree.treeId}::uuid FOR NO KEY UPDATE`
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM pages WHERE id = ${pageId}::uuid FOR NO KEY UPDATE`
  if (rows.length === 0) throw pageNotFound()
  const page = await tx.page.findUniqueOrThrow({ where: { id: pageId }, include: { tree: true } })
  if (workspaceId !== undefined && page.workspaceId !== workspaceId) throw pageNotFound()
  return page
}

type LockedPage = Awaited<ReturnType<typeof lockPage>>

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

/**
 * The publications of a workspace in the hour before `now` (`publishesPerHour`): the turns'
 * reservations and the client's own versions (`turn_no` NULL — a version of a turn is counted by
 * its reservation). The agent and the client share the one budget.
 */
async function publishesOfLastHour(tx: Tx, workspaceId: string, now: Date): Promise<number> {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const reserved = await tx.pageReservation.count({
    where: { createdAt: { gt: hourAgo }, page: { workspaceId } },
  })
  const own = await tx.pageVersion.count({
    where: {
      createdAt: { gt: hourAgo },
      turnNo: null,
      source: { in: ['file', 'doc'] },
      page: { workspaceId },
    },
  })
  return reserved + own
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

/**
 * Where a new page goes (docs/plan/73-pages-sites.md, Дер11, Дер12): a new site of one home
 * page, or a page of an existing site at a path under a page that is there.
 */
export type PagePlace = { treeId: string; path: string }

export interface PagePublicationInput {
  workspaceId: string
  taskId: string
  turnNo: number
  title: string
  target: PagePublicationTarget
  /** A new version of this page; absent — a new page (or the page of the document). */
  pageId?: string
  /** A new page in this site at this path; absent — a new site. */
  place?: PagePlace
  /** With `pageId`: the version the agent read (Дер25); another one since — refused. */
  expectedVersion?: number
}

export interface PagePublication {
  pageId: string
  /** The host of its site. */
  slug: string
  /** Its path in the site: `/` for a home page. */
  path: string
  treeId: string
  /** The number the version gets when the end of the turn makes it (Ст16). */
  version: number
}

/** The label of a site's host as it is shown: its own name, else its slug (Дер32). */
const hostOf = (tree: { slug: string; name: string | null }) => tree.name ?? tree.slug

const publicationOf = (page: LockedPage): PagePublication => ({
  pageId: page.id,
  slug: hostOf(page.tree),
  path: page.path,
  treeId: page.treeId,
  version: page.currentVersion + 1,
})

/**
 * The sites of a workspace that count against its tariff (Дер36): those whose home is out of the
 * trash and published, or waits for a publication of a turn under way. A home a turn left without
 * a version counts no more, though the sweep has not removed it yet.
 */
function liveSitesOf(tx: Tx, workspaceId: string) {
  return tx.pageTree.count({
    where: {
      workspaceId,
      pages: {
        some: {
          parentId: null,
          deletedAt: null,
          OR: [{ state: { not: 'pending' } }, { reservations: { some: { outcome: null } } }],
        },
      },
    },
  })
}

/** The limit of sites of the tariff the workspace pays for (Дер36); one without a paid tariff. */
async function siteLimitOf(tx: Tx, workspaceId: string): Promise<number> {
  const live = await tx.subscription.findFirst({
    where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
    select: { plan: { select: { pageSites: true } } },
  })
  return pageSitesLimit(live ? live.plan : null)
}

/** The site of a workspace under its row lock; NOT_FOUND for another's (Ст20). */
async function lockTree(tx: Tx, treeId: string, workspaceId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM page_trees WHERE id = ${treeId}::uuid FOR NO KEY UPDATE`
  if (rows.length === 0) throw pageNotFound()
  const tree = await tx.pageTree.findUniqueOrThrow({ where: { id: treeId } })
  if (tree.workspaceId !== workspaceId) throw pageNotFound()
  return tree
}

interface NewNode {
  workspaceId: string
  taskId: string | null
  turnNo: number | null
  kind: PageKind
  title: string
  documentId: string | null
  fileName: string | null
  place?: PagePlace | undefined
}

/**
 * A new page, in the caller's transaction under the workspace's row lock: a new site of one home
 * page under the limit of the tariff (Дер36), or a page of a site at a free path under a page
 * that is there (Дер15) within `pagesPerTree`. The page counts against `pagesPerWorkspace` once it
 * has a version, as before; a new page takes the path a redirect had (Дер19).
 */
async function createNode(tx: Tx, input: NewNode): Promise<LockedPage> {
  const data = {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    turnNo: input.turnNo,
    kind: input.kind,
    title: input.title,
    documentId: input.documentId,
    sourceFileName: input.fileName,
  }
  const pages = await tx.page.count({
    where: { workspaceId: input.workspaceId, state: { not: 'pending' }, deletedAt: null },
  })
  if (pages >= pageLimits.pagesPerWorkspace) throw pageLimitReached('pagesPerWorkspace')
  if (input.place === undefined) {
    const limit = await siteLimitOf(tx, input.workspaceId)
    if ((await liveSitesOf(tx, input.workspaceId)) >= limit) throw pageSiteLimitReached(limit)
    const tree = await tx.pageTree.create({
      data: {
        workspaceId: input.workspaceId,
        slug: newPageSlug((size) => randomBytes(size)),
        createdTaskId: input.taskId,
      },
    })
    const home = await tx.page.create({ data: { ...data, treeId: tree.id, path: '/' } })
    return lockPage(tx, home.id, input.workspaceId)
  }
  const { treeId, path } = input.place
  if (!pagePathSchema.safeParse(path).success || path === '/')
    throw new DomainError('BAD_REQUEST', 'Give the path of a new page under the home page', 400)
  const tree = await lockTree(tx, treeId, input.workspaceId)
  if (tree.takenDownBy === 'operator') throw pageNotFound()
  const parentPath = parentPagePath(path)!
  const parent = await tx.page.findFirst({
    where: { treeId, path: parentPath, deletedAt: null },
    select: { id: true },
  })
  if (parent === null)
    throw new DomainError('PAGE_PARENT_MISSING', `No page at ${parentPath} in this site`, 409, {
      path: parentPath,
    })
  if (await tx.page.findFirst({ where: { treeId, path, deletedAt: null }, select: { id: true } }))
    throw pagePathTaken(path)
  const inTree = await tx.page.count({ where: { treeId, deletedAt: null } })
  if (inTree >= pageLimits.pagesPerTree) throw pageLimitReached('pagesPerTree')
  const siblings = await tx.page.count({ where: { treeId, parentId: parent.id, deletedAt: null } })
  await tx.pageRedirect.deleteMany({ where: { treeId, fromPath: path } })
  const node = await tx.page.create({
    data: {
      ...data,
      treeId,
      parentId: parent.id,
      segment: path.slice(path.lastIndexOf('/') + 1),
      path,
      position: siblings,
    },
  })
  return lockPage(tx, node.id, input.workspaceId)
}

const kindOf = (documentId: string | null, fileName: string | null): PageKind =>
  documentId !== null ? 'doc' : /\.(md|markdown)$/i.test(fileName ?? '') ? 'markdown' : 'html'

/** Taken down — the node, or the whole site — and by whom; null — it serves. */
const takenDownOf = (page: LockedPage): 'client' | 'operator' | null =>
  page.tree.takenDownBy === 'operator' || page.takenDownBy === 'operator'
    ? 'operator'
    : ((page.tree.takenDownBy ?? page.takenDownBy) as 'client' | null)

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
      select: { pageId: true, kind: true },
    })
    // The file went to the site as a shared file in this turn: it is no page.
    if (known && known.kind !== 'version') throw pageReservedOtherwise()
    if (known) {
      const page = await lockPage(tx, known.pageId)
      if (page.workspaceId !== workspaceId) throw pageNotFound()
      // The same call again is the same reservation; the same file for another page is not.
      if (input.pageId !== undefined && input.pageId !== known.pageId) throw pageReservedOtherwise()
      return publicationOf(page)
    }
    // Two turns cannot both take the last place.
    await lockWorkspaceOfChat(tx, workspaceId, taskId, pageNotFound)
    if ((await publishesOfLastHour(tx, workspaceId, now)) >= pageLimits.publishesPerHour)
      throw pageLimitReached('publishesPerHour')

    let page = input.pageId ? await lockPage(tx, input.pageId, workspaceId) : null
    // A version of a page taken down would answer 410: the client puts it back, not the agent;
    // one the operator took down is gone for the workspace (Ст15, Ст31).
    const down = page ? takenDownOf(page) : null
    if (down !== null) throw down === 'operator' ? pageNotFound() : pageTakenDown()
    if (
      page !== null &&
      input.expectedVersion !== undefined &&
      page.currentVersion !== input.expectedVersion
    )
      throw pageVersionChanged(page.currentVersion)
    // A page of a document gets its versions from the document, a page of a file from files.
    if (page !== null && (page.documentId === null) !== (documentId === null)) throw pageNotFound()
    if (page !== null && documentId !== null && page.documentId !== documentId) throw pageNotFound()
    if (page === null && documentId !== null) {
      const document = await lockDocument(tx, documentId, workspaceId)
      const known = await tx.page.findUnique({ where: { documentId: document.id } })
      // Under the page's lock, as deletePage takes it: a deletion cannot slip in between.
      page = known ? await lockPage(tx, known.id, workspaceId) : null
    }
    // In the trash: the client returns it, not the agent (docs/plan/73-pages-sites.md, Дер2).
    if (page?.deletedAt) throw pageDeleted(documentId !== null ? 'document' : 'page')
    page ??= await createNode(tx, {
      workspaceId,
      taskId,
      turnNo,
      kind: kindOf(documentId, fileName),
      title,
      documentId,
      fileName,
      place: input.place,
    })
    await tx.pageReservation.create({
      data: { pageId: page.id, taskId, turnNo, fileName, documentId, title },
    })
    return publicationOf(page)
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
    include: {
      page: {
        select: {
          id: true,
          kind: true,
          workspaceId: true,
          path: true,
          tree: { select: { slug: true } },
        },
      },
    },
  })
}

export interface PageVersionInput {
  pageId: string
  /** The workspace the caller acts for: a page of another one is not found (Ст20). */
  workspaceId?: string
  bytes: Uint8Array
  /** The Markdown a page of a `.md` or of a document was drawn from (Дер26); none for HTML. */
  markdown?: Uint8Array | null
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
  return db.$transaction(async (tx) =>
    writeVersion(tx, await lockPage(tx, input.pageId, input.workspaceId), input),
  )
}

/** The next version of a locked page, in the caller's transaction. */
async function writeVersion(
  tx: Tx,
  page: LockedPage,
  input: PageVersionInput,
): Promise<{ version: number }> {
  // No version lands in the trash: the end of a turn tells the client it was left (Дер2).
  if (page.deletedAt) throw pageDeleted()
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
  const markdown = input.markdown ? new Uint8Array(input.markdown) : null
  await tx.pageContent.upsert({
    where: { pageId: page.id },
    create: { pageId: page.id, versionNo: no, bytes, source: markdown },
    update: { versionNo: no, bytes, source: markdown },
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
}

export interface ClientPublicationInput {
  workspaceId: string
  /**
   * The chat the file or the document comes from: where its version was made, never a key of the
   * page — a page belongs to its workspace (docs/plan/73-pages-sites.md, Дер8, Дер9).
   */
  taskId: string | null
  /** The title of a new page; a version keeps the title the page has (none — the page's own). */
  title: string
  target: PagePublicationTarget
  /**
   * A file only: the page it becomes the next version of, and the version the client saw there
   * (`PAGE_VERSION_CHANGED` when another one came since); none — a new page (Дер9).
   */
  into?: { pageId: string; expectedVersion: number }
  /** A file only: a new page of this site at this path; none — a new site (Дер9). */
  place?: PagePlace
  /** What the page serves: HTML of the agent, or drawn by the platform (@repo/doc-render). */
  bytes: Uint8Array
  /** The Markdown it was drawn from (Дер26). */
  markdown?: Uint8Array | null
}

/**
 * «Опубликовать по ссылке» of a document and «Опубликовать как страницу» of a file of a chat
 * (docs/plan/69-pages.md, Ст25, Ст32; docs/plan/73-pages-sites.md, Дер9): the client's own
 * publication, at once, without a turn. The page of the document gets its next version; a file
 * goes where the client said — the next version of the page named, a new page of a site, or a
 * new site, whatever chat or name it came from. One transaction: a page that got no version is
 * never left behind.
 */
export async function publishClientPage(
  db: Db,
  input: ClientPublicationInput,
  now: Date = new Date(),
): Promise<PagePublication> {
  if (input.bytes.byteLength > pageLimits.contentBytes) throw pageLimitReached('contentBytes')
  const fileName = 'fileName' in input.target ? input.target.fileName : null
  const documentId = 'documentId' in input.target ? input.target.documentId : null
  return db.$transaction(async (tx) => {
    // The workspace's row for its counts — two publications cannot both take the last place —
    // and, for a page of a chat, that the chat is the workspace's own.
    if (input.taskId !== null)
      await lockWorkspaceOfChat(tx, input.workspaceId, input.taskId, pageNotFound)
    else {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM workspaces WHERE id = ${input.workspaceId}::uuid FOR NO KEY UPDATE`
      if (rows.length === 0) throw pageNotFound()
    }
    if ((await publishesOfLastHour(tx, input.workspaceId, now)) >= pageLimits.publishesPerHour)
      throw pageLimitReached('publishesPerHour')

    if ((input.into !== undefined || input.place !== undefined) && documentId !== null)
      throw new DomainError('BAD_REQUEST', 'A document has its one page', 400)
    if (input.into !== undefined && input.place !== undefined)
      throw new DomainError('BAD_REQUEST', 'Either a page or a place', 400)
    const known =
      documentId !== null
        ? await tx.page.findUnique({ where: { documentId } })
        : input.into !== undefined
          ? { id: input.into.pageId }
          : null
    let page = known ? await lockPage(tx, known.id, input.workspaceId) : null
    // A file becomes a version of a page of files only: a document's page is the document's.
    if (page !== null && documentId === null && page.documentId !== null) throw pageNotFound()
    // The page of the document is in the trash: the client returns it first (Дер2).
    if (page?.deletedAt) throw pageDeleted()
    // Taken down by the client: they put it back in «Страницы»; by the operator: gone (Ст15, Ст31).
    const down = page ? takenDownOf(page) : null
    if (down !== null) throw down === 'operator' ? pageNotFound() : pageTakenDown()
    // A turn under way reserved it and told the agent the number of its version: that number is
    // the turn's, the client publishes once the answer ends.
    if (
      page !== null &&
      (await tx.pageReservation.count({ where: { pageId: page.id, outcome: null } })) > 0
    )
      throw new DomainError('PAGE_BUSY', 'A turn is publishing this page now', 409)
    // The client chose it at a version: another one came since — theirs to look at first.
    if (
      page !== null &&
      input.into !== undefined &&
      page.currentVersion !== input.into.expectedVersion
    )
      throw pageVersionChanged(page.currentVersion)
    // A pending page the client chose goes live with this version: it counts from now (Ст24).
    if (page !== null && input.into !== undefined && page.state === 'pending') {
      const pages = await tx.page.count({
        where: { workspaceId: input.workspaceId, state: { not: 'pending' }, deletedAt: null },
      })
      if (pages >= pageLimits.pagesPerWorkspace) throw pageLimitReached('pagesPerWorkspace')
    }
    // A .md and a .html serve under different policies: the page takes the kind of its new file,
    // and the name of the file it now shows (the hint of the next publication, Дер9).
    const fileKind = kindOf(null, fileName)
    if (
      page !== null &&
      documentId === null &&
      (page.kind !== fileKind || page.sourceFileName !== fileName)
    ) {
      await tx.page.update({
        where: { id: page.id },
        data: { kind: fileKind, sourceFileName: fileName },
      })
      page = { ...page, kind: fileKind, sourceFileName: fileName }
    }
    if (page === null) {
      if (documentId !== null) await lockDocument(tx, documentId, input.workspaceId)
      page = await createNode(tx, {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        turnNo: null,
        kind: kindOf(documentId, fileName),
        title: input.title,
        documentId,
        fileName,
        place: input.place,
      })
    }
    const { version } = await writeVersion(tx, page, {
      pageId: page.id,
      bytes: input.bytes,
      markdown: input.markdown ?? null,
      source: documentId !== null ? 'doc' : 'file',
      // A version the client chose keeps the title of its page (Дер9): a file name is no title.
      ...(input.into !== undefined ? {} : { title: input.title }),
      taskId: input.taskId,
      turnNo: null,
    })
    return { ...publicationOf(page), version }
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

/**
 * What the page server answers a host and a path with (docs/plan/73-pages-sites.md, Дер16, §5.2),
 * from the database alone (Ст4). The site comes first — its take-down, its trash and its password
 * stand over every path, so a site with a password tells nothing of its paths without the cookie.
 * Then the page at the path, live or in the trash, and the redirect of a former path.
 */
export interface ServedSite {
  treeId: string
  /**
   * The label to send the viewer on to (308): the site's own name when it was asked by its slug
   * or by a name it had before (Дер32); null — the label asked is the site's.
   */
  host: string | null
  /** 410 on every path: the host taken down, or the site in the trash or purged (a tombstone). */
  gone: 'taken_down' | 'deleted' | null
  passwordHash: string | null
  passwordEpoch: number
  /** The page at the path; null — none there. */
  page: ServedNode | null
  /** The path a former one sends on to (Дер19); null — none, or the page there is in the trash. */
  redirect: string | null
}

export interface ServedNode {
  id: string
  state: 'pending' | 'live' | 'taken_down'
  /** In the trash: 410 «Страница удалена». */
  deleted: boolean
  kind: PageKind
  /** The current version; null while pending or in the trash. */
  content: { version: number; bytes: Uint8Array } | null
}

export async function servedPage(
  db: Pick<PrismaClient, 'pageTree'>,
  label: string,
  path = '/',
): Promise<ServedSite | null> {
  // A random slug is 26 letters, a name 3 to 25: one lookup each way (Дер33).
  const tree = await db.pageTree.findFirst({
    where: label.length === 26 ? { slug: label } : { names: { some: { name: label } } },
    select: {
      id: true,
      name: true,
      passwordHash: true,
      passwordEpoch: true,
      takenDownBy: true,
      pages: {
        where: { OR: [{ path }, { parentId: null }] },
        // Live first: a page in the trash at a path a new page took is history.
        orderBy: [{ deletedAt: { sort: 'desc', nulls: 'first' } }],
        select: {
          id: true,
          path: true,
          parentId: true,
          state: true,
          deletedAt: true,
          kind: true,
          content: { select: { versionNo: true, bytes: true } },
        },
      },
      redirects: {
        where: { fromPath: path },
        select: { page: { select: { path: true, deletedAt: true } } },
      },
    },
  })
  if (!tree) return null
  const home = tree.pages.find((page) => page.parentId === null && page.deletedAt === null)
  const atPath = tree.pages.find((page) => page.path === path) ?? null
  const redirect = tree.redirects[0]?.page ?? null
  return {
    treeId: tree.id,
    host: tree.name !== null && tree.name !== label ? tree.name : null,
    gone: tree.takenDownBy !== null ? 'taken_down' : home === undefined ? 'deleted' : null,
    passwordHash: tree.passwordHash,
    passwordEpoch: tree.passwordEpoch,
    page: atPath && {
      id: atPath.id,
      state: atPath.state as ServedNode['state'],
      deleted: atPath.deletedAt !== null,
      kind: atPath.kind as PageKind,
      content:
        atPath.state === 'pending' || atPath.deletedAt !== null || !atPath.content
          ? null
          : { version: atPath.content.versionNo, bytes: atPath.content.bytes },
    },
    redirect:
      redirect && redirect.deletedAt === null && redirect.path !== path ? redirect.path : null,
  }
}

/** The client sets or clears the password of the site of a page (Ст13, Дер17); the cookies of the former one stop. */
export async function setPagePassword(
  db: Db,
  input: { workspaceId: string; pageId: string; passwordHash: string | null },
): Promise<{ passwordEpoch: number }> {
  return db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    if (page.deletedAt) throw pageDeleted()
    const tree = await lockTree(tx, page.treeId, input.workspaceId)
    const updated = await tx.pageTree.update({
      where: { id: tree.id },
      data: { passwordHash: input.passwordHash, passwordEpoch: tree.passwordEpoch + 1 },
    })
    return { passwordEpoch: updated.passwordEpoch }
  })
}

/** Who takes a page down: the client of its workspace, or the operator for any page. */
export type PageTakeDown =
  { pageId: string; by: 'client'; workspaceId: string } | { pageId: string; by: 'operator' }

/**
 * «Снять с публикации» (Ст15, Ст31; Дер18): the home page takes its whole site down — 410 on every
 * path —, another page its own path only. 410 until it is put back; nothing is deleted.
 */
export async function takeDownPage(db: Db, input: PageTakeDown): Promise<void> {
  await db.$transaction(async (tx) => {
    const page = await lockPage(
      tx,
      input.pageId,
      input.by === 'client' ? input.workspaceId : undefined,
    )
    if (page.state === 'pending') throw pageNotFound()
    // The client returns a page from the trash first; the operator takes any page down (Ст31).
    if (page.deletedAt && input.by === 'client') throw pageDeleted()
    const at = new Date()
    if (page.parentId === null) {
      const tree = await lockTree(tx, page.treeId, page.workspaceId)
      // The operator's word stands over the client's: a site the client took down is taken over.
      if (tree.takenDownBy !== null && (input.by === 'client' || tree.takenDownBy === 'operator'))
        return
      await tx.pageTree.update({
        where: { id: tree.id },
        data: { takenDownAt: at, takenDownBy: input.by },
      })
      return
    }
    if (page.state === 'taken_down' && (input.by === 'client' || page.takenDownBy === 'operator'))
      return
    await tx.page.update({
      where: { id: page.id },
      data: { state: 'taken_down', takenDownAt: at, takenDownBy: input.by },
    })
  })
}

/**
 * «Вернуть на публикацию»: the same address, the current version — of the site, for its home
 * page. What the operator took down the client cannot put back.
 */
export async function restorePage(
  db: Db,
  input: { pageId: string; workspaceId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    if (page.deletedAt) throw pageDeleted()
    if (page.parentId === null) {
      const tree = await lockTree(tx, page.treeId, input.workspaceId)
      if (tree.takenDownBy === null) return
      if (tree.takenDownBy === 'operator') throw pageNotFound()
      await tx.pageTree.update({
        where: { id: tree.id },
        data: { takenDownAt: null, takenDownBy: null },
      })
      // A site moved over from a page of its own (migration 20261114110000) has it on the page too.
      if (page.state === 'taken_down' && page.takenDownBy !== 'operator')
        await tx.page.update({
          where: { id: page.id },
          data: { state: 'live', takenDownAt: null, takenDownBy: null },
        })
      return
    }
    if (page.state !== 'taken_down') return
    if (page.takenDownBy === 'operator') throw pageNotFound()
    await tx.page.update({
      where: { id: page.id },
      data: { state: 'live', takenDownAt: null, takenDownBy: null },
    })
  })
}

/**
 * The pages of a workspace for its section «Страницы» and for `page_list` (Ст20, Ст30): every
 * node with its site — its host, whether a password is set, never its hash: the list goes to the
 * cabinet and to the model. A home page answers for its site: the take-down of the host is its.
 */
export async function listWorkspacePages(db: Pick<PrismaClient, 'page'>, workspaceId: string) {
  const pages = await db.page.findMany({
    where: { workspaceId },
    orderBy: [{ updatedAt: 'desc' }],
    select: {
      id: true,
      treeId: true,
      parentId: true,
      path: true,
      position: true,
      title: true,
      kind: true,
      state: true,
      currentVersion: true,
      taskId: true,
      documentId: true,
      takenDownBy: true,
      deletedAt: true,
      purgeAfter: true,
      sourceFileName: true,
      updatedAt: true,
      tree: { select: { slug: true, name: true, passwordHash: true, takenDownBy: true } },
    },
  })
  return pages.map(({ tree, ...page }) => {
    const hostDown = page.parentId === null ? tree.takenDownBy : null
    return {
      ...page,
      /** The label of its address: the site's own name, else its slug (Дер32). */
      slug: hostOf(tree),
      name: tree.name,
      hasPassword: tree.passwordHash !== null,
      state: hostDown !== null ? 'taken_down' : page.state,
      takenDownBy: hostDown ?? page.takenDownBy,
      /** The host itself is taken down: every path of the site answers 410. */
      siteTakenDown: tree.takenDownBy !== null,
    }
  })
}

// ———————————————————————————————————————— the trash

/** Who did what to a page, for `audit_log` (docs/plan/73-pages-sites.md, Дер4): never its content. */
export type PageActor =
  | { type: 'user'; userId: string }
  | { type: 'agent'; taskId: string }
  | { type: 'system'; service: string }

function pageAudit(
  tx: Tx,
  actor: PageActor,
  action: 'pages.delete' | 'pages.return' | 'pages.purge',
  page: { id: string; workspaceId: string; path: string; tree: { slug: string } },
  pages: number,
) {
  return tx.auditLog.create({
    data: {
      actorType: actor.type,
      actorId:
        actor.type === 'user'
          ? actor.userId
          : actor.type === 'agent'
            ? actor.taskId
            : actor.service,
      workspaceId: page.workspaceId,
      action,
      targetType: 'page',
      targetId: page.id,
      meta: { slug: page.tree.slug, path: page.path, pages },
    },
  })
}

/** Whether `path` is `ancestor` or a page below it. */
const isWithin = (path: string, ancestor: string): boolean =>
  ancestor === '/' || path === ancestor || path.startsWith(`${ancestor}/`)

/** The branch of a page — itself and every page below it — of the rows `where` names. */
const branchOf = (page: { treeId: string; path: string }) => ({
  treeId: page.treeId,
  OR:
    page.path === '/'
      ? [{ path: { startsWith: '/' } }]
      : [{ path: page.path }, { path: { startsWith: `${page.path}/` } }],
})

/**
 * A turn publishes a file as a page of the branch: its version is the turn's until the turn ends
 * (as publishClientPage), and the sweep closes it a day on at most. A publication of a document
 * waits for the document however long — that one the deletion closes itself (closeDocumentWaits).
 */
async function refuseBusy(tx: Tx, pageIds: readonly string[]): Promise<void> {
  const busy = await tx.pageReservation.count({
    where: { pageId: { in: [...pageIds] }, outcome: null, fileName: { not: null } },
  })
  if (busy > 0) throw new DomainError('PAGE_BUSY', 'A turn is publishing this page now', 409)
}

/** The publications of a document waiting for it: told `failed` in their chats, as the end of a turn tells it. */
async function closeDocumentWaits(tx: Tx, pageIds: readonly string[], now: Date): Promise<void> {
  const open = await tx.pageReservation.findMany({
    where: { pageId: { in: [...pageIds] }, outcome: null, documentId: { not: null } },
    select: { id: true, taskId: true, pageId: true },
  })
  for (const reservation of open) {
    await tx.pageReservation.update({
      where: { id: reservation.id },
      data: { outcome: 'failed', settledAt: now },
    })
    await insertFeedEvent(tx, {
      taskId: reservation.taskId,
      turnId: null,
      row: {
        type: 'feed.page_left',
        payload: { v: 1, pageId: reservation.pageId, reason: 'failed' },
      },
    })
  }
}

/** What the support took down — the page, a page of the branch, or the site of a home page — stays (Ст31). */
async function refuseOperators(
  tx: Tx,
  page: LockedPage,
  branch: readonly { takenDownBy: string | null }[],
) {
  if (
    (page.parentId === null && page.tree.takenDownBy === 'operator') ||
    branch.some((each) => each.takenDownBy === 'operator')
  )
    throw pageTakenDownByOperator()
}

/**
 * «Удалить» (docs/plan/73-pages-sites.md, Дер1–Дер4): the page goes to the trash for
 * `trashDays` with every page below it — the home page with its whole site; their addresses
 * answer 410 «Страница удалена» at once, their versions and bytes stay until they are returned or
 * purged. The support's take-down is not undone by a deletion (Ст31). Deleting a page in the
 * trash again changes nothing.
 */
export async function deletePage(
  db: Db,
  input: { pageId: string; workspaceId: string; by: 'client' | 'agent'; actor: PageActor },
  now: Date = new Date(),
): Promise<{ purgeAfter: Date; pages: number }> {
  return db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    return deleteInTx(tx, page, { by: input.by, actor: input.actor, now })
  })
}

/** A deletion in the caller's transaction, under the lock of the page. */
async function deleteInTx(
  tx: Tx,
  page: LockedPage,
  input: {
    by: 'client' | 'agent'
    actor: PageActor
    now: Date
    /** A turn's deletion: the pages it counted and whether the client asked for those below. */
    asked?: { pages: number; withChildren: boolean }
  },
): Promise<{ purgeAfter: Date; pages: number }> {
  if (page.deletedAt && page.purgeAfter) return { purgeAfter: page.purgeAfter, pages: 0 }
  await lockTree(tx, page.treeId, page.workspaceId)
  const branch = await tx.page.findMany({
    where: { ...branchOf(page), deletedAt: null },
    select: { id: true, takenDownBy: true },
  })
  if (input.asked) {
    if (branch.length > 1 && !input.asked.withChildren) throw pageHasChildren()
    if (branch.length > input.asked.pages) throw pageBranchChanged()
  }
  await refuseOperators(tx, page, branch)
  const ids = branch.map((each) => each.id)
  await refuseBusy(tx, ids)
  await closeDocumentWaits(tx, ids, input.now)
  const purgeAfter = new Date(input.now.getTime() + pageLimits.trashDays * 24 * 60 * 60 * 1000)
  await tx.page.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: input.now, deletedBy: input.by, purgeAfter },
  })
  await pageAudit(tx, input.actor, 'pages.delete', page, ids.length)
  return { purgeAfter, pages: ids.length }
}

/**
 * «Вернуть» from the trash: the page and the pages deleted with it, at their paths and versions
 * as they were (a page the client took down stays taken down). Its parent must be out of the
 * trash and its paths free, and it counts against the limits again — of the workspace, of the
 * site, and for a home page of the tariff's sites.
 */
export async function returnDeletedPage(
  db: Db,
  input: { pageId: string; workspaceId: string; actor: PageActor },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockWorkspace(tx, input.workspaceId)
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    await returnInTx(tx, page, input.workspaceId, input.actor)
  })
}

/** The workspace's row for its counts, taken before any page of it. */
async function lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`
  if (rows.length === 0) throw pageNotFound()
}

/** A return in the caller's transaction, the workspace locked first; how many pages came back. */
async function returnInTx(
  tx: Tx,
  page: LockedPage,
  workspaceId: string,
  actor: PageActor,
): Promise<number> {
  const input = { workspaceId, actor }
  {
    if (!page.deletedAt) return 0
    await lockTree(tx, page.treeId, input.workspaceId)
    const stored = await tx.page.findMany({
      where: { ...branchOf(page), deletedAt: page.deletedAt },
      select: { id: true, path: true, state: true },
    })
    // Its parent may have moved while it lay in the trash: it comes back under the parent where
    // the parent is now, with the paths of its branch rebased.
    let base = page.path
    if (page.parentId !== null) {
      const parent = await tx.page.findUniqueOrThrow({
        where: { id: page.parentId },
        select: { deletedAt: true, path: true },
      })
      if (parent.deletedAt !== null)
        throw new DomainError('PAGE_PARENT_DELETED', 'Return the page above it first', 409)
      base = childPath(parent.path, page.segment!)
    }
    const branch = stored.map((each) => ({
      ...each,
      from: each.path,
      path: base + each.path.slice(page.path.length),
    }))
    for (const each of branch)
      if (!pagePathSchema.safeParse(each.path).success)
        throw new DomainError('PAGE_PATH_TOO_DEEP', 'The pages would go too deep', 400)
    if (page.parentId === null) {
      const limit = await siteLimitOf(tx, input.workspaceId)
      if ((await liveSitesOf(tx, input.workspaceId)) >= limit) throw pageSiteLimitReached(limit)
    }
    const taken = await tx.page.findFirst({
      where: {
        treeId: page.treeId,
        deletedAt: null,
        path: { in: branch.map((each) => each.path) },
      },
      select: { path: true },
    })
    if (taken) throw pagePathTaken(taken.path)
    const published = branch.filter((each) => each.state !== 'pending').length
    const pages = await tx.page.count({
      where: { workspaceId: input.workspaceId, state: { not: 'pending' }, deletedAt: null },
    })
    if (pages + published > pageLimits.pagesPerWorkspace)
      throw pageLimitReached('pagesPerWorkspace')
    const inTree = await tx.page.count({ where: { treeId: page.treeId, deletedAt: null } })
    if (inTree + branch.length > pageLimits.pagesPerTree) throw pageLimitReached('pagesPerTree')
    await tx.pageRedirect.deleteMany({
      where: { treeId: page.treeId, fromPath: { in: branch.map((each) => each.path) } },
    })
    // Rebased while still in the trash: the unique path of live pages sees only where they land;
    // the path it had leads to it, as the move of its parent made every live path of it lead on.
    for (const each of branch.filter((row) => row.path !== row.from)) {
      await tx.page.update({ where: { id: each.id }, data: { path: each.path } })
      await tx.pageRedirect.upsert({
        where: { treeId_fromPath: { treeId: page.treeId, fromPath: each.from } },
        create: { treeId: page.treeId, fromPath: each.from, pageId: each.id },
        update: { pageId: each.id, createdAt: new Date() },
      })
    }
    await tx.page.updateMany({
      where: { id: { in: branch.map((each) => each.id) } },
      data: { deletedAt: null, deletedBy: null, purgeAfter: null },
    })
    await pageAudit(tx, input.actor, 'pages.return', page, branch.length)
    return branch.length
  }
}

/** The pages in the trash deleted with this one (below it, or the whole site of a home page). */
function trashedBranch(tx: Tx, page: LockedPage) {
  return tx.page.findMany({
    where: { ...branchOf(page), deletedAt: { not: null } },
    select: { id: true, takenDownBy: true, deletedAt: true },
  })
}

/**
 * Removes pages of one site, versions and bytes with them; the row of the site stays a tombstone.
 * A site left without a page loses its shared files too: a purge removes the bytes (Дер2).
 */
async function purgeRows(tx: Tx, treeId: string, ids: readonly string[]): Promise<void> {
  await tx.page.deleteMany({ where: { id: { in: [...ids] } } })
  if ((await tx.page.count({ where: { treeId } })) === 0)
    await tx.pageFile.deleteMany({ where: { treeId } })
}

/**
 * «Удалить навсегда»: a page in the trash and the pages below it — versions, bytes, reservations —
 * now. Their addresses answer 404 then, like any that never were; a home page's site keeps its
 * row as the tombstone of its slug, 410 on every path for ever (Дер2). A page that is not in the
 * trash is not purged, nor one the support took down (Ст31).
 */
export async function purgeDeletedPage(
  db: Db,
  input: { pageId: string; workspaceId: string; actor: PageActor },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    if (!page.deletedAt) throw new DomainError('PAGE_NOT_DELETED', 'Delete the page first', 409)
    await lockTree(tx, page.treeId, input.workspaceId)
    const branch = await trashedBranch(tx, page)
    await refuseOperators(tx, page, branch)
    const ids = branch.map((each) => each.id)
    await refuseBusy(tx, ids)
    await pageAudit(tx, input.actor, 'pages.purge', page, ids.length)
    await purgeRows(tx, page.treeId, ids)
  })
}

/**
 * The sweep of core: the pages whose time in the trash is over, each branch with the page it was
 * deleted with, in its own transaction under the lock of its site, so a branch returned meanwhile
 * stays. What the support took down stays for them (Ст31). Returns how many pages went.
 */
export async function purgeExpiredPages(
  db: Pick<PrismaClient, '$transaction' | 'page'>,
  now: Date = new Date(),
  limit = 100,
): Promise<number> {
  const due = await db.page.findMany({
    where: { purgeAfter: { lte: now } },
    orderBy: [{ purgeAfter: 'asc' }, { path: 'asc' }],
    take: limit,
    select: { id: true, treeId: true },
  })
  let purged = 0
  for (const treeId of new Set(due.map((each) => each.treeId))) {
    purged += await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; taken_down_by: string | null }[]>`
        SELECT id, taken_down_by FROM page_trees WHERE id = ${treeId}::uuid FOR NO KEY UPDATE SKIP LOCKED`
      if (rows.length === 0) return 0
      const pages = await tx.page.findMany({
        where: { treeId, purgeAfter: { lte: now } },
        select: { id: true, parentId: true, path: true, takenDownBy: true, workspaceId: true },
      })
      // The support's word stands: what they took down waits for them — with the pages above it.
      const kept = pages.filter(
        (each) =>
          each.takenDownBy === 'operator' ||
          (each.parentId === null && rows[0]!.taken_down_by === 'operator'),
      )
      const busy = await tx.pageReservation.findMany({
        where: {
          pageId: { in: pages.map((each) => each.id) },
          outcome: null,
          fileName: { not: null },
        },
        select: { pageId: true },
      })
      // A page stays while something below it stays: a purge never leaves a page without its parent.
      const staying = [
        ...kept.map((each) => each.path),
        ...pages
          .filter((each) => busy.some((row) => row.pageId === each.id))
          .map((each) => each.path),
      ]
      // The home page held: the site keeps every page deleted with it, to be returned whole.
      const wholeSite = kept.some((each) => each.parentId === null)
      const gone = wholeSite
        ? []
        : pages.filter((each) => !staying.some((path) => isWithin(path, each.path)))
      if (gone.length === 0) return 0
      const tree = await tx.pageTree.findUniqueOrThrow({
        where: { id: treeId },
        select: { slug: true },
      })
      for (const page of gone.filter((each) => !gone.some((other) => each.parentId === other.id)))
        await pageAudit(
          tx,
          { type: 'system', service: 'core' },
          'pages.purge',
          { ...page, tree },
          1,
        )
      await purgeRows(
        tx,
        treeId,
        gone.map((each) => each.id),
      )
      return gone.length
    })
  }
  return purged
}

// ———————————————————————————————————————— changes of the tree (docs/plan/73-pages-sites.md)

/** A search and replace in the text of a page (Дер23): `old` must be found once, or every time with `all`. */
export interface PageEdit {
  old: string
  new: string
  all?: boolean
}

/** What a turn asks of a page besides a version (Дер23–Дер27). */
export type PageChange =
  | { kind: 'edit'; pageId: string; expectedVersion: number; edits: PageEdit[] }
  | {
      kind: 'update'
      pageId: string
      expectedVersion: number
      title?: string
      segment?: string
      parentId?: string
      position?: number
    }
  | { kind: 'delete'; pageId: string; withChildren: boolean }
  | { kind: 'restore'; pageId: string }

/** At most this many pages a turn moves to the trash (rule 4, Дер27). */
export const AGENT_DELETES_PER_TURN = 20

/**
 * Whether the author of a chat is now an owner or an administrator of the workspace (Дер24): who
 * the changes its agent asks of the pages — and of the scheduled tasks (docs/plan/82-scheduled-
 * tasks.md, Зп25) — are allowed to.
 */
export async function chatAuthorManages(
  tx: Pick<Tx, 'task' | 'member'>,
  taskId: string,
  workspaceId: string,
): Promise<boolean> {
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { createdById: true } })
  if (!task?.createdById) return false
  const member = await tx.member.findFirst({
    where: { workspaceId, userId: task.createdById },
    select: { role: true },
  })
  return member?.role === 'owner' || member?.role === 'admin'
}

/** The page of a change: of the workspace, its site not taken down by the support. */
function changeable(page: LockedPage) {
  if (takenDownOf(page) === 'operator') throw pageNotFound()
}

/**
 * Whether the page is still at the version the agent saw (Дер25), its own turn's versions aside:
 * a version this turn published or an edit of it made is the turn's, not «another one since», so
 * `page_publish` and then `page_update`, or two `page_edit`, in one turn both apply.
 */
async function stillSeen(
  tx: Tx,
  page: { id: string; currentVersion: number },
  expected: number,
  turn: { taskId: string; turnNo: number },
): Promise<boolean> {
  if (page.currentVersion === expected) return true
  if (page.currentVersion < expected) return false
  const others = await tx.pageVersion.count({
    where: {
      pageId: page.id,
      no: { gt: expected },
      OR: [
        { taskId: null },
        { taskId: { not: turn.taskId } },
        { turnNo: null },
        { turnNo: { not: turn.turnNo } },
      ],
    },
  })
  return others === 0
}

/** Whether this turn reserved a version of the page that waits for its end. */
async function versionOfTurnWaits(
  tx: Tx,
  pageId: string,
  turn: { taskId: string; turnNo: number },
): Promise<boolean> {
  const open = await tx.pageReservation.count({
    where: { pageId, taskId: turn.taskId, turnNo: turn.turnNo, kind: 'version', outcome: null },
  })
  return open > 0
}

/** The branch of a deletion changed since the turn asked it: more pages, or pages under it now. */
const pageBranchChanged = () =>
  new DomainError(
    'PAGE_BRANCH_CHANGED',
    'Pages were added under it since: read page_tree again and ask the client',
    409,
  )

/**
 * `page_edit`, `page_update`, `page_delete`, `page_restore` (Дер23–Дер27): a reservation of the
 * turn, checked now and applied at the end of the turn by core. Only a chat whose author manages
 * the workspace changes its pages (Дер24); the version the agent saw must still be the page's
 * (Дер25); a deletion is to the trash, at most 20 pages a turn (Дер27).
 */
export async function reservePageChange(
  db: Db,
  input: { workspaceId: string; taskId: string; turnNo: number; change: PageChange },
): Promise<{ reservationId: string; pageId: string; slug: string; path: string; pages: number }> {
  const { workspaceId, taskId, turnNo, change } = input
  return db.$transaction(async (tx) => {
    await lockWorkspaceOfChat(tx, workspaceId, taskId, pageNotFound)
    if (!(await chatAuthorManages(tx, taskId, workspaceId))) throw pageForbidden()
    const page = await lockPage(tx, change.pageId, workspaceId)
    changeable(page)
    let pages = 1
    if (change.kind === 'restore') {
      if (!page.deletedAt)
        throw new DomainError('PAGE_NOT_DELETED', 'The page is not in the trash', 409)
    } else {
      if (page.deletedAt) throw pageDeleted()
      // The version the agent read, or the one a publication of this turn gives it.
      const waits = await versionOfTurnWaits(tx, page.id, { taskId, turnNo })
      if (
        change.kind !== 'delete' &&
        page.currentVersion !== change.expectedVersion &&
        !(waits && change.expectedVersion === page.currentVersion + 1)
      )
        throw pageVersionChanged(page.currentVersion)
      if (change.kind === 'edit' && page.state === 'pending' && !waits)
        throw new DomainError('BAD_REQUEST', 'The page has no version yet', 400)
    }
    if (change.kind === 'edit' && page.kind === 'doc')
      throw new DomainError('BAD_REQUEST', 'A page of a document changes by its doc_* tools', 400)
    if (change.kind === 'update') await checkPlace(tx, page, change)
    if (change.kind === 'delete') {
      const branch = await tx.page.count({ where: { ...branchOf(page), deletedAt: null } })
      if (branch > 1 && !change.withChildren) throw pageHasChildren()
      const earlier = await tx.pageReservation.findMany({
        where: { taskId, turnNo, kind: 'delete', outcome: null },
        select: { payload: true },
      })
      const before = earlier.reduce(
        (sum, row) => sum + Number((row.payload as { pages?: number } | null)?.pages ?? 1),
        0,
      )
      if (before + branch > AGENT_DELETES_PER_TURN)
        throw new DomainError(
          'PAGE_DELETE_LIMIT',
          `At most ${AGENT_DELETES_PER_TURN} pages go to the trash in a turn: ask the client to delete the rest in «Страницы»`,
          409,
          { limit: AGENT_DELETES_PER_TURN },
        )
      pages = branch
    }
    const { pageId: _, kind, ...rest } = change
    const reservation = await tx.pageReservation.create({
      data: {
        pageId: page.id,
        taskId,
        turnNo,
        kind,
        title: change.kind === 'update' && change.title ? change.title : page.title,
        payload: { ...rest, pages } as Prisma.InputJsonValue,
      },
    })
    return {
      reservationId: reservation.id,
      pageId: page.id,
      slug: page.tree.slug,
      path: page.path,
      pages,
    }
  })
}

/** The open changes of a turn, in the order they were asked (Дер23). */
export function pendingPageChanges(
  db: Pick<PrismaClient, 'pageReservation'>,
  taskId: string,
  turnNo: number,
) {
  return db.pageReservation.findMany({
    where: { taskId, turnNo, outcome: null, kind: { not: 'version' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, pageId: true, kind: true, title: true, payload: true },
  })
}

/** The text a page shows now, for `page_read` and for an edit (Дер26). */
export async function readPageSource(
  db: Pick<PrismaClient, 'page'>,
  input: { pageId: string; workspaceId: string },
): Promise<{
  pageId: string
  kind: PageKind
  version: number
  documentId: string | null
  /** `markdown` — the Markdown it was drawn from; `html` — what it serves (drawn too for a page before 73.6). */
  format: 'markdown' | 'html' | 'none'
  text: string
}> {
  const page = await db.page.findFirst({
    where: { id: input.pageId, workspaceId: input.workspaceId },
    select: {
      id: true,
      kind: true,
      currentVersion: true,
      documentId: true,
      content: { select: { bytes: true, source: true } },
    },
  })
  if (!page) throw pageNotFound()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  const content = page.content
  return {
    pageId: page.id,
    kind: page.kind as PageKind,
    version: page.currentVersion,
    documentId: page.documentId,
    format: !content ? 'none' : content.source ? 'markdown' : 'html',
    text: !content ? '' : decode(content.source ?? content.bytes),
  }
}

/** The path a page gets under `parentPath` by `segment`. */
const childPath = (parentPath: string, segment: string) =>
  parentPath === '/' ? `/${segment}` : `${parentPath}/${segment}`

/**
 * Where an update puts a page, checked against its site: a segment is a label (Дер15), the home
 * page keeps its place, a page never goes under itself, and the new paths of its branch are free
 * and within `pageDepth` and `pagePathChars`.
 */
async function checkPlace(
  tx: Tx,
  page: LockedPage,
  change: { segment?: string; parentId?: string },
): Promise<{ path: string; parentId: string | null } | null> {
  if (change.segment === undefined && change.parentId === undefined) return null
  if (page.parentId === null)
    throw new DomainError('BAD_REQUEST', 'The home page of a site has no address to change', 400)
  if (change.segment !== undefined && !pageSegmentSchema.safeParse(change.segment).success)
    throw new DomainError('BAD_REQUEST', 'A segment is lower-case letters, digits and hyphens', 400)
  const parentId = change.parentId ?? page.parentId
  const parent = await tx.page.findFirst({
    where: { id: parentId, treeId: page.treeId, deletedAt: null },
    select: { id: true, path: true },
  })
  if (!parent) throw pageNotFound()
  if (isWithin(parent.path, page.path))
    throw new DomainError('BAD_REQUEST', 'A page cannot go under itself or a page below it', 400)
  const path = childPath(parent.path, change.segment ?? page.segment!)
  if (path === page.path) return { path, parentId: parent.id }
  const branch = await tx.page.findMany({
    where: { ...branchOf(page), deletedAt: null },
    select: { id: true, path: true },
  })
  const moved = branch.map((each) => path + each.path.slice(page.path.length))
  for (const each of moved)
    if (!pagePathSchema.safeParse(each).success)
      throw new DomainError('PAGE_PATH_TOO_DEEP', 'The pages would go too deep', 400)
  const taken = await tx.page.findFirst({
    where: {
      treeId: page.treeId,
      deletedAt: null,
      path: { in: moved },
      NOT: { id: { in: branch.map((each) => each.id) } },
    },
    select: { path: true },
  })
  if (taken) throw pagePathTaken(taken.path)
  return { path, parentId: parent.id }
}

/**
 * Changes the title, the address or the place of a page (Дер19, Дер30), in the caller's
 * transaction: the branch moves with it, and every former path of it sends on to its page — by
 * id, so a later move makes no chain; a path a page takes is no redirect any more, and a site
 * keeps at most `redirectsPerTree`, the oldest going first.
 */
async function updateInTx(
  tx: Tx,
  page: LockedPage,
  change: { title?: string; segment?: string; parentId?: string; position?: number },
): Promise<void> {
  const place = await checkPlace(tx, page, change)
  if (change.title !== undefined)
    await tx.page.update({ where: { id: page.id }, data: { title: change.title } })
  if (change.position !== undefined)
    await tx.page.update({ where: { id: page.id }, data: { position: change.position } })
  if (place === null || place.path === page.path) return
  const branch = await tx.page.findMany({
    where: { ...branchOf(page), deletedAt: null },
    orderBy: { path: 'asc' },
    select: { id: true, path: true },
  })
  const moved = branch.map((each) => ({
    id: each.id,
    from: each.path,
    to: place.path + each.path.slice(page.path.length),
  }))
  // Each row at its new path; the unique (tree, path) of live pages holds no two at one path.
  for (const each of moved)
    await tx.page.update({
      where: { id: each.id },
      data:
        each.id === page.id
          ? {
              path: each.to,
              parentId: place.parentId,
              segment: place.path.slice(place.path.lastIndexOf('/') + 1),
            }
          : { path: each.to },
    })
  await tx.pageRedirect.deleteMany({
    where: { treeId: page.treeId, fromPath: { in: moved.map((each) => each.to) } },
  })
  for (const each of moved)
    await tx.pageRedirect.upsert({
      where: { treeId_fromPath: { treeId: page.treeId, fromPath: each.from } },
      create: { treeId: page.treeId, fromPath: each.from, pageId: each.id },
      update: { pageId: each.id, createdAt: new Date() },
    })
  const count = await tx.pageRedirect.count({ where: { treeId: page.treeId } })
  if (count > pageLimits.redirectsPerTree) {
    const oldest = await tx.pageRedirect.findMany({
      where: { treeId: page.treeId },
      orderBy: { createdAt: 'asc' },
      take: count - pageLimits.redirectsPerTree,
      select: { fromPath: true },
    })
    await tx.pageRedirect.deleteMany({
      where: { treeId: page.treeId, fromPath: { in: oldest.map((each) => each.fromPath) } },
    })
  }
}

/**
 * The client renames, readdresses or moves a page in the cabinet (Дер30), at once, under the lock
 * of its site; a turn that holds a page of the branch makes it wait (`PAGE_BUSY`).
 */
export async function updatePage(
  db: Db,
  input: {
    pageId: string
    workspaceId: string
    title?: string
    segment?: string
    parentId?: string
    position?: number
  },
): Promise<{ path: string }> {
  return db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    changeable(page)
    if (page.deletedAt) throw pageDeleted()
    await lockTree(tx, page.treeId, input.workspaceId)
    const busy = await tx.page.findMany({
      where: { ...branchOf(page), deletedAt: null },
      select: { id: true },
    })
    await refuseBusy(
      tx,
      busy.map((each) => each.id),
    )
    const { pageId: _, workspaceId: __, ...change } = input
    await updateInTx(tx, page, change)
    const after = await tx.page.findUniqueOrThrow({
      where: { id: page.id },
      select: { path: true },
    })
    return { path: after.path }
  })
}

/** Closes a change of a turn: done, or refused or failed — never twice. */
async function closeChange(
  tx: Tx,
  reservationId: string,
  outcome: 'done' | 'refused' | 'failed',
): Promise<boolean> {
  const closed = await tx.pageReservation.updateMany({
    where: { id: reservationId, outcome: null },
    data: { outcome, settledAt: new Date() },
  })
  return closed.count === 1
}

/**
 * Applies an update, a deletion or a return a turn asked, at its end (Дер23): the author still
 * manages the workspace, the version is still the one the agent saw, then the change and the
 * close of its reservation in one transaction. A refusal closes this reservation alone.
 */
export async function applyPageChange(
  db: Db,
  input: { reservationId: string; workspaceId: string; taskId: string },
  now: Date = new Date(),
): Promise<{ kind: string; pageId: string; title: string; pages: number }> {
  return db.$transaction(async (tx) => {
    const row = await tx.pageReservation.findUniqueOrThrow({
      where: { id: input.reservationId },
      select: {
        id: true,
        pageId: true,
        kind: true,
        title: true,
        payload: true,
        outcome: true,
        taskId: true,
        turnNo: true,
      },
    })
    if (row.outcome !== null || row.taskId !== input.taskId || row.turnNo === null)
      throw pageNotFound()
    // The workspace first, as every change of its pages takes it: a return counts against it.
    await lockWorkspace(tx, input.workspaceId)
    if (!(await chatAuthorManages(tx, input.taskId, input.workspaceId))) throw pageForbidden()
    const page = await lockPage(tx, row.pageId, input.workspaceId)
    changeable(page)
    const payload = (row.payload ?? {}) as {
      expectedVersion?: number
      title?: string
      segment?: string
      parentId?: string
      position?: number
      withChildren?: boolean
      pages?: number
      /** A shared file of the site the deletion is of (Дер34); none — the page. */
      file?: string
    }
    const actor: PageActor = { type: 'agent', taskId: input.taskId }
    let pages = 1
    const turn = { taskId: input.taskId, turnNo: row.turnNo }
    if (row.kind === 'update') {
      if (page.deletedAt) throw pageDeleted()
      if (
        payload.expectedVersion !== undefined &&
        !(await stillSeen(tx, page, payload.expectedVersion, turn))
      )
        throw pageVersionChanged(page.currentVersion)
      await updateInTx(tx, page, {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.segment !== undefined ? { segment: payload.segment } : {}),
        ...(payload.parentId !== undefined ? { parentId: payload.parentId } : {}),
        ...(payload.position !== undefined ? { position: payload.position } : {}),
      })
    } else if (row.kind === 'delete' && typeof payload.file === 'string') {
      // A shared file of the site, not a page (Дер34): gone at once, as the cabinet deletes it.
      await tx.pageFile.deleteMany({ where: { treeId: page.treeId, path: payload.file } })
      await tx.auditLog.create({
        data: {
          actorType: 'agent',
          actorId: input.taskId,
          workspaceId: input.workspaceId,
          action: 'pages.file_delete',
          targetType: 'page_tree',
          targetId: page.treeId,
          meta: { path: payload.file },
        },
      })
      await closeChange(tx, row.id, 'done')
      return { kind: 'file_delete', pageId: page.id, title: payload.file, pages: 0 }
    } else if (row.kind === 'delete') {
      // The branch the agent asked of, no bigger: pages added under it since stay (rule 4, Дер27).
      pages = (
        await deleteInTx(tx, page, {
          by: 'agent',
          actor,
          now,
          asked: { pages: Number(payload.pages ?? 1), withChildren: payload.withChildren === true },
        })
      ).pages
    } else if (row.kind === 'restore') {
      pages = await returnInTx(tx, page, input.workspaceId, actor)
    } else throw new DomainError('BAD_REQUEST', 'Not a change of a page', 400)
    await closeChange(tx, row.id, 'done')
    return { kind: row.kind, pageId: page.id, title: page.title, pages }
  })
}

/**
 * The version an edit of a turn makes (Дер23, Дер25), in one transaction under the page's lock:
 * the author still manages the workspace, the support did not take the page down, the page is
 * still at the version the agent saw (its own turn's versions aside), and the text the edit was
 * made from is the one the page shows — else `PAGE_READ_STALE`, and the caller reads it again.
 */
export async function applyPageEdit(
  db: Db,
  input: {
    reservationId: string
    workspaceId: string
    taskId: string
    /** The version whose text the caller edited. */
    readVersion: number
    bytes: Uint8Array
    markdown: Uint8Array | null
  },
): Promise<{ version: number }> {
  if (input.bytes.byteLength > pageLimits.contentBytes) throw pageLimitReached('contentBytes')
  return db.$transaction(async (tx) => {
    const row = await tx.pageReservation.findUniqueOrThrow({
      where: { id: input.reservationId },
      select: {
        pageId: true,
        kind: true,
        outcome: true,
        taskId: true,
        turnNo: true,
        payload: true,
      },
    })
    if (
      row.kind !== 'edit' ||
      row.outcome !== null ||
      row.taskId !== input.taskId ||
      row.turnNo === null
    )
      throw pageNotFound()
    if (!(await chatAuthorManages(tx, input.taskId, input.workspaceId))) throw pageForbidden()
    const page = await lockPage(tx, row.pageId, input.workspaceId)
    changeable(page)
    if (page.deletedAt) throw pageDeleted()
    const expected = Number((row.payload as { expectedVersion?: number } | null)?.expectedVersion)
    const turn = { taskId: input.taskId, turnNo: row.turnNo }
    if (!(await stillSeen(tx, page, expected, turn))) throw pageVersionChanged(page.currentVersion)
    if (page.currentVersion !== input.readVersion)
      throw new DomainError('PAGE_READ_STALE', 'The page got a version since it was read', 409)
    return writeVersion(tx, page, {
      pageId: page.id,
      bytes: input.bytes,
      markdown: input.markdown,
      source: 'outbox',
      taskId: input.taskId,
      turnNo: row.turnNo,
      reservationId: input.reservationId,
    })
  })
}

/** A change the end of its turn could not apply: closed, told by its caller. */
export async function refusePageChange(
  db: Db,
  reservationId: string,
  outcome: 'refused' | 'failed',
): Promise<boolean> {
  return db.$transaction((tx) => closeChange(tx, reservationId, outcome))
}

// ———————————————————————————————————————— the operator (docs/plan/73-pages-sites.md, Дер18)

export type OperatorPageResult =
  | { kind: 'done'; pageId: string; site: boolean }
  | { kind: 'repeated'; pageId: string; site: boolean }
  | { kind: 'not_found' }

/**
 * `pages:take-down` and `pages:return` of the operator (Ст31, Дер18): a site by the host of its
 * address — every path answers 410 —, or one page of it by its path. The support's word stands
 * over the client's, and only the support takes back what it took down. An audit entry each time.
 */
export async function operatorPageDecision(
  db: Db,
  input: {
    slug: string
    path: string
    decision: 'take_down' | 'return'
    reason: string
    operator: string
  },
): Promise<OperatorPageResult> {
  return db.$transaction(async (tx) => {
    const tree = await tx.pageTree.findFirst({
      where:
        input.slug.length === 26 ? { slug: input.slug } : { names: { some: { name: input.slug } } },
      select: { id: true },
    })
    if (!tree) return { kind: 'not_found' }
    const node = await tx.page.findFirst({
      where: { treeId: tree.id, path: input.path, deletedAt: null },
      select: { id: true },
    })
    // A site by its host: its home page may be in the trash, the host is taken down all the same.
    if (input.path !== '/' && !node) return { kind: 'not_found' }
    const site = input.path === '/'
    const at = new Date()
    let changed: boolean
    // The client's own take-down before the support's: the support's return gives it back to them.
    let before: string | null
    const clientsBefore = async (targetId: string) => {
      const last = await tx.auditLog.findFirst({
        where: { action: 'pages.take_down', targetId },
        orderBy: { createdAt: 'desc' },
        select: { meta: true },
      })
      return (last?.meta as { before?: string } | null)?.before === 'client'
    }
    if (site) {
      await tx.$queryRaw`SELECT id FROM page_trees WHERE id = ${tree.id}::uuid FOR NO KEY UPDATE`
      const row = await tx.pageTree.findUniqueOrThrow({ where: { id: tree.id } })
      changed =
        input.decision === 'take_down'
          ? row.takenDownBy !== 'operator'
          : row.takenDownBy === 'operator'
      before = row.takenDownBy
      const back = input.decision === 'return' && changed && (await clientsBefore(tree.id))
      if (changed)
        await tx.pageTree.update({
          where: { id: tree.id },
          data:
            input.decision === 'take_down'
              ? { takenDownAt: at, takenDownBy: 'operator' }
              : back
                ? { takenDownAt: at, takenDownBy: 'client' }
                : { takenDownAt: null, takenDownBy: null },
        })
      // A site moved over from a page of its own has the take-down on its home page too.
      if (changed && input.decision === 'return' && node)
        await tx.page.updateMany({
          where: { id: node.id, takenDownBy: 'operator' },
          data: back
            ? { takenDownBy: 'client', takenDownAt: at }
            : { state: 'live', takenDownAt: null, takenDownBy: null },
        })
    } else {
      const page = await lockPage(tx, node!.id)
      changed =
        input.decision === 'take_down'
          ? page.takenDownBy !== 'operator'
          : page.takenDownBy === 'operator'
      if (changed && input.decision === 'take_down' && page.state === 'pending')
        return { kind: 'not_found' }
      before = page.takenDownBy
      const back = input.decision === 'return' && changed && (await clientsBefore(page.id))
      if (changed)
        await tx.page.update({
          where: { id: page.id },
          data:
            input.decision === 'take_down'
              ? { state: 'taken_down', takenDownAt: at, takenDownBy: 'operator' }
              : back
                ? { state: 'taken_down', takenDownAt: at, takenDownBy: 'client' }
                : { state: 'live', takenDownAt: null, takenDownBy: null },
        })
    }
    const pageId = node?.id ?? tree.id
    if (!changed) return { kind: 'repeated', pageId, site }
    const workspace = await tx.pageTree.findUniqueOrThrow({
      where: { id: tree.id },
      select: { workspaceId: true },
    })
    await tx.auditLog.create({
      data: {
        actorType: 'operator',
        actorId: input.operator,
        workspaceId: workspace.workspaceId,
        action: input.decision === 'take_down' ? 'pages.take_down' : 'pages.put_back',
        targetType: site ? 'page_tree' : 'page',
        targetId: site ? tree.id : pageId,
        meta: {
          slug: input.slug,
          path: input.path,
          reason: input.reason,
          ...(input.decision === 'take_down' ? { before } : {}),
        },
      },
    })
    return { kind: 'done', pageId, site }
  })
}

// ———————————————————————————————————————— the own name of a site (Дер32, Дер33)

/** Whether the tariff the workspace pays for gives its sites their own names (В3). */
async function namesAllowed(tx: Tx, workspaceId: string): Promise<boolean> {
  const live = await tx.subscription.findFirst({
    where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
    select: { plan: { select: { pageCustomNames: true } } },
  })
  return pageCustomNamesAllowed(live ? live.plan : null)
}

/** Whether the workspace may give its sites their own names now: for the cabinet's window. */
export async function pageNamesAllowed(db: Db, workspaceId: string): Promise<boolean> {
  return db.$transaction((tx) => namesAllowed(tx, workspaceId))
}

/**
 * «Адрес сайта…» (docs/plan/73-pages-sites.md, Дер32): the site of a page gets its own name, on a
 * tariff that gives names. Every name ever given stays the site's: the former one leads to the new
 * (308), and a name another site had is taken for ever. Under a lock of the name, so two sites
 * never take it at once.
 */
export async function setTreeName(
  db: Db,
  input: { pageId: string; workspaceId: string; name: string },
): Promise<{ name: string }> {
  const parsed = pageNameSchema.safeParse(input.name)
  if (!parsed.success)
    throw new DomainError(
      'PAGE_NAME_INVALID',
      'A name is 3 to 25 lower-case Latin letters, digits and hyphens, not a reserved word',
      400,
    )
  const name = parsed.data
  return db.$transaction(async (tx) => {
    const page = await lockPage(tx, input.pageId, input.workspaceId)
    const tree = await lockTree(tx, page.treeId, input.workspaceId)
    if (tree.takenDownBy === 'operator') throw pageNotFound()
    if (!(await namesAllowed(tx, input.workspaceId)))
      throw new DomainError(
        'PAGE_NAME_NEEDS_PLAN',
        'The tariff gives sites no names of their own',
        403,
      )
    if (tree.name === name) return { name }
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`page-name:${name}`}, 0))::text`
    const known = await tx.pageTreeName.findUnique({ where: { name }, select: { treeId: true } })
    if (known && known.treeId !== tree.id)
      throw new DomainError('PAGE_NAME_TAKEN', 'Another site has this name', 409)
    if (!known) await tx.pageTreeName.create({ data: { name, treeId: tree.id } })
    await tx.pageTree.update({ where: { id: tree.id }, data: { name } })
    return { name }
  })
}

// ———————————————————————————————————————— the shared files of a site (Дер34)

/**
 * `page_file_put` (docs/plan/73-pages-sites.md, Дер34): a file of the outbox at a path of shared
 * files of a site, reserved now and written at the end of the turn, when core has its bytes and
 * checked them. Any turn of the workspace, as a publication is (Дер24).
 */
export async function reservePageFile(
  db: Db,
  input: {
    workspaceId: string
    taskId: string
    turnNo: number
    treeId: string
    fileName: string
    path: string
  },
): Promise<{ reservationId: string; slug: string; path: string }> {
  if (!pageFilePathSchema.safeParse(input.path).success)
    throw new DomainError(
      'BAD_REQUEST',
      'A shared file is /_files/<folders>/<name>.<css|js|svg|png|jpg|webp|gif|avif|ico|woff2|woff|pdf>',
      400,
    )
  try {
    return await reserveFileOnce(db, input)
  } catch (error) {
    // The twin call of the same turn won the unique key: its answer is this one, or its refusal.
    if (isUniqueViolation(error)) return reserveFileOnce(db, input)
    throw error
  }
}

async function reserveFileOnce(
  db: Db,
  input: {
    workspaceId: string
    taskId: string
    turnNo: number
    treeId: string
    fileName: string
    path: string
  },
): Promise<{ reservationId: string; slug: string; path: string }> {
  return db.$transaction(async (tx) => {
    await lockWorkspaceOfChat(tx, input.workspaceId, input.taskId, pageNotFound)
    const tree = await lockTree(tx, input.treeId, input.workspaceId)
    if (tree.takenDownBy === 'operator') throw pageNotFound()
    // One file of the outbox is one thing of a turn: the same call again is the same reservation.
    const known = await tx.pageReservation.findFirst({
      where: { taskId: input.taskId, turnNo: input.turnNo, fileName: input.fileName },
      select: { id: true, kind: true, payload: true },
    })
    if (known) {
      const was = known.payload as { treeId?: string; path?: string } | null
      if (known.kind === 'asset' && was?.treeId === tree.id && was.path === input.path)
        return { reservationId: known.id, slug: hostOf(tree), path: input.path }
      throw new DomainError(
        'PAGE_RESERVED',
        'This file is already used in this turn: write it under another name for another place',
        409,
      )
    }
    const home = await tx.page.findFirst({
      where: { treeId: tree.id, parentId: null, deletedAt: null },
      select: { id: true },
    })
    if (!home) throw pageDeleted()
    const reservation = await tx.pageReservation.create({
      data: {
        pageId: home.id,
        taskId: input.taskId,
        turnNo: input.turnNo,
        kind: 'asset',
        fileName: input.fileName,
        title: input.path,
        payload: { treeId: tree.id, path: input.path },
      },
    })
    return { reservationId: reservation.id, slug: hostOf(tree), path: input.path }
  })
}

/**
 * `page_file_delete` (Дер34): a shared file of a site goes when the turn ends — a change of the
 * kind `delete` that names the file, on the home page of its site. Only a chat whose author
 * manages the workspace, as every change of its pages (Дер24); a file that is not there is
 * not found now, not at the end of the turn.
 */
export async function reservePageFileDeletion(
  db: Db,
  input: { workspaceId: string; taskId: string; turnNo: number; treeId: string; path: string },
): Promise<{ reservationId: string; slug: string; path: string }> {
  return db.$transaction(async (tx) => {
    await lockWorkspaceOfChat(tx, input.workspaceId, input.taskId, pageNotFound)
    if (!(await chatAuthorManages(tx, input.taskId, input.workspaceId))) throw pageForbidden()
    const tree = await lockTree(tx, input.treeId, input.workspaceId)
    if (tree.takenDownBy === 'operator') throw pageNotFound()
    const file = await tx.pageFile.findUnique({
      where: { treeId_path: { treeId: tree.id, path: input.path } },
      select: { path: true },
    })
    if (!file) throw new DomainError('PAGE_FILE_NOT_FOUND', 'No such file in this site', 404)
    const home = await tx.page.findFirst({
      where: { treeId: tree.id, parentId: null },
      select: { id: true },
    })
    if (!home) throw pageNotFound()
    const reservation = await tx.pageReservation.create({
      data: {
        pageId: home.id,
        taskId: input.taskId,
        turnNo: input.turnNo,
        kind: 'delete',
        title: input.path,
        payload: { file: input.path, pages: 0 },
      },
    })
    return { reservationId: reservation.id, slug: hostOf(tree), path: input.path }
  })
}

/** The bytes a site holds: its pages as served and its shared files (`treeBytes`). */
async function treeBytesOf(tx: Tx, treeId: string, without: string | null): Promise<number> {
  const rows = await tx.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT COALESCE((SELECT SUM(octet_length(c.bytes)) FROM page_contents c
                     JOIN pages p ON p.id = c.page_id WHERE p.tree_id = ${treeId}::uuid), 0)
         + COALESCE((SELECT SUM(octet_length(f.bytes)) FROM page_files f
                     WHERE f.tree_id = ${treeId}::uuid AND f.path IS DISTINCT FROM ${without}), 0)
      AS bytes`
  return Number(rows[0]?.bytes ?? 0)
}

/**
 * The end of the turn writes a shared file it reserved (Дер34): its type by its extension and its
 * bytes, within `fileBytes` and the site's `treeBytes`, a new file or the next one at its path.
 * Closes the reservation; a refusal throws, and the caller closes it as refused.
 */
export async function applyPageFile(
  db: Db,
  input: { reservationId: string; bytes: Uint8Array },
): Promise<{ treeId: string; path: string }> {
  return db.$transaction(async (tx) => {
    const row = await tx.pageReservation.findUniqueOrThrow({
      where: { id: input.reservationId },
      select: { id: true, kind: true, outcome: true, taskId: true, payload: true },
    })
    if (row.kind !== 'asset' || row.outcome !== null) throw pageNotFound()
    const { treeId, path } = row.payload as { treeId: string; path: string }
    const task = await tx.task.findUniqueOrThrow({
      where: { id: row.taskId },
      select: { workspaceId: true },
    })
    await lockTree(tx, treeId, task.workspaceId)
    const verdict = checkPageFile(path, input.bytes)
    if (!verdict.ok)
      throw new DomainError(
        'PAGE_FILE_REFUSED',
        `The file cannot be served: ${verdict.reason}`,
        422,
        {
          reason: verdict.reason,
        },
      )
    if ((await treeBytesOf(tx, treeId, path)) + input.bytes.byteLength > pageLimits.treeBytes)
      throw pageLimitReached('treeBytes')
    const bytes = new Uint8Array(input.bytes)
    await tx.pageFile.upsert({
      where: { treeId_path: { treeId, path } },
      create: {
        treeId,
        path,
        contentType: verdict.type,
        bytes,
        sha256: sha256(bytes),
        taskId: row.taskId,
      },
      update: { contentType: verdict.type, bytes, sha256: sha256(bytes), taskId: row.taskId },
    })
    await tx.pageReservation.update({
      where: { id: row.id },
      data: { outcome: 'done', settledAt: new Date() },
    })
    return { treeId, path }
  })
}

/** What the page server answers a shared file with: its type and bytes; null — none there. */
export async function servedFile(
  db: Pick<PrismaClient, 'pageFile'>,
  treeId: string,
  path: string,
): Promise<{ type: string; bytes: Uint8Array; sha256: string } | null> {
  const file = await db.pageFile.findUnique({
    where: { treeId_path: { treeId, path } },
    select: { contentType: true, bytes: true, sha256: true },
  })
  return file && { type: file.contentType, bytes: file.bytes, sha256: file.sha256 }
}

/** The shared files of a site of the workspace, for the cabinet and for `page_tree`. */
export async function listTreeFiles(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { workspaceId: string; treeId: string },
): Promise<{ path: string; type: string; sizeBytes: number; updatedAt: Date }[]> {
  const rows = await db.$queryRaw<
    { path: string; content_type: string; size: number; updated_at: Date }[]
  >`
    SELECT f.path, f.content_type, octet_length(f.bytes)::int AS size, f.updated_at
    FROM page_files f JOIN page_trees t ON t.id = f.tree_id
    WHERE f.tree_id = ${input.treeId}::uuid AND t.workspace_id = ${input.workspaceId}::uuid
    ORDER BY f.path`
  return rows.map((row) => ({
    path: row.path,
    type: row.content_type,
    sizeBytes: row.size,
    updatedAt: row.updated_at,
  }))
}

/** «Удалить файл» in the cabinet: at once; a page that loads it shows without it. */
export async function deleteTreeFile(
  db: Db,
  input: { workspaceId: string; treeId: string; path: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockTree(tx, input.treeId, input.workspaceId)
    await tx.pageFile.deleteMany({ where: { treeId: input.treeId, path: input.path } })
  })
}

// ———————————————————————————————————————— documents

export interface ChatDocumentSkeleton {
  workspaceId: string
  taskId: string
  title: string
  /** How the finished document is shown, the agent's choice (docs/plan/74, Д1). */
  view: DocView
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
        view: input.view,
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
  input:
    | { workspaceId: string; documentId: string; reader: 'client' }
    | { workspaceId: string; documentId: string; reader: 'agent'; taskId: string },
) {
  const document = await db.chatDocument.findUnique({
    where: { id: input.documentId },
    include: {
      sections: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
      page: {
        select: { id: true, state: true, currentVersion: true, tree: { select: { slug: true } } },
      },
    },
  })
  if (!document || document.workspaceId !== input.workspaceId) throw docNotFound()
  return {
    id: document.id,
    title: document.title,
    view: document.view as DocView,
    revision: document.revision,
    version: document.currentVersion,
    taskId: document.taskId,
    page: document.page && {
      id: document.page.id,
      slug: document.page.tree.slug,
      state: document.page.state,
      currentVersion: document.page.currentVersion,
    },
    sections: document.sections.map((section): ReadDocSection => {
      // The agent reads what its own chat wrote before the check; what another chat wrote — only
      // once core checked it: it may hold a value of another site (Ст19, Ст20).
      const shown =
        section.checkedTurn !== null ||
        (input.reader === 'agent' && section.writtenTaskId === input.taskId)
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
  input: {
    workspaceId: string
    documentId: string
    taskId: string
    turnNo: number
    /** A new view of the finished document (docs/plan/74, Д1); absent — as it was. */
    view?: DocView
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const document = await lockDocument(tx, input.documentId, input.workspaceId)
    const pending = await tx.chatDocumentSection.count({
      where: { documentId: document.id, state: 'pending' },
    })
    if (pending > 0) throw docPendingSections(pending)
    await tx.chatDocument.update({
      where: { id: document.id },
      data: {
        finishTaskId: input.taskId,
        finishTurnNo: input.turnNo,
        ...(input.view ? { view: input.view } : {}),
      },
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
   * The title and the intents of documents of the chat that hold what the turn must not let out:
   * they become neutral («Документ», «Раздел»), each counted as a section sent back (Ст19).
   */
  labels?: readonly { documentId: string; title: boolean; intents: readonly string[] }[]
  /**
   * Every section core scanned, by the digest it scanned: `refusal` null — it passed. A section
   * not named here, or written again since its scan, stays unchecked.
   */
  sections: readonly { sectionId: string; digest: string; refusal: PageRefusalReason | null }[]
  /**
   * `false` — a check while the turn runs (docs/plan/74, Д2): sections only, no `doc_finish`
   * comes true and none is dropped; those wait for the end of the turn. Default `true`.
   */
  final?: boolean
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
    const final = verdict.final !== false
    const finishing = final
      ? await tx.chatDocument.findMany({
          where: {
            finishTaskId: { not: null },
            workspaceId: { in: await workspacesOf(tx, verdict.taskId) },
          },
          select: { id: true },
        })
      : []
    const documentIds = [
      ...new Set([
        ...scanned.map((each) => each.documentId),
        ...finishing.map((each) => each.id),
        ...(verdict.labels ?? []).map((each) => each.documentId),
      ]),
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
      // The titles the turn could not see the values in: what is refused becomes neutral (Ст19).
      const labels = verdict.labels?.find((each) => each.documentId === documentId)
      if (labels?.title) {
        refused += 1
        changed = true
        await tx.chatDocument.update({ where: { id: documentId }, data: { title: NEUTRAL_TITLE } })
        document.title = NEUTRAL_TITLE
      }
      for (const sectionId of labels?.intents ?? []) {
        refused += 1
        changed = true
        await tx.chatDocumentSection.updateMany({
          where: { id: sectionId, documentId },
          data: { intent: NEUTRAL_INTENT },
        })
      }
      // A `doc_finish` comes true at the end of its own turn or later — never in the middle of a
      // later turn of its chat, nor before its turn ended (a turn of another chat settles).
      const finishReady =
        final &&
        document.finishTaskId !== null &&
        (document.finishTaskId === verdict.taskId
          ? (document.finishTurnNo ?? 0) <= verdict.turnNo
          : await turnEnded(tx, document.finishTaskId, document.finishTurnNo ?? 0))
      if (finishReady) {
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
              markdown,
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

/**
 * The versions of a document, oldest first, and the text of one of them (owner's request of
 * 14.11.2026): `markdown` is null for a version finished before its text was kept.
 */
export async function docVersions(
  db: Pick<PrismaClient, 'chatDocument' | 'chatDocumentVersion'>,
  input: { workspaceId: string; documentId: string },
): Promise<{ no: number; createdAt: Date; kept: boolean }[]> {
  const document = await db.chatDocument.findUnique({
    where: { id: input.documentId },
    select: { workspaceId: true },
  })
  if (!document || document.workspaceId !== input.workspaceId) throw docNotFound()
  const versions = await db.chatDocumentVersion.findMany({
    where: { documentId: input.documentId },
    orderBy: { no: 'asc' },
    select: { no: true, createdAt: true, markdown: true },
  })
  return versions.map((version) => ({
    no: version.no,
    createdAt: version.createdAt,
    kept: version.markdown !== null,
  }))
}

/** The text of one version of a document; null — no such version, or its text was not kept. */
export async function docVersionMarkdown(
  db: Pick<PrismaClient, 'chatDocument' | 'chatDocumentVersion'>,
  input: { workspaceId: string; documentId: string; version: number },
): Promise<string | null> {
  const document = await db.chatDocument.findUnique({
    where: { id: input.documentId },
    select: { workspaceId: true },
  })
  if (!document || document.workspaceId !== input.workspaceId) throw docNotFound()
  const version = await db.chatDocumentVersion.findUnique({
    where: { documentId_no: { documentId: input.documentId, no: input.version } },
    select: { markdown: true },
  })
  return version?.markdown ?? null
}

// ———————————————————————————————————————— metrics (docs/plan/73-pages-sites.md, 73.12)

/** The state of a site as the metrics count it, by its home page; `purged` — a tombstone. */
export const pageSiteStates = ['live', 'pending', 'taken_down', 'deleted', 'purged'] as const
export type PageSiteState = (typeof pageSiteStates)[number]

/**
 * The sites of every workspace by state and the bytes the trash holds — for the metrics of core,
 * never of one workspace: numbers without ids (`raditi_pages_trees`, `raditi_pages_trash_bytes`).
 */
export async function pageSiteStats(
  db: Pick<PrismaClient, '$queryRaw'>,
): Promise<{ sites: Record<PageSiteState, number>; trashBytes: number }> {
  const rows = await db.$queryRaw<{ state: PageSiteState; sites: bigint }[]>`
    SELECT CASE
             WHEN h.id IS NULL THEN 'purged'
             WHEN h.deleted_at IS NOT NULL THEN 'deleted'
             WHEN t.taken_down_by IS NOT NULL OR h.state = 'taken_down' THEN 'taken_down'
             WHEN h.state = 'pending' THEN 'pending'
             ELSE 'live'
           END AS state,
           count(*) AS sites
    FROM page_trees t
    LEFT JOIN pages h ON h.tree_id = t.id AND h.parent_id IS NULL
    GROUP BY 1`
  const trash = await db.$queryRaw<{ bytes: bigint | null }[]>`
    SELECT COALESCE(SUM(octet_length(c.bytes)), 0) AS bytes
    FROM page_contents c JOIN pages p ON p.id = c.page_id
    WHERE p.deleted_at IS NOT NULL`
  const sites = Object.fromEntries(pageSiteStates.map((state) => [state, 0])) as Record<
    PageSiteState,
    number
  >
  for (const row of rows) sites[row.state] = Number(row.sites)
  return { sites, trashBytes: Number(trash[0]?.bytes ?? 0) }
}

// ———————————————————————————————————————— the sweep

/**
 * Publications a turn reserved and no end of turn settled — the turn failed, its pass was lost —
 * older than `before`: the sweep of core settles them and tells the client (`feed.page_left`).
 */
export function stalePageReservations(
  db: Pick<PrismaClient, 'pageReservation'>,
  before: Date,
  limit = 100,
) {
  return db.pageReservation.findMany({
    // A publication of a document waits for the document (slice 69.8), however long it is written.
    // A change of the tree (Дер23) dies with its turn as a file does.
    where: {
      outcome: null,
      createdAt: { lt: before },
      OR: [{ fileName: { not: null } }, { kind: { not: 'version' } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, pageId: true, taskId: true, outcome: true },
  })
}

/**
 * Pages of files that never got a version and wait for nothing, older than `before`: never
 * published — their address answered 404 — so removing them deletes no page anyone saw (Ст14).
 * Pages of documents stay: they answer «Документ ещё пишется» (Ст25).
 */
export async function dropAbandonedPages(
  db: Pick<PrismaClient, 'page' | 'pageTree' | '$transaction'>,
  before: Date,
): Promise<number> {
  const abandoned: Prisma.PageWhereInput = {
    state: 'pending',
    currentVersion: 0,
    // The page of a document answers «Документ ещё пишется» to a viewer: its address stays.
    documentId: null,
    createdAt: { lt: before },
    reservations: { none: { outcome: null } },
    // A page with pages under it stays: they are its site (docs/plan/73-pages-sites.md, Дер12).
    children: { none: {} },
    // A home whose site holds shared files or a name stays: the files were served, and a name
    // is the site's for ever (Дер32, Дер34).
    NOT: { parentId: null, tree: { OR: [{ files: { some: {} } }, { names: { some: {} } }] } },
  }
  return db.$transaction(async (tx) => {
    // A site that held nothing but this page never had an address anyone saw: it goes with it.
    const sites = await tx.pageTree.deleteMany({
      where: {
        pages: { every: abandoned, some: {} },
        redirects: { none: {} },
        files: { none: {} },
        names: { none: {} },
      },
    })
    const pages = await tx.page.deleteMany({ where: abandoned })
    return sites.count + pages.count
  })
}

/**
 * Text of sections no end of a turn checked — the turn failed and its chat took no other — in
 * documents untouched since `before`: it may hold a value of the client, and the client never saw
 * it, so it goes; the sections are placeholders again with their intents (owner's answer of
 * 13.11.2026, Ст19: unchecked text waits for the end of a turn, not for ever). Returns how many.
 */
export async function clearStaleUncheckedSections(
  db: Pick<PrismaClient, 'chatDocumentSection'>,
  before: Date,
): Promise<number> {
  const cleared = await db.chatDocumentSection.updateMany({
    where: { state: 'written', checkedTurn: null, document: { updatedAt: { lt: before } } },
    data: {
      state: 'pending',
      heading: null,
      markdown: null,
      writtenTaskId: null,
      writtenTurn: null,
    },
  })
  return cleared.count
}
