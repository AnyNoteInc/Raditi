import { openBrowserSessionOfTask, type MemberRole, type Prisma } from '@repo/db'
import {
  chatCommandAvailability,
  readFeedRow,
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
import { cancelPending, movingRequest, openCeilingQuestion } from './dialog-state.ts'
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
 * What the server decides the commands of a chat by (Р34): the reader's role, the browser and the
 * turns of the chat, read with the caller's client — the snapshot of `task.feed` or the transaction
 * of a command. A chat has no repository, candidate, preview or release
 * (docs/plan/83-remove-projects.md, БП2), so the facts of those are always empty.
 */
export async function dialogFacts(
  db: Reader,
  task: { id: string; workspaceId: string; status: TaskStatus },
  userId: string,
): Promise<DialogFacts> {
  // One query at a time: the client may be an interactive transaction.
  const role = await memberRole(db, task.workspaceId, userId)
  const needs = await db.task.findUnique({
    where: { id: task.id },
    select: { needsBrowser: true, turnNo: true },
  })
  const withBrowser = needs?.needsBrowser ?? false
  const agentBrowser = await agentBrowserRefusal(db, task.id)
  const turnNo = needs?.turnNo ?? 0

  return {
    role,
    commands: {
      taskStatus: task.status,
      role: role ?? 'member',
      cancelPending: withBrowser && (await cancelPending(db, task.id)),
      turnUndo: await turnUndoRefusal(db, { taskId: task.id, status: task.status, turnNo }),
      turnRedo: await turnRedoRefusal(db, { taskId: task.id, status: task.status, turnNo }),
      compaction: await driverCompacts(db),
      agentBrowser,
      compactRefusal: await compactRefusal(db, { taskId: task.id, turnNo }, agentBrowser),
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
async function agentBrowserRefusal(
  db: Reader,
  taskId: string,
): Promise<AgentBrowserRefusal | null> {
  const session = await openBrowserSessionOfTask(db, taskId)
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
  chat: { taskId: string; turnNo: number },
  browser: AgentBrowserRefusal | null,
): Promise<CompactRefusal | null> {
  const turn = await db.taskTurn.findUnique({
    where: { taskId_turnNo: { taskId: chat.taskId, turnNo: chat.turnNo } },
    select: {
      status: true,
      rejectedAt: true,
      undoneAt: true,
      nativeSessionId: true,
      startedAt: true,
    },
  })
  if (
    turn?.status !== 'completed' ||
    turn.rejectedAt !== null ||
    turn.undoneAt !== null ||
    turn.nativeSessionId === null ||
    turn.startedAt === null
  )
    return 'nothing_to_compact'
  if ((await openCeilingQuestion(db, chat.taskId)) !== null) return 'awaiting_answer'
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
  chat: { taskId: string; status: TaskStatus; turnNo: number },
): Promise<TurnUndoRefusal | null> {
  if (chat.status !== 'awaiting_user' && chat.status !== 'awaiting_approval')
    return 'nothing_to_undo'
  const turn = await db.taskTurn.findUnique({
    where: { taskId_turnNo: { taskId: chat.taskId, turnNo: chat.turnNo } },
    select: { status: true, rejectedAt: true, undoneAt: true, startedAt: true },
  })
  if (turn?.status !== 'completed' || turn.rejectedAt !== null || turn.undoneAt !== null)
    return 'nothing_to_undo'
  if ((await openCeilingQuestion(db, chat.taskId)) !== null) return 'awaiting_answer'
  const session = await openBrowserSessionOfTask(db, chat.taskId)
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
  chat: { taskId: string; status: TaskStatus; turnNo: number },
): Promise<TurnRedoRefusal | null> {
  if (chat.status !== 'awaiting_user' && chat.status !== 'awaiting_approval')
    return 'nothing_to_redo'
  const turn = await db.taskTurn.findUnique({
    where: { taskId_turnNo: { taskId: chat.taskId, turnNo: chat.turnNo } },
    select: { undoneAt: true },
  })
  if (!turn?.undoneAt) return 'nothing_to_redo'
  const rewind = await db.taskEvent.findFirst({
    where: { taskId: chat.taskId, type: 'feed.rewind' },
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
