import { createHash } from 'node:crypto'

import {
  AGENT_TURN_QUEUE,
  CHAT_DIAGRAM_JOB,
  chatDiagramJobSchema,
  DomainError,
  type ChatDiagramJob,
} from '@repo/domain'
import {
  messageDiagrams,
  normalizeDiagramFor,
  type ArtifactDiagramRenderResponse,
  type DiagramEngine,
  type DiagramView,
} from '@repo/domain/artifacts'

import { keptDiagramView } from './artifact-diagrams.ts'
import { accessibleTasks } from './chat-access.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { enqueueOutbox, type OutboxWriter } from './outbox.ts'

// The pictures of the diagrams in the answers of the chat (docs/plan/91-chat-diagrams.md, Д3–Д5):
// kept by the SHA-256 of the engine and the normalised text within the workspace. The cabinet names
// a row of the feed and the place of a diagram in it — never the text: the server reads the text of
// the answer itself, so the cabinet is no open renderer.

/** The rows of the feed whose `message` is the agent's answer. */
const ANSWER_ROWS = ['feed.result', 'feed.question']

/** The key of a text: the engine and what it would see, hashed. */
function chatDiagramKey(engine: DiagramEngine, source: string): string {
  return createHash('sha256')
    .update(`${engine}\n${normalizeDiagramFor(engine, source)}`)
    .digest('hex')
}

/** A diagram of an answer: its text, its engine, the workspace of its page and its key. */
export interface ChatDiagramSource {
  workspaceId: string
  engine: DiagramEngine
  source: string
  /** `chatDiagramKey` of the text, computed once. */
  key: string
}

/**
 * The diagram at `index` of a row of the chat; null — none. With `userId`, only of a chat that
 * reader may open, in the same query.
 */
export async function chatDiagramSource(
  db: Pick<PrismaClient, 'taskEvent'>,
  job: ChatDiagramJob,
  userId?: string,
): Promise<ChatDiagramSource | null> {
  const row = await db.taskEvent.findFirst({
    where: {
      id: BigInt(job.row),
      taskId: job.taskId,
      clientVisible: true,
      type: { in: ANSWER_ROWS },
      task: userId === undefined ? { deletedAt: null } : accessibleTasks(userId),
    },
    select: { payload: true, task: { select: { workspaceId: true } } },
  })
  const message = (row?.payload as { message?: unknown } | null | undefined)?.message
  if (!row || typeof message !== 'string') return null
  const diagram = messageDiagrams(message)[job.index]
  if (!diagram || diagram.source.trim() === '') return null
  return {
    workspaceId: row.task.workspaceId,
    ...diagram,
    key: chatDiagramKey(diagram.engine, diagram.source),
  }
}

type Db = Pick<PrismaClient, 'chatDiagramRender'>

/** Keeps a picture or an error of a text, once: a second one of the same text is the same. */
export async function saveChatDiagram(
  db: Db,
  input: Pick<ChatDiagramSource, 'workspaceId' | 'engine' | 'key'> & {
    result: ArtifactDiagramRenderResponse
  },
): Promise<void> {
  const { result } = input
  await db.chatDiagramRender.createMany({
    data: [
      {
        workspaceId: input.workspaceId,
        sourceSha256: input.key,
        engine: input.engine,
        ok: result.ok,
        ...(result.ok
          ? { svg: result.svg, width: result.width, height: result.height }
          : { reason: result.reason, errorLine: result.line, errorMessage: result.message }),
      },
    ],
    skipDuplicates: true,
  })
}

/** The kept picture or error of a text; null — none yet. */
export async function chatDiagramOf(db: Db, input: Pick<ChatDiagramSource, 'workspaceId' | 'key'>) {
  return db.chatDiagramRender.findUnique({
    where: {
      workspaceId_sourceSha256: { workspaceId: input.workspaceId, sourceSha256: input.key },
    },
  })
}

/**
 * How long one job of a text stands for it. A job that drew nothing — no browser worker, or its
 * attempts spent while the worker was down — must not leave the diagram undrawn for good: once the
 * window passes, the next ask of the chat puts the job again.
 */
export const CHAT_DIAGRAM_RETRY_MS = 2 * 60_000

/**
 * One job per text of a workspace and window: the same diagram in many answers is drawn once, and
 * asked again after `CHAT_DIAGRAM_RETRY_MS` when it is still not drawn.
 */
async function enqueueChatDiagram(
  tx: OutboxWriter,
  job: ChatDiagramJob,
  key: Pick<ChatDiagramSource, 'workspaceId' | 'key'> & { now: Date },
): Promise<boolean> {
  const payload = chatDiagramJobSchema.parse(job)
  const window = Math.floor(key.now.getTime() / CHAT_DIAGRAM_RETRY_MS)
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: CHAT_DIAGRAM_JOB,
    payload,
    dedupeKey: `${CHAT_DIAGRAM_JOB}:${key.workspaceId}:${key.key}:${window}`,
  })
}

/** What the chat shows of a diagram: for people only the line of an error. */
export type ChatDiagramView = DiagramView

/**
 * The picture of a diagram of an answer for a reader of the chat: kept — shown; none yet — core is
 * asked to draw it, and the chat asks again. A chat the reader may not open, a row that is no answer
 * or a place with no diagram is NOT_FOUND alike.
 */
export async function readChatDiagram(
  db: Pick<PrismaClient, 'taskEvent' | 'chatDiagramRender'> & OutboxWriter,
  input: ChatDiagramJob & { userId: string; now?: Date },
): Promise<ChatDiagramView> {
  const { userId, now = new Date(), ...job } = input
  const diagram = await chatDiagramSource(db, job, userId)
  if (!diagram) throw new DomainError('NOT_FOUND', 'No such diagram in this chat', 404)
  const kept = keptDiagramView(await chatDiagramOf(db, diagram))
  if (kept) return kept
  await enqueueChatDiagram(db, job, { ...diagram, now })
  return { state: 'drawing' }
}
