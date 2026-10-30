import {
  browserViewerAllowed,
  clearBrowserHelp,
  insertFeedEvent,
  closeBrowserSession,
  markBrowserSessionReady,
  markBrowserSessionWrote,
  recordBrowserControl,
  recordBrowserHelp,
  taskAttachment,
  taskBrowserCheckpoints,
  touchBrowserSession,
  upsertBrowserCheckpoint,
  type BrowserCheckpointRecord,
  type PrismaClient,
} from '@repo/db'
import type {
  BrowserCheckpointRef,
  BrowserCheckpointState,
  BrowserCloseReason,
  BrowserController,
  BrowserHelp,
  BrowserSessionStatus,
  BrowserVerifiedObject,
  SiteStack,
} from '@repo/domain'

/** A session as the database keeps it: what the worker checks before it starts a browser. */
export interface StoredBrowserSession {
  id: string
  taskId: string
  siteId: string
  status: BrowserSessionStatus
  /** The hard deadline core gave it. */
  expiresAt: Date
  /** Set once a worker started its browser: a worker that does not hold it lost it. */
  readyAt: Date | null
  /**
   * Its last activity as the database knows it: the worker's throttled touches, and the cabinet's
   * while the client looks at the dialog of its task (docs/plan/59, И18).
   */
  lastActivityAt: Date
}

/** The site of a session as the database keeps it: where its browser goes and its stack's policy. */
export interface StoredSite {
  stack: SiteStack
  /** `sites.url`: the only address a session's hosts and start page are built from (Б11). */
  url: string
}

/** An attachment of a task the worker may read for a page of the task (Б26). */
export interface StoredAttachment {
  id: string
  workspaceId: string
  siteId: string
  s3Key: string
  fileName: string
  contentType: string
  sizeBytes: number
}

/**
 * What the worker reads and writes in PostgreSQL (docs/plan/57-browser-tasks.md, §3.4): the
 * session rows core opened, the site of a session, the hand-overs, the help request, the first
 * write, the checkpoints of the task and its attachments. Nothing secret is ever written.
 */
export interface BrowserWorkerStore {
  session(sessionId: string): Promise<StoredBrowserSession | null>
  site(siteId: string): Promise<StoredSite | null>
  markReady(sessionId: string): Promise<boolean>
  recordControl(input: {
    sessionId: string
    controller: BrowserController
    controlEpoch: number
  }): Promise<boolean>
  recordHelp(input: { sessionId: string } & BrowserHelp): Promise<boolean>
  clearHelp(sessionId: string): Promise<boolean>
  touch(sessionId: string): Promise<boolean>
  markWrote(sessionId: string): Promise<boolean>
  close(input: {
    sessionId: string
    status: 'closed' | 'failed' | 'lost'
    reason: BrowserCloseReason
    errorCode?: string
  }): Promise<{ status: BrowserSessionStatus } | null>
  checkpoints(taskId: string): Promise<BrowserCheckpointRecord[]>
  upsertCheckpoint(input: {
    taskId: string
    sessionId: string
    ref: BrowserCheckpointRef
    state: BrowserCheckpointState
    verified?: BrowserVerifiedObject
  }): Promise<BrowserCheckpointRecord>
  attachment(input: { id: string; taskId: string }): Promise<StoredAttachment | null>
  viewerAllowed(input: { sessionId: string; userId: string }): Promise<boolean>
  /** Snapshots the dialog of a task shows so far (`feed.screenshot` rows). */
  screenshotCount(taskId: string): Promise<number>
  /**
   * The row of the dialog that shows a snapshot stored in the inbox, while the session of the task
   * still holds a browser; answers its number among the task's snapshots, null — no such session.
   */
  recordScreenshot(input: {
    taskId: string
    sessionId: string
    screenshotId: string
    width: number
    height: number
  }): Promise<number | null>
}

/** The store on the app's Prisma client, through the helpers of @repo/db. */
export class PostgresBrowserWorkerStore implements BrowserWorkerStore {
  readonly #db: PrismaClient

  constructor(db: PrismaClient) {
    this.#db = db
  }

  async session(sessionId: string): Promise<StoredBrowserSession | null> {
    const row = await this.#db.browserSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        taskId: true,
        siteId: true,
        status: true,
        expiresAt: true,
        readyAt: true,
        lastActivityAt: true,
      },
    })
    return row
  }

  site(siteId: string): Promise<StoredSite | null> {
    return this.#db.site.findUnique({
      where: { id: siteId },
      select: { stack: true, url: true },
    })
  }

  markReady(sessionId: string): Promise<boolean> {
    return markBrowserSessionReady(this.#db, { sessionId })
  }

  recordControl(input: {
    sessionId: string
    controller: BrowserController
    controlEpoch: number
  }): Promise<boolean> {
    return recordBrowserControl(this.#db, input)
  }

  recordHelp(input: { sessionId: string } & BrowserHelp): Promise<boolean> {
    return recordBrowserHelp(this.#db, input)
  }

  clearHelp(sessionId: string): Promise<boolean> {
    return clearBrowserHelp(this.#db, { sessionId })
  }

  touch(sessionId: string): Promise<boolean> {
    return touchBrowserSession(this.#db, { sessionId })
  }

  markWrote(sessionId: string): Promise<boolean> {
    return markBrowserSessionWrote(this.#db, { sessionId })
  }

  async close(input: {
    sessionId: string
    status: 'closed' | 'failed' | 'lost'
    reason: BrowserCloseReason
    errorCode?: string
  }): Promise<{ status: BrowserSessionStatus } | null> {
    const row = await closeBrowserSession(this.#db, input)
    return row ? { status: row.status } : null
  }

  checkpoints(taskId: string): Promise<BrowserCheckpointRecord[]> {
    return taskBrowserCheckpoints(this.#db, taskId)
  }

  upsertCheckpoint(input: {
    taskId: string
    sessionId: string
    ref: BrowserCheckpointRef
    state: BrowserCheckpointState
    verified?: BrowserVerifiedObject
  }): Promise<BrowserCheckpointRecord> {
    return upsertBrowserCheckpoint(this.#db, input)
  }

  async attachment(input: { id: string; taskId: string }): Promise<StoredAttachment | null> {
    const row = await taskAttachment(this.#db, input)
    if (!row) return null
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      siteId: row.siteId,
      s3Key: row.s3Key,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
    }
  }

  viewerAllowed(input: { sessionId: string; userId: string }): Promise<boolean> {
    return browserViewerAllowed(this.#db, input)
  }

  screenshotCount(taskId: string): Promise<number> {
    return this.#db.taskEvent.count({ where: { taskId, type: SCREENSHOT_ROW } })
  }

  recordScreenshot(input: {
    taskId: string
    sessionId: string
    screenshotId: string
    width: number
    height: number
  }): Promise<number | null> {
    return this.#db.$transaction(async (tx) => {
      // The row of the session locks it: a close that comes meanwhile waits, or came first.
      const live = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM browser_sessions
        WHERE id = ${input.sessionId}::uuid AND task_id = ${input.taskId}::uuid
          AND status IN ('starting', 'ready')
        FOR UPDATE`
      if (live.length === 0) return null
      const number =
        (await tx.taskEvent.count({
          where: { taskId: input.taskId, type: SCREENSHOT_ROW },
        })) + 1
      await insertFeedEvent(tx, {
        taskId: input.taskId,
        row: {
          type: SCREENSHOT_ROW,
          payload: {
            v: 1,
            screenshotId: input.screenshotId,
            number,
            width: input.width,
            height: input.height,
          },
        },
      })
      return number
    })
  }
}

const SCREENSHOT_ROW = 'feed.screenshot'
