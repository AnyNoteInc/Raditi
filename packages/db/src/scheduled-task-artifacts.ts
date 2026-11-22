import { DomainError } from '@repo/domain'
import { artifactNotFound } from '@repo/domain/artifacts'

import { artifactRole } from './artifacts.ts'
import { attachMentionedArtifacts } from './artifact-chats.ts'
import type { Prisma, PrismaClient } from './generated/prisma/client.ts'

// The artifacts a scheduled task names in its window (docs/plan/88-artifacts.md, Ар24, slice
// 88.20б): only the cabinet sets them — the tools `schedule_*` never do. A run without its client
// may change them, beside the client's own artifacts without a project.

type Tx = Prisma.TransactionClient

/** At most this many artifacts a task names. */
export const scheduledTaskArtifactLimit = 10

const scheduleNotFound = () =>
  new DomainError('SCHEDULE_NOT_FOUND', 'No such scheduled task of the user', 404)

/** The user's live task: its workspace and project. */
async function ownSchedule(
  db: Pick<Tx, 'scheduledTask'>,
  input: { userId: string; scheduleId: string },
) {
  const task = await db.scheduledTask.findFirst({
    where: { id: input.scheduleId, createdById: input.userId, deletedAt: null },
    select: { id: true, workspaceId: true, projectId: true },
  })
  if (!task) throw scheduleNotFound()
  return task
}

/** What the window shows: the live artifacts the task names, newest first. */
export async function readScheduledTaskArtifacts(
  db: Pick<PrismaClient, 'scheduledTask' | 'scheduledTaskArtifact'>,
  input: { userId: string; scheduleId: string },
) {
  const task = await ownSchedule(db, input)
  const rows = await db.scheduledTaskArtifact.findMany({
    where: { scheduledTaskId: task.id, artifact: { deletedAt: null, takenDownAt: null } },
    orderBy: { createdAt: 'desc' },
    select: { artifact: { select: { id: true, kind: true, title: true } } },
  })
  return rows.map((row) => row.artifact)
}

/**
 * «Артефакты задачи»: the whole set at once. Each one the user owns, of the task's workspace,
 * personal or of the task's project — what the chat of a run may open. Others are not found.
 */
export async function setScheduledTaskArtifacts(
  db: Pick<PrismaClient, '$transaction'>,
  input: { userId: string; scheduleId: string; artifactIds: readonly string[] },
) {
  const ids = [...new Set(input.artifactIds.map((id) => id.toLowerCase()))]
  if (ids.length > scheduledTaskArtifactLimit)
    throw new DomainError(
      'SCHEDULE_ARTIFACTS_LIMIT',
      `A task names at most ${scheduledTaskArtifactLimit} artifacts`,
      400,
    )
  return db.$transaction(async (tx) => {
    const task = await ownSchedule(tx, input)
    await tx.$queryRaw`SELECT id FROM scheduled_tasks WHERE id = ${task.id}::uuid FOR UPDATE`
    for (const artifactId of ids) {
      const artifact = await tx.artifact.findUnique({
        where: { id: artifactId },
        select: { workspaceId: true, projectId: true, deletedAt: true },
      })
      if (
        !artifact ||
        artifact.deletedAt !== null ||
        artifact.workspaceId !== task.workspaceId ||
        (artifact.projectId !== null && artifact.projectId !== task.projectId) ||
        (await artifactRole(tx, { artifactId, userId: input.userId })) !== 'owner'
      )
        throw artifactNotFound()
    }
    await tx.scheduledTaskArtifact.deleteMany({
      where: { scheduledTaskId: task.id, artifactId: { notIn: ids } },
    })
    await tx.scheduledTaskArtifact.createMany({
      data: ids.map((artifactId) => ({ scheduledTaskId: task.id, artifactId })),
      skipDuplicates: true,
    })
    return { artifactIds: ids }
  })
}

/** The chat of a run is given the artifacts its task names, as the client's mention gives one. */
export async function attachScheduledTaskArtifacts(
  tx: Tx,
  input: { taskId: string; scheduledRunId: string; now: Date },
): Promise<string[]> {
  const run = await tx.scheduledRun.findUnique({
    where: { id: input.scheduledRunId },
    select: { scheduledTask: { select: { artifacts: { select: { artifactId: true } } } } },
  })
  const ids = run?.scheduledTask.artifacts.map((row) => row.artifactId) ?? []
  return attachMentionedArtifacts(tx, { taskId: input.taskId, artifactIds: ids, now: input.now })
}

/** Whether the task of the chat's run names this artifact (Ар24): its run may change it. */
export async function artifactNamedByRun(
  db: Pick<PrismaClient, 'scheduledRun' | 'scheduledTaskArtifact'>,
  input: { taskId: string; artifactId: string },
): Promise<boolean> {
  const run = await db.scheduledRun.findUnique({
    where: { taskId: input.taskId },
    select: { scheduledTaskId: true },
  })
  if (!run) return false
  const named = await db.scheduledTaskArtifact.findUnique({
    where: {
      scheduledTaskId_artifactId: {
        scheduledTaskId: run.scheduledTaskId,
        artifactId: input.artifactId,
      },
    },
    select: { artifactId: true },
  })
  return named !== null
}
