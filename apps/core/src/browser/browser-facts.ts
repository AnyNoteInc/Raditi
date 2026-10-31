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

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'browserSession'>
type TurnReader = Pick<Prisma.TransactionClient, 'browserSession' | 'turnAssignment'>

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
  /** Some object of the task is confirmed on the site: the site changed (Б23). */
  confirmed: boolean
}

const isHelpReason = (reason: string | null): reason is BrowserHelpReason =>
  reason !== null && (browserHelpReasons as readonly string[]).includes(reason)

/**
 * The browser a turn asked for failed to start and none came up in it: no session open during the
 * turn was ever `ready`, and one is `failed`, which only a start ends in, whichever side gave up.
 * A browser still starting is no such case: the agent was told to call again (К11).
 */
export async function browserFailedInTurn(
  db: TurnReader,
  taskId: string,
  turn: number,
): Promise<boolean> {
  const assignment = await db.turnAssignment.findFirst({
    where: { taskId, turnNo: turn },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })
  if (!assignment) return false
  const sessions = await db.browserSession.findMany({
    where: { taskId, OR: [{ closedAt: null }, { closedAt: { gte: assignment.createdAt } }] },
    select: { status: true, readyAt: true },
  })
  return (
    sessions.some((session) => session.status === 'failed') &&
    sessions.every((session) => session.readyAt === null)
  )
}

/**
 * The facts of the task's browser: its latest session — the live one when there is one — and
 * every checkpoint of the task. A task that never opened a browser has none of either.
 */
export async function readBrowserTaskFacts(db: Reader, taskId: string): Promise<BrowserTaskFacts> {
  const [session, checkpoints] = await Promise.all([
    db.browserSession.findFirst({
      where: { taskId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { status: true, controller: true, helpReason: true, helpMessage: true },
    }),
    taskBrowserCheckpoints(db, taskId),
  ])
  const objects = checkpoints
    .map((checkpoint) => browserFeedObjectOf(checkpoint))
    .filter((object): object is FeedObject => object !== null)
    .slice(0, feedLimits.objects)
  return {
    // A request of a session that is gone is nobody's now: no pass starts a browser any more, so
    // it would turn into a question about a browser the client cannot reach.
    help:
      session &&
      isBrowserSessionLive(session.status) &&
      isHelpReason(session.helpReason) &&
      session.helpMessage
        ? { reason: session.helpReason, message: session.helpMessage }
        : null,
    // A browser that is gone holds no control: the agent's next `web_*` call starts a new one.
    controller: session && isBrowserSessionLive(session.status) ? session.controller : 'agent',
    objects,
    confirmed: checkpoints.some(
      (checkpoint) => checkpoint.state === 'verified' && checkpoint.verified !== null,
    ),
  }
}
