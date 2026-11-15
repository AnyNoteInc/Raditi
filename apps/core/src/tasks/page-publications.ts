import { applyPageFile, applyPageVersion, insertFeedEvent, type PrismaClient } from '@repo/db'
import { markdownTitleOf, readingPage } from '@repo/doc-render'
import {
  checkPageContent,
  isDomainError,
  pageFileIsText,
  pageLeftObjectOf,
  type PageLeftReason,
  type PageLinkWarning,
} from '@repo/domain'

import { pageLinkWarnings } from './page-links.ts'

// The pages a turn published (docs/plan/69-pages.md, Ст6, Ст8, Ст23): `page_publish` reserved
// them during the turn; at its end each file of the outbox a reservation names becomes the next
// version of its page — checked first — and the client gets `feed.page`, or `feed.page_left` when
// the file never came or did not pass. The outbox was scanned for the keys of the turn and the
// values of the client's variables before it got here (`readOutboxArchive({ refused })`).
// A reservation is closed and its row written in one transaction: whoever closes it tells it,
// once, and a reservation already closed is never told again. A `.md` file and a document are
// drawn into a page for reading by @repo/doc-render (Ст11) once, here: the page server only
// serves its bytes.

export interface PagePublicationsDependencies {
  db: Pick<PrismaClient, '$transaction' | 'chatDocument' | 'page' | 'pageReservation' | 'taskEvent'>
  logger?: { log(message: string): void; warn(message: string): void }
}

export interface FileReservation {
  id: string
  pageId: string
  /** The host of its site (docs/plan/73-pages-sites.md, Дер11). */
  slug: string
  /** Its path in the site: `/` for a home page. */
  path: string
  treeId: string
  kind: string
  /** `asset` — a shared file of the site (docs/plan/73-pages-sites.md, Дер34); else a page's version. */
  reservationKind?: string
  title: string
  fileName: string | null
  outcome: string | null
  versionNo: number | null
}

interface Where {
  taskId: string
  turnId: string | null
}

export class PagePublications {
  readonly #deps: PagePublicationsDependencies

  constructor(deps: PagePublicationsDependencies) {
    this.#deps = deps
  }

  /** The files a turn reserved, by name — settled ones too: a repeated delivery skips them. */
  async filesOf(taskId: string, turn: number): Promise<Map<string, FileReservation>> {
    const rows = await this.#deps.db.pageReservation.findMany({
      where: { taskId, turnNo: turn, fileName: { not: null } },
      include: {
        page: {
          select: {
            path: true,
            treeId: true,
            kind: true,
            tree: { select: { slug: true, name: true } },
          },
        },
      },
    })
    return new Map(
      rows.map((row) => [
        row.fileName!,
        {
          id: row.id,
          pageId: row.pageId,
          slug: row.page.tree.name ?? row.page.tree.slug,
          path: row.page.path,
          treeId: row.page.treeId,
          kind: row.page.kind,
          reservationKind: row.kind,
          title: row.title,
          fileName: row.fileName!,
          outcome: row.outcome,
          versionNo: row.versionNo,
        },
      ]),
    )
  }

  /**
   * The file of a reservation: its next version, or a refusal. Never throws. Returns whether the
   * file was taken: one the pages cannot draw goes on as a file of the chat. A reservation done
   * before (a delivery repeated after a crash) only gets the row it may lack. A `.md` file is
   * checked as the agent wrote it, then drawn into a page for reading.
   */
  async publish(
    reservation: FileReservation,
    bytes: Uint8Array,
    context: Where & { turn: number },
  ): Promise<boolean> {
    const { db, logger } = this.#deps
    if (reservation.outcome === 'done' && reservation.versionNo !== null) {
      await this.#row(reservation, reservation.versionNo, context)
      return true
    }
    if (reservation.outcome !== null) return true
    if (reservation.reservationKind === 'asset') return this.#asset(reservation, bytes, context)
    // A file is HTML or Markdown; a page of a document gets no file.
    if (reservation.kind !== 'html' && reservation.kind !== 'markdown') {
      await this.left(reservation, 'failed', context)
      return false
    }
    const verdict = checkPageContent(bytes)
    if (!verdict.ok) {
      logger?.warn(
        `page_refused task=${context.taskId} turn=${context.turn} reason=${verdict.reason}`,
      )
      await this.left(reservation, 'refused', context)
      return true
    }
    // The heading of a `.md` page is the file's own, which the outbox scan read — never the title
    // of the reservation, which no scan of the turn's keys and the client's values read. What is
    // drawn is checked once more: it is what the viewer gets.
    let content = bytes
    if (reservation.kind === 'markdown') {
      const markdown = new TextDecoder().decode(bytes)
      content = await drawn(markdownTitleOf(markdown) ?? 'Документ', markdown)
      const own = checkPageContent(content)
      if (!own.ok) {
        logger?.warn(
          `page_refused task=${context.taskId} turn=${context.turn} reason=${own.reason}`,
        )
        await this.left(reservation, 'refused', context)
        return true
      }
    }
    let version: number
    try {
      ;({ version } = await applyPageVersion(db, {
        pageId: reservation.pageId,
        bytes: content,
        // The Markdown a page was drawn from is what page_read gives the agent back (Дер26).
        markdown: reservation.kind === 'markdown' ? bytes : null,
        source: 'outbox',
        title: reservation.title,
        taskId: context.taskId,
        turnNo: context.turn,
        reservationId: reservation.id,
      }))
    } catch (error) {
      logger?.warn(
        `page_publish_failed task=${context.taskId} turn=${context.turn} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
      await this.left(reservation, 'failed', context)
      return true
    }
    logger?.log(`page_published task=${context.taskId} turn=${context.turn} version=${version}`)
    const warnings = await this.linksOf(reservation.treeId, content)
    // The page is live: a row that fails now is written by the next delivery, never told as lost.
    await this.#row(reservation, version, context, warnings).catch(() =>
      logger?.warn(`page_row_failed task=${context.taskId} turn=${context.turn}`),
    )
    return true
  }

  /**
   * The publications of documents of a chat (`page_publish({ docId })`, Ст7, Ст8), at the end of its
   * turn, after its sections settled: an open one whose document has a version gets it drawn as
   * the next version of its page; one whose document this end of turn sent sections back for
   * (`refusedDocuments`) is told `refused`; the rest stays open — the page answers «Документ ещё
   * пишется» — for an end of a turn that makes the version. Never throws.
   */
  async publishDocuments(
    taskId: string,
    turnId: string | null,
    refusedDocuments: ReadonlySet<string>,
  ): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const open = await db.pageReservation.findMany({
        where: { taskId, documentId: { not: null }, outcome: null },
        orderBy: { createdAt: 'asc' },
        include: {
          page: {
            select: {
              path: true,
              treeId: true,
              kind: true,
              tree: { select: { slug: true, name: true } },
            },
          },
        },
      })
      for (const row of open) {
        const reservation: FileReservation = {
          id: row.id,
          pageId: row.pageId,
          slug: row.page.tree.name ?? row.page.tree.slug,
          path: row.page.path,
          treeId: row.page.treeId,
          kind: row.page.kind,
          title: row.title,
          fileName: null,
          outcome: row.outcome,
          versionNo: row.versionNo,
        }
        const where = { taskId, turnId }
        if (refusedDocuments.has(row.documentId!)) {
          await this.left(reservation, 'refused', where)
          continue
        }
        const document = await db.chatDocument.findUnique({
          where: { id: row.documentId! },
          select: { title: true, content: { select: { markdown: true } } },
        })
        if (!document?.content) continue
        // Its title and sections passed the end of a turn; the page drawn of them is checked too.
        const bytes = await drawn(document.title, document.content.markdown)
        const verdict = checkPageContent(bytes)
        if (!verdict.ok) {
          logger?.warn(`page_refused task=${taskId} turn=${row.turnNo} reason=${verdict.reason}`)
          await this.left(reservation, 'refused', where)
          continue
        }
        let version: number
        try {
          ;({ version } = await applyPageVersion(db, {
            pageId: row.pageId,
            bytes,
            markdown: new TextEncoder().encode(document.content.markdown),
            source: 'doc',
            title: row.title,
            taskId,
            turnNo: row.turnNo,
            reservationId: row.id,
          }))
        } catch (error) {
          logger?.warn(
            `page_publish_failed task=${taskId} turn=${row.turnNo} reason=${isDomainError(error) ? error.code : 'unknown'}`,
          )
          await this.left(reservation, 'failed', where)
          continue
        }
        logger?.log(`page_published task=${taskId} turn=${row.turnNo} version=${version}`)
        const warnings = await this.linksOf(reservation.treeId, bytes)
        await this.#row(reservation, version, where, warnings).catch(() =>
          logger?.warn(`page_row_failed task=${taskId} turn=${row.turnNo}`),
        )
      }
    } catch {
      logger?.warn(`page_documents_failed task=${taskId}`)
    }
  }

  /**
   * A reservation that did not come true: closed and told in one transaction, only by whoever
   * closes it. Never throws.
   */
  async left(
    reservation: Pick<FileReservation, 'id' | 'pageId'>,
    reason: PageLeftReason,
    where: Where,
  ): Promise<void> {
    const { db, logger } = this.#deps
    try {
      await db.$transaction(async (tx) => {
        const closed = await tx.pageReservation.updateMany({
          where: { id: reservation.id, outcome: null },
          data: { outcome: reason, settledAt: new Date() },
        })
        if (closed.count !== 1) return
        // A shared file and a change are told as what they are, not as a page that did not come.
        const row = await tx.pageReservation.findUnique({
          where: { id: reservation.id },
          select: { kind: true, payload: true },
        })
        const of = pageLeftObjectOf(row?.kind ?? 'version', row?.payload)
        await insertFeedEvent(tx, {
          taskId: where.taskId,
          turnId: where.turnId,
          row: {
            type: 'feed.page_left',
            payload: { v: 1, pageId: reservation.pageId, reason, ...(of === 'page' ? {} : { of }) },
          },
        })
      })
    } catch {
      logger?.warn(`page_left_failed task=${where.taskId} reason=${reason}`)
    }
  }

  /**
   * A turn that failed or was cancelled (Ст6): its open publications are told at once, not a day
   * later by the sweep. Never throws.
   */
  async failTurn(taskId: string, turn: number, turnId: string | null): Promise<void> {
    try {
      const open = await this.#deps.db.pageReservation.findMany({
        where: { taskId, turnNo: turn, outcome: null },
        select: { id: true, pageId: true },
      })
      for (const reservation of open) await this.left(reservation, 'failed', { taskId, turnId })
    } catch {
      this.#deps.logger?.warn(`page_turn_failed task=${taskId} turn=${turn}`)
    }
  }

  /**
   * A shared file of a site the turn put (Дер34): its type and bytes checked, a text one as a page
   * is, then written at its path. Never throws; a refusal is told as the page's is.
   */
  async #asset(
    reservation: FileReservation,
    bytes: Uint8Array,
    context: Where & { turn: number },
  ): Promise<boolean> {
    const { db, logger } = this.#deps
    if (pageFileIsText(reservation.title) && !checkPageContent(bytes).ok) {
      logger?.warn(`page_file_refused task=${context.taskId} turn=${context.turn} reason=content`)
      await this.left(reservation, 'refused', context)
      return true
    }
    try {
      await applyPageFile(db, { reservationId: reservation.id, bytes })
      logger?.log(`page_file_written task=${context.taskId} turn=${context.turn}`)
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      logger?.warn(`page_file_refused task=${context.taskId} turn=${context.turn} reason=${code}`)
      await this.left(reservation, code === 'unknown' ? 'failed' : 'refused', context)
    }
    return true
  }

  /**
   * The links of a version to its own site that lead nowhere (docs/plan/73-pages-sites.md, Дер20):
   * against every page of the site out of the trash — the pages this turn reserved are there,
   * pending. Never throws: a warning that cannot be read is none.
   */
  async linksOf(treeId: string, content: Uint8Array): Promise<PageLinkWarning[]> {
    try {
      const pages = await this.#deps.db.page.findMany({
        where: { treeId, deletedAt: null },
        select: { path: true },
      })
      return pageLinkWarnings(
        new TextDecoder().decode(content),
        new Set(pages.map((page) => page.path)),
      )
    } catch {
      return []
    }
  }

  async #row(
    reservation: FileReservation,
    version: number,
    where: Where,
    warnings: readonly PageLinkWarning[] = [],
  ): Promise<void> {
    const { db } = this.#deps
    const known = await db.taskEvent.findFirst({
      where: {
        taskId: where.taskId,
        type: 'feed.page',
        AND: [
          { payload: { path: ['pageId'], equals: reservation.pageId } },
          { payload: { path: ['version'], equals: version } },
        ],
      },
      select: { id: true },
    })
    if (known) return
    await insertFeedEvent(db, {
      taskId: where.taskId,
      turnId: where.turnId,
      row: {
        type: 'feed.page',
        payload: {
          v: 1,
          pageId: reservation.pageId,
          slug: reservation.slug,
          ...(reservation.path === '/' ? {} : { path: reservation.path }),
          ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
          title: reservation.title,
          version,
          kind: reservation.kind as 'html' | 'markdown' | 'doc',
        },
      },
    })
  }
}

/** The page for reading of a text: drawn by the very rules of the cabinet's tab (Ст11). */
async function drawn(title: string, markdown: string): Promise<Uint8Array> {
  return new TextEncoder().encode(await readingPage({ title, markdown }))
}
