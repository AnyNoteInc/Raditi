import {
  issueBrowserStreamTicket,
  openBrowserSessionOfTask,
  touchBrowserSession,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  browserCloseReasons,
  browserControllers,
  browserHelpReasons,
  browserSessionStatuses,
  feedText,
  hasVisibleText,
  type BrowserCloseReason,
  type BrowserController,
  type BrowserHelpReason,
  type BrowserSessionStatus,
} from '@repo/domain'
import { z } from 'zod'

import { accessibleTask, taskNotFound } from './access.ts'
import { browserStreamUrlOf, type ChatContext } from './context.ts'

// The cloud browser of a task as the cabinet sees it (docs/plan/57-browser-tasks.md, Б12–Б18):
// the state of its session beside the feed, the one-time ticket the stream is opened with, and
// the client looking at the dialog, which keeps the session from its idle end (docs/plan/59, И18).
// The worker and core write the session; here only the time of its last activity is.

/** The session of a task in the head of its feed; null — the task has no browser, or none yet. */
export interface FeedBrowser {
  sessionId: string
  status: BrowserSessionStatus
  controller: BrowserController
  /** What the agent asked the client to do in the browser (`web_help`); null — nothing. */
  help: { reason: BrowserHelpReason; message: string | null } | null
  /** Why the session holds no browser any more; null while it does, or a reason this code lacks. */
  closeReason: BrowserCloseReason | null
}

export const feedBrowserOutput = z
  .strictObject({
    sessionId: z.uuid(),
    status: z.enum(browserSessionStatuses),
    controller: z.enum(browserControllers),
    help: z
      .strictObject({ reason: z.enum(browserHelpReasons), message: z.string().nullable() })
      .nullable(),
    closeReason: z.enum(browserCloseReasons).nullable(),
  })
  .nullable()

const isOneOf = <T extends string>(values: readonly T[], value: string | null): value is T =>
  value !== null && (values as readonly string[]).includes(value)

/**
 * The latest session of a task that needs a browser, read in the snapshot of its feed: the open
 * one, or the one that closed last. The agent's words of a request for help reach the client as
 * the feed shows agent text (`feedText`); a reason this code does not know is no request.
 */
export async function feedBrowser(
  tx: Pick<Prisma.TransactionClient, 'browserSession'>,
  task: { id: string; needsBrowser: boolean },
): Promise<FeedBrowser | null> {
  if (!task.needsBrowser) return null
  const session = await tx.browserSession.findFirst({
    where: { taskId: task.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      status: true,
      controller: true,
      helpReason: true,
      helpMessage: true,
      closeReason: true,
    },
  })
  if (session === null) return null
  let help: FeedBrowser['help'] = null
  if (isOneOf(browserHelpReasons, session.helpReason)) {
    const message = session.helpMessage === null ? null : feedText(session.helpMessage).trim()
    help = {
      reason: session.helpReason,
      message: message !== null && hasVisibleText(message) ? message : null,
    }
  }
  return {
    sessionId: session.id,
    status: session.status,
    controller: session.controller,
    help,
    closeReason: isOneOf(browserCloseReasons, session.closeReason) ? session.closeReason : null,
  }
}

/**
 * `browser.streamTicket` (Б12): a one-time ticket for the stream of the open session of a task in
 * the browser, and where to send it. A task of someone else, a task without a browser and a task
 * whose browser is closed answer the same NOT_FOUND; a process without a browser answers that it
 * is unavailable.
 */
export async function issueStreamTicket(
  db: PrismaClient,
  chat: ChatContext,
  input: { userId: string; taskId: string },
): Promise<{ url: string; ticket: string; sessionId: string }> {
  const url = browserStreamUrlOf(chat)
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true, needsBrowser: true },
  })
  if (task === null || !task.needsBrowser) throw taskNotFound()
  const session = await openBrowserSessionOfTask(db, task.id)
  if (session === null) throw taskNotFound()
  // Checked again in the statement that writes the ticket: membership, the session, the site.
  const issued = await issueBrowserStreamTicket(db, { sessionId: session.id, userId: input.userId })
  if (issued === null) throw taskNotFound()
  return { url, ticket: issued.ticket, sessionId: session.id }
}

/**
 * The client looks at the dialog of a task in the browser (owner's answer of 30.10.2026, docs/plan/
 * 59, И18): the chat counts as watching the browser, so its session does not close for idle while
 * the page of the dialog is on the screen. Only its idle time starts again — the hard deadline of
 * the session stays. `watched: false` — no session of the task holds a browser now; a task of
 * someone else, and one without a browser, answer NOT_FOUND.
 */
export async function watchBrowser(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<{ watched: boolean }> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true, needsBrowser: true },
  })
  if (task === null || !task.needsBrowser) throw taskNotFound()
  const session = await openBrowserSessionOfTask(db, task.id)
  if (session === null) return { watched: false }
  return { watched: await touchBrowserSession(db, { sessionId: session.id }) }
}
