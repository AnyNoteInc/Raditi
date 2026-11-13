import { applyPageVersion, insertFeedEvent, type PrismaClient } from '@repo/db'
import { checkPageContent, isDomainError, type PageLeftReason } from '@repo/domain'

// The pages a turn published (docs/plan/69-pages.md, Ст6, Ст8, Ст23): `page_publish` reserved
// them during the turn; at its end each file of the outbox a reservation names becomes the next
// version of its page — checked first — and the client gets `feed.page`, or `feed.page_left` when
// the file never came or did not pass. The outbox was scanned for the keys of the turn and the
// values of the client's variables before it got here (`readOutboxArchive({ refused })`).
// A reservation is closed and its row written in one transaction: whoever closes it tells it,
// once, and a reservation already closed is never told again.

export interface PagePublicationsDependencies {
  db: Pick<PrismaClient, '$transaction' | 'pageReservation' | 'taskEvent'>
  logger?: { log(message: string): void; warn(message: string): void }
}

export interface FileReservation {
  id: string
  pageId: string
  slug: string
  kind: string
  title: string
  fileName: string
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
      include: { page: { select: { slug: true, kind: true } } },
    })
    return new Map(
      rows.map((row) => [
        row.fileName!,
        {
          id: row.id,
          pageId: row.pageId,
          slug: row.page.slug,
          kind: row.page.kind,
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
   * file was taken: one the pages cannot draw yet goes on as a file of the chat. A reservation
   * done before (a delivery repeated after a crash) only gets the row it may lack.
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
    // Markdown and documents are drawn to a reading page by @repo/doc-render (slice 69.5): until
    // then the file reaches the chat as a file, and the page is told not to have come.
    if (reservation.kind !== 'html') {
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
    let version: number
    try {
      ;({ version } = await applyPageVersion(db, {
        pageId: reservation.pageId,
        bytes,
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
    // The page is live: a row that fails now is written by the next delivery, never told as lost.
    await this.#row(reservation, version, context).catch(() =>
      logger?.warn(`page_row_failed task=${context.taskId} turn=${context.turn}`),
    )
    return true
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
        await insertFeedEvent(tx, {
          taskId: where.taskId,
          turnId: where.turnId,
          row: { type: 'feed.page_left', payload: { v: 1, pageId: reservation.pageId, reason } },
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

  async #row(reservation: FileReservation, version: number, where: Where): Promise<void> {
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
          title: reservation.title,
          version,
          kind: reservation.kind as 'html' | 'markdown' | 'doc',
        },
      },
    })
  }
}
