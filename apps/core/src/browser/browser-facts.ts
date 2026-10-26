import { taskBrowserCheckpoints, type Prisma } from '@repo/db'
import {
  browserFeedObjectOf,
  browserHelpReasons,
  feedLimits,
  isBrowserSessionLive,
  type BrowserController,
  type BrowserHelpReason,
  type FeedObject,
} from '@repo/domain'

// What the end of a pass of a task in the cloud browser depends on (docs/plan/57-browser-tasks.md,
// Б23, Б24, Б28), as the database holds it: the browser worker records the session — who drives
// it, what the agent asked of the client — and the checkpoints with what the last trusted read of
// the site found. Read right before a pass is settled, after its caller asked the worker to check
// the checkpoints again (BrowserSessions.verify).

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'browserSession' | 'taskEvent'>

export interface BrowserTaskFacts {
  /** What the agent asked the client to do in the browser (`web_help`), not answered yet. */
  help: { reason: BrowserHelpReason; message: string } | null
  /** Who drives the live session; `agent` when none is live. */
  controller: BrowserController
  /**
   * What the task saved on the site, as the platform found it there — for the feed's
   * `objects[]` (`browserFeedObjectOf`): confirmed, unconfirmed or missing; never one it only saw.
   */
  objects: FeedObject[]
  /** Some object of the task is confirmed on the site: a ground for `done` (Б23). */
  confirmed: boolean
  /**
   * The agent sent the client a screenshot of the site after the client's latest request, and
   * nothing the task saved stands unconfirmed or missing: the other ground for `done` — the
   * snapshot is the result the client sees (owner's decision of 26.10.2026).
   */
  screenshotted: boolean
}

const isHelpReason = (reason: string | null): reason is BrowserHelpReason =>
  reason !== null && (browserHelpReasons as readonly string[]).includes(reason)

/**
 * The facts of the task's browser: its latest session — the live one when there is one — and
 * every checkpoint of the task. A task that never opened a browser has none of either.
 */
export async function readBrowserTaskFacts(db: Reader, taskId: string): Promise<BrowserTaskFacts> {
  const [session, checkpoints, request] = await Promise.all([
    db.browserSession.findFirst({
      where: { taskId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { status: true, controller: true, helpReason: true, helpMessage: true },
    }),
    taskBrowserCheckpoints(db, taskId),
    db.taskEvent.findFirst({
      where: { taskId, type: 'feed.request' },
      orderBy: { id: 'desc' },
      select: { id: true },
    }),
  ])
  const screenshots = await db.taskEvent.count({
    where: { taskId, type: 'feed.screenshot', ...(request ? { id: { gt: request.id } } : {}) },
  })
  const all = checkpoints
    .map((checkpoint) => browserFeedObjectOf(checkpoint))
    .filter((object): object is FeedObject => object !== null)
  const objects = all.slice(0, feedLimits.objects)
  return {
    help:
      session && isHelpReason(session.helpReason) && session.helpMessage
        ? { reason: session.helpReason, message: session.helpMessage }
        : null,
    // A browser that is gone holds no control: the next pass opens a new one for the agent.
    controller: session && isBrowserSessionLive(session.status) ? session.controller : 'agent',
    objects,
    confirmed: checkpoints.some(
      (checkpoint) => checkpoint.state === 'verified' && checkpoint.verified !== null,
    ),
    screenshotted:
      screenshots > 0 &&
      all.every((object) => object.status !== 'unconfirmed' && object.status !== 'missing'),
  }
}
