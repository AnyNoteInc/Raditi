import { createHash } from 'node:crypto'

import {
  artifactRole,
  attachMentionedArtifacts,
  snapshotArtifactComments,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import { FEED_REQUEST_TEXT_LIMIT } from '@repo/domain'
import {
  artifactCommentDispatchLimits,
  artifactNotFound,
  artifactOpReused,
} from '@repo/domain/artifacts'
import { z } from 'zod'

import { accessibleTasks, taskNotFound } from '../chat/access.ts'
import type { ChatContext } from '../chat/context.ts'
import { dialogMessageTarget } from '../chat/dialog-state.ts'
import { createDialog, postDialogMessage, type DialogRequestBinding } from '../chat/tasks.ts'

const uuid = z.uuid().transform((id) => id.toLowerCase())
export const commentDispatchInput = z.strictObject({
  artifactId: uuid,
  requestId: uuid,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), taskId: uuid }),
    z.strictObject({
      kind: z.literal('new'),
      taskId: z.uuidv7().transform((id) => id.toLowerCase()),
    }),
  ]),
  threadIds: z
    .array(uuid)
    .min(1)
    .max(artifactCommentDispatchLimits.threads)
    .refine((ids) => new Set(ids).size === ids.length)
    .transform((ids) => ids.sort()),
  text: z.string().trim().max(FEED_REQUEST_TEXT_LIMIT),
})

type DispatchInput = z.output<typeof commentDispatchInput>
type Tx = Prisma.TransactionClient

const ownBillableChats = (userId: string) => ({
  ...accessibleTasks(userId),
  createdById: userId,
  billable: true,
})

/** Recent candidates, not an authorization to send. The message writer checks again under lock. */
export async function commentDispatchChats(db: PrismaClient, userId: string, artifactId: string) {
  return db.$transaction(
    async (tx) => {
      if ((await artifactRole(tx, { userId, artifactId })) !== 'owner') throw artifactNotFound()
      const artifact = await tx.artifact.findUniqueOrThrow({
        where: { id: artifactId },
        select: { workspaceId: true },
      })
      const choices: { taskId: string; title: string | null }[] = []
      const batchSize = 40
      let after: string | undefined
      for (;;) {
        const recent = await tx.task.findMany({
          where: {
            ...ownBillableChats(userId),
            workspaceId: artifact.workspaceId,
            status: { in: ['awaiting_user', 'awaiting_approval'] },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: batchSize,
          ...(after === undefined ? {} : { cursor: { id: after }, skip: 1 }),
          select: { id: true, title: true, status: true, needsBrowser: true },
        })
        for (const task of recent) {
          const target = await dialogMessageTarget(tx, task)
          if (target.kind === 'answer' || target.kind === 'ceiling')
            choices.push({ taskId: task.id, title: task.title })
          if (choices.length === 20) return choices
        }
        after = recent.at(-1)?.id
        if (recent.length < batchSize || after === undefined) return choices
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

/** Not just a chat they can open: it must be theirs and billable. */
async function authorizeChat(db: Tx, userId: string, taskId: string) {
  const task = await db.task.findFirst({
    where: { ...ownBillableChats(userId), id: taskId },
    select: { workspaceId: true },
  })
  if (!task) throw taskNotFound()
  return task.workspaceId
}

function dispatchBinding(userId: string, input: DispatchInput, now: Date): DialogRequestBinding {
  const { artifactId, requestId, threadIds, target, text } = input
  const sha256 = createHash('sha256')
    .update(JSON.stringify([artifactId, target.kind, target.taskId, threadIds, text]))
    .digest('hex')
  const key = { userId, requestId }
  const owner = { artifactId, userId }
  return {
    async lock(tx) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`artifact-dispatch:${userId}:${requestId}`}, 0))`
    },
    async authorize(tx, taskId) {
      await authorizeChat(tx, userId, taskId)
    },
    async replay(db) {
      const receipt = await db.artifactCommentDispatchKey.findUnique({
        where: { userId_requestId: key },
        select: {
          snapshot: {
            select: {
              artifactId: true,
              sha256: true,
              requestEventId: true,
              request: { select: { taskId: true } },
            },
          },
        },
      })
      if (!receipt) return null
      const row = receipt.snapshot
      if (!row) throw artifactNotFound()
      const taskId = row.request.taskId
      if ((await artifactRole(db, { userId, artifactId: row.artifactId })) !== 'owner')
        throw artifactNotFound()
      await authorizeChat(db, userId, taskId)
      if (row.sha256 !== sha256) throw artifactOpReused(requestId)
      return { taskId, requestEventId: String(row.requestEventId) }
    },
    async bind(tx, { taskId, workspaceId, requestEventId }) {
      const notes = await snapshotArtifactComments(tx, { ...owner, workspaceId, threadIds })
      await tx.artifactCommentDispatchKey.create({ data: key })
      await tx.artifactCommentDispatch.create({
        data: { ...key, artifactId, requestEventId: BigInt(requestEventId), sha256, notes },
      })
      await tx.taskEvent.update({
        where: { id: BigInt(requestEventId) },
        data: { artifactCommentHasWords: text !== '' },
      })
      await attachMentionedArtifacts(tx, { taskId, artifactIds: [artifactId], now })
    },
    collision: () => artifactOpReused(requestId),
  }
}

export async function dispatchArtifactComments(
  db: PrismaClient,
  chat: ChatContext,
  userId: string,
  raw: z.input<typeof commentDispatchInput>,
  now: Date,
) {
  const input = commentDispatchInput.parse(raw)
  const binding = dispatchBinding(userId, input, now)
  const earlier = await binding.replay(db)
  if (earlier) return { ...earlier, repeated: true }
  if ((await artifactRole(db, { userId, artifactId: input.artifactId })) !== 'owner')
    throw artifactNotFound()

  const { taskId } = input.target
  const text = input.text || 'Заметки к артефакту'
  if (input.target.kind === 'existing') {
    const posted = await postDialogMessage(
      db,
      { userId, taskId, requestId: input.requestId, text, now },
      binding,
    )
    return { taskId, ...posted }
  }
  const artifact = await db.artifact.findUnique({
    where: { id: input.artifactId },
    select: { projectId: true },
  })
  if (!artifact) throw artifactNotFound()
  const created = await createDialog(
    db,
    chat,
    { userId, taskId, projectId: artifact.projectId, text, now },
    binding,
  )
  if (created.requestEventId === undefined) throw new Error('The bound first request has no event')
  return {
    taskId: created.taskId,
    requestEventId: created.requestEventId,
    repeated: !created.created,
  }
}
