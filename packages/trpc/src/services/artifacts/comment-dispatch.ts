import { createHash } from 'node:crypto'

import {
  artifactRole,
  attachMentionedArtifacts,
  dataClassesAllow,
  snapshotArtifactComments,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import { FEED_REQUEST_TEXT_LIMIT } from '@repo/domain'
import {
  artifactCommentDispatchLimits,
  artifactNotFound,
  artifactOpReused,
  artifactRoleAtLeast,
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

/**
 * Who may send threads to an agent at all (88.17а): the owner their notes, «Комментирует» and up
 * the threads of all. Which threads — `snapshotArtifactComments` decides under the lock.
 */
async function requireSender(
  db: Parameters<typeof artifactRole>[0],
  userId: string,
  artifactId: string,
) {
  const role = await artifactRole(db, { userId, artifactId })
  if (role === null || !artifactRoleAtLeast(role, 'comment')) throw artifactNotFound()
  return role
}

/** Candidates read at a time, and at most this many looked at for one list of choices. */
const dispatchChatBatch = 40
const dispatchChatScanLimit = 200
const dispatchChatChoices = 20

/**
 * Recent candidates, not an authorization to send: the user's own chats of the artifact's
 * workspace, or — for a recipient — of their own workspaces. The message writer checks again
 * under lock, and the data classes too.
 */
export async function commentDispatchChats(db: PrismaClient, userId: string, artifactId: string) {
  return db.$transaction(
    async (tx) => {
      const role = await requireSender(tx, userId, artifactId)
      const artifact = await tx.artifact.findUniqueOrThrow({
        where: { id: artifactId },
        select: { workspaceId: true },
      })
      const choices: { taskId: string; title: string | null }[] = []
      // Whether a workspace may take the artifact's data, read once per workspace (Ар38).
      const allowed = new Map<string, boolean>()
      const allows = async (workspaceId: string) => {
        let known = allowed.get(workspaceId)
        if (known === undefined) {
          known = await dataClassesAllow(tx, workspaceId, artifact.workspaceId)
          allowed.set(workspaceId, known)
        }
        return known
      }
      let scanned = 0
      let after: string | undefined
      for (;;) {
        const recent = await tx.task.findMany({
          where: {
            ...ownBillableChats(userId),
            ...(role === 'owner' ? { workspaceId: artifact.workspaceId } : {}),
            status: { in: ['awaiting_user', 'awaiting_approval'] },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: dispatchChatBatch,
          ...(after === undefined ? {} : { cursor: { id: after }, skip: 1 }),
          select: { id: true, title: true, status: true, needsBrowser: true, workspaceId: true },
        })
        for (const task of recent) {
          // A workspace that may not take the artifact's data is no choice (Ар38).
          if (!(await allows(task.workspaceId))) continue
          const target = await dialogMessageTarget(tx, task)
          if (target.kind === 'answer' || target.kind === 'ceiling')
            choices.push({ taskId: task.id, title: task.title })
          if (choices.length === dispatchChatChoices) return choices
        }
        after = recent.at(-1)?.id
        scanned += recent.length
        if (recent.length < dispatchChatBatch || after === undefined) return choices
        // Each candidate costs a few reads under the snapshot: a long tail of chats that cannot
        // take a message is cut, not walked to its end. Sending checks the chosen chat anyway.
        if (scanned >= dispatchChatScanLimit) return choices
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
      await requireSender(db, userId, row.artifactId)
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
  const role = await requireSender(db, userId, input.artifactId)

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
  // A recipient's new chat is of their personal workspace, not the owner's project (88.17а).
  const projectId = role === 'owner' ? artifact.projectId : null
  const created = await createDialog(db, chat, { userId, taskId, projectId, text, now }, binding)
  if (created.requestEventId === undefined) throw new Error('The bound first request has no event')
  return {
    taskId: created.taskId,
    requestEventId: created.requestEventId,
    repeated: !created.created,
  }
}
