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
} from '@repo/domain/artifacts'

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
export function chatDiagramKey(engine: DiagramEngine, source: string): string {
  return createHash('sha256')
    .update(`${engine}\n${normalizeDiagramFor(engine, source)}`)
    .digest('hex')
}

/** The diagram at `index` of a row of the chat, with the workspace of its page; null — none. */
export async function chatDiagramSource(
  db: Pick<PrismaClient, 'taskEvent'>,
  job: ChatDiagramJob,
): Promise<{ workspaceId: string; engine: DiagramEngine; source: string } | null> {
  const row = await db.taskEvent.findFirst({
    where: {
      id: BigInt(job.row),
      taskId: job.taskId,
      clientVisible: true,
      type: { in: ANSWER_ROWS },
      task: { deletedAt: null },
    },
    select: { payload: true, task: { select: { workspaceId: true } } },
  })
  const message = (row?.payload as { message?: unknown } | null | undefined)?.message
  if (!row || typeof message !== 'string') return null
  const diagram = messageDiagrams(message)[job.index]
  if (!diagram || diagram.source.trim() === '') return null
  return { workspaceId: row.task.workspaceId, ...diagram }
}

type Db = Pick<PrismaClient, 'chatDiagramRender'>

/** Keeps a picture or an error of a text, once: a second one of the same text is the same. */
export async function saveChatDiagram(
  db: Db,
  input: {
    workspaceId: string
    engine: DiagramEngine
    source: string
    result: ArtifactDiagramRenderResponse
  },
): Promise<void> {
  const { result } = input
  await db.chatDiagramRender.createMany({
    data: [
      {
        workspaceId: input.workspaceId,
        sourceSha256: chatDiagramKey(input.engine, input.source),
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
export async function chatDiagramOf(
  db: Db,
  input: { workspaceId: string; engine: DiagramEngine; source: string },
) {
  return db.chatDiagramRender.findUnique({
    where: {
      workspaceId_sourceSha256: {
        workspaceId: input.workspaceId,
        sourceSha256: chatDiagramKey(input.engine, input.source),
      },
    },
  })
}

/** One job per text of a workspace: the same diagram in many answers is drawn once. */
export async function enqueueChatDiagram(
  tx: OutboxWriter,
  job: ChatDiagramJob,
  key: { workspaceId: string; sourceKey: string },
): Promise<boolean> {
  const payload = chatDiagramJobSchema.parse(job)
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: CHAT_DIAGRAM_JOB,
    payload,
    dedupeKey: `${CHAT_DIAGRAM_JOB}:${key.workspaceId}:${key.sourceKey}`,
  })
}

/** What the chat shows of a diagram: for people only the line of an error. */
export type ChatDiagramView =
  | { state: 'drawing' }
  | { state: 'drawn'; svg: string; width: number; height: number }
  | { state: 'failed'; line: number | null }

/**
 * The picture of a diagram of an answer for a reader of the chat: kept — shown; none yet — core is
 * asked to draw it, and the chat asks again. A chat the reader may not open, a row that is no answer
 * or a place with no diagram is NOT_FOUND alike.
 */
export async function readChatDiagram(
  db: Pick<PrismaClient, 'task' | 'taskEvent' | 'chatDiagramRender'> & OutboxWriter,
  input: ChatDiagramJob & { userId: string },
): Promise<ChatDiagramView> {
  const { userId, ...job } = input
  const task = await db.task.findFirst({
    where: { ...accessibleTasks(userId), id: job.taskId },
    select: { id: true },
  })
  const diagram = task ? await chatDiagramSource(db, job) : null
  if (!diagram) throw new DomainError('NOT_FOUND', 'No such diagram in this chat', 404)
  const kept = await chatDiagramOf(db, diagram)
  if (kept?.ok && kept.svg && kept.width && kept.height)
    return { state: 'drawn', svg: kept.svg, width: kept.width, height: kept.height }
  if (kept && !kept.ok) return { state: 'failed', line: kept.errorLine }
  await enqueueChatDiagram(db, job, {
    workspaceId: diagram.workspaceId,
    sourceKey: chatDiagramKey(diagram.engine, diagram.source),
  })
  return { state: 'drawing' }
}
