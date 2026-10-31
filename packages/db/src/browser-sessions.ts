import {
  browserCloseReasons,
  browserControllers,
  browserHelpSchema,
  browserSessionLimits,
  browserSessionTimings,
  browserSettingBounds,
  browserTaskError,
  conflict,
  notFound,
  terminalTaskStatuses,
  type BrowserCloseReason,
  type BrowserController,
  type BrowserHelp,
} from '@repo/domain'
import { z } from 'zod'

import type { BrowserSession, Prisma } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

// The cloud browser of a task in the database (docs/plan/57-browser-tasks.md, Б15–Б18, §3.4).
// The first `web_*` call of a turn opens a session (docs/plan/61-chats-first.md, К11), core starts
// and closes it; the browser worker records what happens in it. Every write is conditional and uses the database clock; none of them
// stores anything secret.

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'browserSession'>
type RawDb = Pick<Prisma.TransactionClient, '$queryRaw'>

/** Statuses of a session that still holds a browser (isBrowserSessionLive in @repo/domain). */
const LIVE = ['starting', 'ready'] as const
/** A site in one of these takes no browser: its tasks are not accepted (Б9). */
export const browserClosedSiteStatuses = ['paused', 'disconnected', 'archived'] as const

const id = z.uuid()
const epoch = z.number().int().min(0).max(2_147_483_647)

const openSchema = z.strictObject({
  taskId: id,
  /** BROWSER_SESSION_MAX_HOURS of the caller: the hard deadline of the session. */
  maxHours: z
    .number()
    .int()
    .min(browserSettingBounds.maxHours.min)
    .max(browserSettingBounds.maxHours.max)
    .optional(),
})

/**
 * The open session of a task, started (`starting`) when it has none (Б18): its site and
 * workspace are the task's. Refuses a task that does not need a browser, has ended or whose site
 * is closed, and a new session past the live ones a workspace may hold (К36,
 * `BROWSER_WORKSPACE_BUSY`). Two callers at once get the same session: the unique index of open
 * sessions decides. Call it in a transaction: its lock on the workspace keeps the count true.
 */
export async function openBrowserSession(
  tx: Db,
  input: { taskId: string; maxHours?: number },
): Promise<BrowserSession> {
  const { taskId, maxHours = browserSessionTimings.maxHours } = openSchema.parse(input)
  const [task] = await tx.$queryRaw<
    Array<{
      site_id: string
      workspace_id: string
      needs_browser: boolean
      status: string
      site_status: string
    }>
  >`
    SELECT t.site_id, t.workspace_id, t.needs_browser, t.status::text AS status,
           s.status::text AS site_status
      FROM tasks t JOIN sites s ON s.id = t.site_id
     WHERE t.id = ${taskId}::uuid`
  if (!task) throw notFound('Task not found')
  if (!task.needs_browser) throw conflict('The task does not need a browser')
  if ((terminalTaskStatuses as readonly string[]).includes(task.status))
    throw conflict('The task has ended')
  if ((browserClosedSiteStatuses as readonly string[]).includes(task.site_status))
    throw conflict('The site of the task is closed')
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${task.workspace_id}::uuid FOR NO KEY UPDATE`
  const open = await openBrowserSessionOfTask(tx, taskId)
  if (open) return open
  const live = await tx.browserSession.count({
    where: { workspaceId: task.workspace_id, status: { in: [...LIVE] } },
  })
  if (live >= browserSessionLimits.perWorkspace) throw browserTaskError('BROWSER_WORKSPACE_BUSY')
  // A session closed between the insert that met it and the read is replaced on the next round.
  for (let round = 0; round < 3; round += 1) {
    await tx.$queryRaw`
      INSERT INTO browser_sessions (id, task_id, site_id, workspace_id, expires_at)
      VALUES (${uuidv7()}::uuid, ${taskId}::uuid, ${task.site_id}::uuid, ${task.workspace_id}::uuid,
              clock_timestamp() + ${maxHours}::int * interval '1 hour')
      ON CONFLICT (task_id) WHERE status IN ('starting', 'ready') DO NOTHING
      RETURNING id`
    const open = await openBrowserSessionOfTask(tx, taskId)
    if (open) return open
  }
  throw conflict('The browser session of the task keeps closing')
}

/** The session of the task that still holds a browser, if any. */
export async function openBrowserSessionOfTask(
  db: Pick<Prisma.TransactionClient, 'browserSession'>,
  taskId: string,
): Promise<BrowserSession | null> {
  return db.browserSession.findFirst({
    where: { taskId: id.parse(taskId), status: { in: [...LIVE] } },
  })
}

/** Every session that still holds a browser, oldest first: core's collector compares them. */
export async function listOpenBrowserSessions(
  db: Pick<Prisma.TransactionClient, 'browserSession'>,
): Promise<BrowserSession[]> {
  return db.browserSession.findMany({
    where: { status: { in: [...LIVE] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** The worker started the browser; true while the session holds one, a second call too. */
export async function markBrowserSessionReady(
  db: RawDb,
  input: { sessionId: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE browser_sessions
       SET status = 'ready', ready_at = COALESCE(ready_at, clock_timestamp()),
           last_activity_at = clock_timestamp()
     WHERE id = ${id.parse(input.sessionId)}::uuid AND status IN ('starting', 'ready')
    RETURNING id`
  return rows.length === 1
}

const controlSchema = z.strictObject({
  sessionId: id,
  controller: z.enum(browserControllers),
  controlEpoch: epoch,
})

/**
 * A hand-over the worker made (Б15, Б16). The epoch only grows: a record older than the one
 * kept is refused, and the same record again is no change. False — refused or not live.
 */
export async function recordBrowserControl(
  db: RawDb,
  input: { sessionId: string; controller: BrowserController; controlEpoch: number },
): Promise<boolean> {
  const { sessionId, controller, controlEpoch } = controlSchema.parse(input)
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE browser_sessions
       SET controller = ${controller}::"BrowserController", control_epoch = ${controlEpoch},
           last_activity_at = clock_timestamp()
     WHERE id = ${sessionId}::uuid AND status IN ('starting', 'ready')
       AND (control_epoch < ${controlEpoch}
            OR (control_epoch = ${controlEpoch} AND controller = ${controller}::"BrowserController"))
    RETURNING id`
  return rows.length === 1
}

/** The agent asked the client to act in the browser (`web_help`, Б23); false — not live. */
export async function recordBrowserHelp(
  db: RawDb,
  input: { sessionId: string } & BrowserHelp,
): Promise<boolean> {
  const sessionId = id.parse(input.sessionId)
  const { reason, message } = browserHelpSchema.parse({
    reason: input.reason,
    message: input.message,
  })
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE browser_sessions
       SET help_reason = ${reason}, help_message = ${message}, last_activity_at = clock_timestamp()
     WHERE id = ${sessionId}::uuid AND status IN ('starting', 'ready')
    RETURNING id`
  return rows.length === 1
}

/** The request for help is answered or no longer stands; false — there was none. */
export async function clearBrowserHelp(db: RawDb, input: { sessionId: string }): Promise<boolean> {
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE browser_sessions SET help_reason = NULL, help_message = NULL
     WHERE id = ${id.parse(input.sessionId)}::uuid AND help_reason IS NOT NULL
    RETURNING id`
  return rows.length === 1
}

/** Someone acted in the session or watched it: its idle time starts again. False — not live. */
export async function touchBrowserSession(
  db: RawDb,
  input: { sessionId: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE browser_sessions SET last_activity_at = clock_timestamp()
     WHERE id = ${id.parse(input.sessionId)}::uuid AND status IN ('starting', 'ready')
    RETURNING id`
  return rows.length === 1
}

/**
 * A click, input or upload in the session, the agent's or the client's (Б28): the site may have
 * changed, and a task that ends without a result says «check the site». `wrote_at` is the first
 * one of the session, `last_wrote_at` the first one of its latest pass (the worker reports one per
 * pass). Kept whatever the status: what happened is recorded even when a close came first.
 */
export async function markBrowserSessionWrote(
  db: RawDb,
  input: { sessionId: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<unknown[]>`
    UPDATE browser_sessions
       SET wrote_at = COALESCE(wrote_at, clock_timestamp()), last_wrote_at = clock_timestamp(),
           last_activity_at = clock_timestamp()
     WHERE id = ${id.parse(input.sessionId)}::uuid
    RETURNING id`
  return rows.length === 1
}

const closeSchema = z.strictObject({
  sessionId: id,
  status: z.enum(['closed', 'failed', 'lost']),
  reason: z.enum(browserCloseReasons),
  errorCode: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/)
    .optional(),
  onlyStarting: z.boolean().optional(),
})

/**
 * The session holds no browser any more (Б18): `closed` by core or the worker, `failed` to
 * start, `lost` with its worker. A second call changes nothing: the first close stands, and with
 * `onlyStarting` a browser that came up meanwhile stays open. Answers the session as it is now;
 * null — no such session.
 */
export async function closeBrowserSession(
  db: Db,
  input: {
    sessionId: string
    status: 'closed' | 'failed' | 'lost'
    reason: BrowserCloseReason
    errorCode?: string
    onlyStarting?: boolean
  },
): Promise<BrowserSession | null> {
  const { sessionId, status, reason, errorCode, onlyStarting } = closeSchema.parse(input)
  const from = onlyStarting ? ['starting'] : LIVE
  await db.$queryRaw`
    UPDATE browser_sessions
       SET status = ${status}::"BrowserSessionStatus", closed_at = clock_timestamp(),
           close_reason = ${reason}, error_code = COALESCE(${errorCode ?? null}, error_code)
     WHERE id = ${sessionId}::uuid AND status = ANY(${[...from]}::"BrowserSessionStatus"[])
    RETURNING id`
  return db.browserSession.findUnique({ where: { id: sessionId } })
}
