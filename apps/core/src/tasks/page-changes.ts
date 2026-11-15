import {
  applyPageChange,
  applyPageEdit,
  insertFeedEvent,
  pendingPageChanges,
  readPageSource,
  refusePageChange,
  type PageEdit,
  type PrismaClient,
} from '@repo/db'
import { markdownTitleOf, readingPage } from '@repo/doc-render'
import {
  checkPageContent,
  editPageText,
  isDomainError,
  pageLeftObjectOf,
  type PageLeftReason,
} from '@repo/domain'

import { pageLinkWarnings } from './page-links.ts'

// What a turn asked of the pages of its workspace besides versions (docs/plan/73-pages-sites.md,
// Дер23–Дер27): `page_edit`, `page_update`, `page_delete` and `page_restore` reserved it during the
// turn; at its end core applies each in the order asked — only core knows the values of the
// client and the keys of the turn, and a title, an address and a text are seen by a viewer.
// A change that does not fit any more is refused alone, told by `feed.page_left`; what was done
// is told by `feed.page` (a new version of an edit) or `feed.page_change`.

type Refuses = (text: string) => 'turn_key' | 'client_value' | null

export interface PageChangesDependencies {
  db: Pick<
    PrismaClient,
    '$transaction' | 'page' | 'pageReservation' | 'task' | 'taskEvent' | 'taskTurn'
  >
  logger?: { log(message: string): void; warn(message: string): void }
}

/** The text after an edit, or null: an `old` found no time, or more than once (editPageText). */
export function editedText(text: string, edits: readonly PageEdit[]): string | null {
  const edited = editPageText(text, edits)
  return edited.ok ? edited.text : null
}

const encode = (text: string) => new TextEncoder().encode(text)

/** Refusals that mean the page or its branch is not as the agent saw it: told «changed». */
const CHANGED = new Set(['PAGE_VERSION_CHANGED', 'PAGE_BRANCH_CHANGED', 'PAGE_HAS_CHILDREN'])

/** How many times an edit reads the page again when a version came between its read and its write. */
const EDIT_READS = 3

export class PageChanges {
  readonly #deps: PageChangesDependencies

  constructor(deps: PageChangesDependencies) {
    this.#deps = deps
  }

  /** Never throws: a change not applied is closed and told, or left for the sweep. */
  async apply(taskId: string, turn: number, refusesText: Refuses): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const changes = await pendingPageChanges(db, taskId, turn)
      if (changes.length === 0) return
      const task = await db.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { workspaceId: true },
      })
      const turnRow = await db.taskTurn.findFirst({
        where: { taskId, turnNo: turn },
        select: { id: true },
      })
      const where = { taskId, turnId: turnRow?.id ?? null, turn, workspaceId: task.workspaceId }
      for (const change of changes) await this.#one(change, where, refusesText)
    } catch (error) {
      logger?.warn(
        `page_changes_failed task=${taskId} turn=${turn} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
    }
  }

  async #one(
    change: Awaited<ReturnType<typeof pendingPageChanges>>[number],
    where: { taskId: string; turnId: string | null; turn: number; workspaceId: string },
    refusesText: Refuses,
  ): Promise<void> {
    const { db, logger } = this.#deps
    const payload = (change.payload ?? {}) as {
      expectedVersion?: number
      edits?: PageEdit[]
      title?: string
      segment?: string
    }
    try {
      if (change.kind === 'edit') {
        await this.#edit(change, payload, where, refusesText)
        return
      }
      // A title and an address are seen by a viewer as a text is (Ст19).
      if (refusesText([payload.title ?? '', payload.segment ?? ''].join('\n')) !== null)
        return await this.#left(change, 'refused', where)
      const done = await applyPageChange(db, {
        reservationId: change.id,
        workspaceId: where.workspaceId,
        taskId: where.taskId,
      })
      // Nothing moved: the client deleted or returned it during the turn — the chat says nothing.
      if (done.pages === 0) {
        logger?.log(`page_unchanged task=${where.taskId} turn=${where.turn} kind=${done.kind}`)
        return
      }
      await insertFeedEvent(db, {
        taskId: where.taskId,
        turnId: where.turnId,
        row: {
          type: 'feed.page_change',
          payload: {
            v: 1,
            pageId: done.pageId,
            title: payload.title ?? done.title,
            change:
              done.kind === 'delete' ? 'trashed' : done.kind === 'restore' ? 'restored' : 'updated',
            pages: done.pages,
          },
        },
      })
      logger?.log(`page_changed task=${where.taskId} turn=${where.turn} kind=${done.kind}`)
    } catch (error) {
      const code = isDomainError(error) ? error.code : 'unknown'
      logger?.warn(`page_change_refused task=${where.taskId} turn=${where.turn} reason=${code}`)
      await this.#left(change, CHANGED.has(code) ? 'changed' : 'refused', where)
    }
  }

  /** A search and replace of the text the page shows now, checked as a version of a turn is. */
  async #edit(
    change: { id: string; pageId: string; title: string },
    payload: { expectedVersion?: number; edits?: PageEdit[] },
    where: { taskId: string; turnId: string | null; turn: number; workspaceId: string },
    refusesText: Refuses,
  ): Promise<void> {
    const { db, logger } = this.#deps
    let written: { version: number; bytes: Uint8Array } | null = null
    // The version check and the write are one transaction of the database (applyPageEdit); a
    // version that came between this read and that write makes the edit read the page again.
    for (let read = 1; written === null; read += 1) {
      const source = await readPageSource(db, {
        pageId: change.pageId,
        workspaceId: where.workspaceId,
      })
      const text = editedText(source.text, payload.edits ?? [])
      if (text === null) return this.#left(change, 'changed', where)
      if (refusesText(text) !== null) return this.#left(change, 'refused', where)
      const markdown = source.format === 'markdown'
      const bytes = markdown
        ? encode(
            await readingPage({ title: markdownTitleOf(text) ?? change.title, markdown: text }),
          )
        : encode(text)
      if (!checkPageContent(bytes).ok || !checkPageContent(encode(text)).ok)
        return this.#left(change, 'refused', where)
      try {
        const { version } = await applyPageEdit(db, {
          reservationId: change.id,
          workspaceId: where.workspaceId,
          taskId: where.taskId,
          readVersion: source.version,
          bytes,
          markdown: markdown ? encode(text) : null,
        })
        written = { version, bytes }
      } catch (error) {
        if (!isDomainError(error) || error.code !== 'PAGE_READ_STALE' || read >= EDIT_READS)
          throw error
      }
    }
    const { version, bytes } = written
    const page = await db.page.findUniqueOrThrow({
      where: { id: change.pageId },
      select: {
        path: true,
        treeId: true,
        kind: true,
        title: true,
        tree: { select: { slug: true, name: true } },
      },
    })
    const paths = await db.page.findMany({
      where: { treeId: page.treeId, deletedAt: null },
      select: { path: true },
    })
    const warnings = pageLinkWarnings(
      new TextDecoder().decode(bytes),
      new Set(paths.map((each) => each.path)),
    )
    await insertFeedEvent(db, {
      taskId: where.taskId,
      turnId: where.turnId,
      row: {
        type: 'feed.page',
        payload: {
          v: 1,
          pageId: change.pageId,
          slug: page.tree.name ?? page.tree.slug,
          ...(page.path === '/' ? {} : { path: page.path }),
          ...(warnings.length > 0 ? { warnings } : {}),
          title: page.title,
          version,
          kind: page.kind as 'html' | 'markdown' | 'doc',
        },
      },
    })
    logger?.log(`page_edited task=${where.taskId} turn=${where.turn} version=${version}`)
  }

  /** A change closed undone, and told, by whoever closes it. */
  async #left(
    change: { id: string; pageId: string; kind?: string; payload?: unknown },
    reason: PageLeftReason,
    where: { taskId: string; turnId: string | null },
  ): Promise<void> {
    const { db, logger } = this.#deps
    try {
      if (!(await refusePageChange(db, change.id, 'refused'))) return
      await insertFeedEvent(db, {
        taskId: where.taskId,
        turnId: where.turnId,
        row: {
          type: 'feed.page_left',
          payload: {
            v: 1,
            pageId: change.pageId,
            reason,
            of:
              pageLeftObjectOf(change.kind ?? 'edit', change.payload) === 'file'
                ? 'file'
                : 'change',
          },
        },
      })
    } catch {
      logger?.warn(`page_change_left_failed task=${where.taskId}`)
    }
  }
}
