import { openBrowserSessionOfTask, type MemberRole, type Prisma } from '@repo/db'
import {
  chatCommandAvailability,
  readFeedRow,
  terminalTaskStatuses,
  type AgentBrowserRefusal,
  type ChatCommandAvailability,
  type ChatCommandFacts,
  type ChatCommandRefusal,
  type CompactRefusal,
  type ServerCommandId,
  type TaskStatus,
  type TurnRedoRefusal,
  type TurnUndoRefusal,
} from '@repo/domain'
import { z } from 'zod'

import { memberRole } from './access.ts'
import { cancelPending, movingRequest, openCeilingQuestion, visible } from './dialog-state.ts'
import { commandUnavailable } from './refusals.ts'

type Reader = Pick<
  Prisma.TransactionClient,
  | 'member'
  | 'task'
  | 'taskEvent'
  | 'browserSession'
  | 'taskTurn'
  | 'turnAssignment'
  | 'agentDriver'
  | '$queryRaw'
>

export interface DialogFacts {
  role: MemberRole | null
  /** What `chatCommandAvailability` decides by. */
  commands: ChatCommandFacts
}

/**
 * The task of the facts. What a caller already read of its row is taken as read — the columns of
 * the task and the reader's role (null — not a member) — and the rest is read here.
 */
export interface FactsTask {
  id: string
  workspaceId: string
  status: TaskStatus
  needsBrowser?: boolean
  turnNo?: number
  role?: MemberRole | null
}

/**
 * Rows several verdicts ask about, read once and only when one asks: the last turn, the question
 * about credits and the live browser session. Awaited one at a time, as every read of the facts:
 * the client may be an interactive transaction.
 */
function sharedReads(db: Reader, taskId: string, turnNo: number) {
  let turn: Promise<LastTurn | null> | undefined
  let ceiling: ReturnType<typeof openCeilingQuestion> | undefined
  let session: ReturnType<typeof openBrowserSessionOfTask> | undefined
  return {
    turn: () =>
      (turn ??= db.taskTurn.findUnique({
        where: { taskId_turnNo: { taskId, turnNo } },
        select: {
          status: true,
          rejectedAt: true,
          undoneAt: true,
          nativeSessionId: true,
          startedAt: true,
        },
      })),
    ceiling: () => (ceiling ??= openCeilingQuestion(db, taskId)),
    session: () => (session ??= openBrowserSessionOfTask(db, taskId)),
  }
}
type SharedReads = ReturnType<typeof sharedReads>

interface LastTurn {
  status: string
  rejectedAt: Date | null
  undoneAt: Date | null
  nativeSessionId: string | null
  startedAt: Date | null
}

const BUSY: readonly TaskStatus[] = ['queued', 'preparing', 'running']

/**
 * Whether `chatCommandAvailability` looks at the facts of `/compact`: not while the agent works or
 * once the chat has ended — it answers `busy` or `finished` before them then.
 */
const compactAsked = (status: TaskStatus) =>
  !BUSY.includes(status) && !terminalTaskStatuses.includes(status)

/**
 * What the server decides the commands of a chat by (Р34): the reader's role, the browser and the
 * turns of the chat, read with the caller's client — the snapshot of `task.feed` or the transaction
 * of a command. A chat has no repository, candidate, preview or release
 * (docs/plan/83-remove-projects.md, БП2), so the facts of those are always empty.
 */
export async function dialogFacts(
  db: Reader,
  task: FactsTask,
  userId: string,
): Promise<DialogFacts> {
  // One query at a time: the client may be an interactive transaction.
  const role = task.role !== undefined ? task.role : await memberRole(db, task.workspaceId, userId)
  const needs =
    task.needsBrowser !== undefined && task.turnNo !== undefined
      ? { needsBrowser: task.needsBrowser, turnNo: task.turnNo }
      : await db.task.findUnique({
          where: { id: task.id },
          select: { needsBrowser: true, turnNo: true },
        })
  const withBrowser = needs?.needsBrowser ?? false
  const turnNo = needs?.turnNo ?? 0
  const shared = sharedReads(db, task.id, turnNo)
  // Only `/compact` looks at the browser, and only while the chat waits.
  const asked = compactAsked(task.status)
  const agentBrowser = asked ? await agentBrowserRefusal(shared) : null

  return {
    role,
    commands: {
      taskStatus: task.status,
      role: role ?? 'member',
      cancelPending: withBrowser && (await cancelPending(db, task.id)),
      turnUndo: await turnUndoRefusal(db, shared, { taskId: task.id, status: task.status }),
      turnRedo: await turnRedoRefusal(db, shared, { taskId: task.id, status: task.status }),
      compaction: await driverCompacts(db),
      agentBrowser,
      compactRefusal: asked
        ? await compactRefusal(db, shared, { taskId: task.id, turnNo }, agentBrowser)
        : 'nothing_to_compact',
    },
  }
}

/**
 * Whether the driver the platform runs can compact a session: what it says of itself
 * (`AgentCapabilities.compaction`), in its row, for tRPC and web import no driver.
 */
async function driverCompacts(db: Reader): Promise<boolean> {
  const driver = await db.agentDriver.findFirst({
    where: { enabled: true },
    select: { capabilities: true },
  })
  return z.object({ compaction: z.literal(true) }).safeParse(driver?.capabilities).success
}

/**
 * Why a command of the agent runs no turn for the browser of the chat (`agentBrowser`): the agent
 * asked the client to act in it, or the client took it over.
 */
async function agentBrowserRefusal(shared: SharedReads): Promise<AgentBrowserRefusal | null> {
  const session = await shared.session()
  if (session?.helpReason) return 'awaiting_answer'
  return session?.controller === 'user' ? 'browser_with_client' : null
}

/** The rows that say nothing to the agent: a press, or the `/compact` that never got a turn. */
function saysNothing(payload: Prisma.JsonValue): boolean {
  const row = readFeedRow('feed.request', payload)
  if (row.type !== 'feed.request') return false
  if (row.kind === 'agent_command') return row.command === 'compact'
  return row.kind === 'retry' || row.kind === 'continue' || row.kind === 'resume'
}

/**
 * Why `/compact` has no session to shorten now (docs/plan/61-chats-first.md, §5.14). The next turn
 * goes on from the last one only when that completed and stands, so that is the session a
 * compaction resumes. A compaction right after a compaction would pay for the summary of a summary.
 * Words the last turn never saw — their pass ended before it opened a turn — are not in the session,
 * and the next turn would count them as seen: they go first. A question about credits and a request
 * of the agent to act in the browser wait for the client, and a client who took the browser over is
 * at work in it: a compaction answers neither, and its turn would take the browser away. A
 * `/compact` that ended before it opened a turn shortened nothing, so it may be repeated.
 */
async function compactRefusal(
  db: Reader,
  shared: SharedReads,
  chat: { taskId: string; turnNo: number },
  browser: AgentBrowserRefusal | null,
): Promise<CompactRefusal | null> {
  const turn = await shared.turn()
  if (
    turn?.status !== 'completed' ||
    turn.rejectedAt !== null ||
    turn.undoneAt !== null ||
    turn.nativeSessionId === null ||
    turn.startedAt === null
  )
    return 'nothing_to_compact'
  if ((await shared.ceiling()) !== null) return 'awaiting_answer'
  if (browser !== null) return browser
  const compacted = await db.turnAssignment.count({
    where: {
      taskId: chat.taskId,
      turnNo: chat.turnNo,
      plan: { path: ['input', 'action'], equals: 'compact' },
    },
  })
  if (compacted > 0) return 'nothing_to_compact'
  const after = { taskId: chat.taskId, createdAt: { gt: turn.startedAt } }
  const later = await db.taskEvent.findMany({
    where: { ...after, ...movingRequest },
    select: { payload: true },
  })
  return later.every((row) => saysNothing(row.payload)) ? null : 'nothing_to_compact'
}

/**
 * Why `/undo` takes no turn of this chat (docs/plan/61-chats-first.md, §5.14): it takes the last
 * turn, one that completed with its result taken, once, while the chat waits for its next words. A
 * question of the platform about credits holds a pass that has not run, and a request of the agent
 * to act in the browser stands in the live session until the next turn takes it (`reclaim`), with
 * a button that would resume nothing: both are answered first. Words the last turn never saw — their
 * pass failed before it opened a turn — are the last request, and that has no turn to take back:
 * the turn before them would go instead. The browser belongs to the task, and its row says what
 * stays.
 */
async function turnUndoRefusal(
  db: Reader,
  shared: SharedReads,
  chat: { taskId: string; status: TaskStatus },
): Promise<TurnUndoRefusal | null> {
  if (chat.status !== 'awaiting_user' && chat.status !== 'awaiting_approval')
    return 'nothing_to_undo'
  const turn = await shared.turn()
  if (turn?.status !== 'completed' || turn.rejectedAt !== null || turn.undoneAt !== null)
    return 'nothing_to_undo'
  if ((await shared.ceiling()) !== null) return 'awaiting_answer'
  const session = await shared.session()
  if (session?.helpReason) return 'awaiting_answer'
  if (turn.startedAt !== null) {
    const later = await db.taskEvent.count({
      where: { taskId: chat.taskId, ...movingRequest, createdAt: { gt: turn.startedAt } },
    })
    if (later > 0) return 'nothing_to_undo'
  }
  return null
}

/**
 * Why `/redo` brings nothing back (docs/plan/61-chats-first.md, §5.14): it brings back the turn the
 * last `/undo` took, while the chat still stands where that left it. Words, a pass or a command that
 * moves the chat after the `feed.rewind` put something on top of the turn before.
 */
async function turnRedoRefusal(
  db: Reader,
  shared: SharedReads,
  chat: { taskId: string; status: TaskStatus },
): Promise<TurnRedoRefusal | null> {
  if (chat.status !== 'awaiting_user' && chat.status !== 'awaiting_approval')
    return 'nothing_to_redo'
  const turn = await shared.turn()
  if (!turn?.undoneAt) return 'nothing_to_redo'
  const rewind = await db.taskEvent.findFirst({
    where: { taskId: chat.taskId, ...visible, type: 'feed.rewind' },
    orderBy: { id: 'desc' },
    select: { id: true },
  })
  if (rewind === null) return 'nothing_to_redo'
  const after = await db.taskEvent.count({
    where: {
      taskId: chat.taskId,
      id: { gt: rewind.id },
      ...movingRequest,
    },
  })
  return after > 0 ? 'nothing_to_redo' : null
}

/** The verdict of one command. */
export function commandRefusal(
  facts: ChatCommandFacts,
  command: ServerCommandId,
): ChatCommandRefusal | null {
  return chatCommandAvailability(facts).find((item) => item.id === command)?.refusal ?? null
}

/** Throws the refusal of the command, the text `task.commands` shows for it. */
export function assertCommandAvailable(facts: ChatCommandFacts, command: ServerCommandId): void {
  const refusal = commandRefusal(facts, command)
  if (refusal !== null) throw commandUnavailable(command, refusal)
}

/** Every command of the dialog with its verdict. */
export const dialogCommands = (facts: DialogFacts): ChatCommandAvailability[] =>
  chatCommandAvailability(facts.commands)
