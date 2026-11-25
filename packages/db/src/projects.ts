import {
  compareProjects,
  projectArchived,
  projectNotFound,
  projectNotInTrash,
  projectPurgeAfter,
  taskProjectBusy,
  taskProjectHasBranch,
  type ProjectListSort,
  type ProjectListView,
} from '@repo/domain'

import { restoreProjectArtifacts, trashProjectArtifacts } from './artifacts.ts'
import type { Prisma, PrismaClient, TaskStatus } from './generated/prisma/client.ts'
import { lockProjectChats, stopProjectChats } from './project-trash.ts'
import { chatHasRepoBranch } from './repo-work.ts'
import { lockProjectSchedules, pauseProjectSchedules } from './scheduled-tasks.ts'

// The projects of a workspace (docs/plan/84-projects.md, ПР1, ПР2, ПР4, ПР20; slice 84.3). Only the
// author of a project sees and changes it, while they are a member of its workspace: every
// function here takes the user and answers PROJECT_NOT_FOUND for any project of someone else, one
// that does not exist, and — but for the trash and «Вернуть» — one in the trash. Words are checked
// by the domain (`projectNameOf`, `projectGoalOf`) before they come here.

type Tx = Prisma.TransactionClient

/** What a caller reads of a project it acts on. */
export interface OwnedProject {
  id: string
  workspaceId: string
  name: string
  archivedAt: Date | null
  deletedAt: Date | null
  purgeAfter: Date | null
}

const owned = {
  id: true,
  workspaceId: true,
  name: true,
  archivedAt: true,
  deletedAt: true,
  purgeAfter: true,
} as const

/** The projects of `userId`: theirs, in a workspace they are a member of (ПР1). */
const ofUser = (userId: string) =>
  ({
    createdById: userId,
    workspace: { members: { some: { userId } } },
  }) satisfies Prisma.ProjectWhereInput

/**
 * The project, when `userId` is its author and a member of its workspace; null otherwise. A project
 * in the trash is found only with `deleted: true` — for «Вернуть» and the trash itself.
 */
export function projectOwnedBy(
  db: Pick<Tx, 'project'>,
  projectId: string,
  userId: string,
  options: { deleted?: boolean } = {},
): Promise<OwnedProject | null> {
  return db.project.findFirst({
    where: { id: projectId, ...ofUser(userId), ...(options.deleted ? {} : { deletedAt: null }) },
    select: owned,
  })
}

/**
 * The live project of `userId` a chat may start in, or go into (ПР2, ПР20, ПР30): PROJECT_NOT_FOUND
 * for none, PROJECT_ARCHIVED for one in «Архив».
 */
export async function projectForChat(
  db: Pick<Tx, 'project'>,
  projectId: string,
  userId: string,
): Promise<OwnedProject> {
  const project = await projectOwnedBy(db, projectId, userId)
  if (project === null) throw projectNotFound()
  if (project.archivedAt !== null) throw projectArchived()
  return project
}

export interface ProjectCreation {
  /** UUID v7 from the browser: a repeat returns the same project (ПР1). */
  id: string
  workspaceId: string
  userId: string
  name: string
  goal: string | null
  now: Date
}

/**
 * A new project in a workspace of its author. A repeat with the same id by the same author returns
 * `created: false`; an id taken by anything else — someone else's project, or one in the trash — is
 * PROJECT_NOT_FOUND, and the caller learns nothing of it.
 */
export async function createProject(
  tx: Tx,
  input: ProjectCreation,
): Promise<{ projectId: string; created: boolean }> {
  const { count } = await tx.project.createMany({
    data: [
      {
        id: input.id,
        workspaceId: input.workspaceId,
        createdById: input.userId,
        name: input.name,
        goal: input.goal,
        activityAt: input.now,
        createdAt: input.now,
      },
    ],
    skipDuplicates: true,
  })
  if (count === 1) return { projectId: input.id, created: true }
  const earlier = await tx.project.findUnique({
    where: { id: input.id },
    select: { createdById: true, deletedAt: true },
  })
  if (earlier === null || earlier.createdById !== input.userId || earlier.deletedAt !== null)
    throw projectNotFound()
  return { projectId: input.id, created: false }
}

/** A project as its page reads it. */
export interface ProjectView {
  id: string
  workspaceId: string
  name: string
  goal: string | null
  instructions: string | null
  useAccountMemory: boolean
  starred: boolean
  archived: boolean
  /** Its chats that are shown: not deleted. */
  chats: number
  activityAt: Date
  createdAt: Date
}

/** The live project of `userId`; PROJECT_NOT_FOUND for any other. */
export async function readProject(
  db: Pick<Tx, 'project'>,
  input: { projectId: string; userId: string },
): Promise<ProjectView> {
  const row = await db.project.findFirst({
    where: { id: input.projectId, ...ofUser(input.userId), deletedAt: null },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      goal: true,
      instructions: true,
      useAccountMemory: true,
      starredAt: true,
      archivedAt: true,
      activityAt: true,
      createdAt: true,
      _count: { select: { tasks: { where: { deletedAt: null } } } },
    },
  })
  if (row === null) throw projectNotFound()
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    goal: row.goal,
    instructions: row.instructions,
    useAccountMemory: row.useAccountMemory,
    starred: row.starredAt !== null,
    archived: row.archivedAt !== null,
    chats: row._count.tasks,
    activityAt: row.activityAt,
    createdAt: row.createdAt,
  }
}

/** A row of the list of projects (ПР4). */
export interface ProjectListRow {
  id: string
  name: string
  goal: string | null
  starred: boolean
  archived: boolean
  chats: number
  /** It has instructions: the menu of the field says what the agent will take (ПР30). */
  hasInstructions: boolean
  activityAt: Date
  createdAt: Date
  /** When a project of the trash is purged; null outside it. */
  purgeAfter: Date | null
}

/** `%` and `_` of the client's words are letters, not patterns. */
const containsWords = (words: string) => words.replace(/[\\%_]/g, (sign) => `\\${sign}`)

/**
 * The projects of `userId` in a tab of the list (ПР4): «Все» — the live ones out of «Архив»,
 * «Избранное» — the starred among them, «Архив», «Корзина» (the trash, the soonest purged first:
 * a project whose day came at `now` — «Удалить навсегда» or its 30 days, ПР38 — is no longer in it,
 * core purges it). `query` finds the words in the name or the goal, in any case. The order is the
 * domain's (`compareProjects`): the number of projects is not bounded (ПР21), but they are a
 * person's own.
 */
export async function listProjects(
  db: Pick<Tx, 'project'>,
  input: {
    userId: string
    view?: ProjectListView
    sort?: ProjectListSort
    query?: string
    now?: Date
  },
): Promise<ProjectListRow[]> {
  const view = input.view ?? 'all'
  const where: Prisma.ProjectWhereInput = {
    ...ofUser(input.userId),
    ...(view === 'trash'
      ? { deletedAt: { not: null }, purgeAfter: { gt: input.now ?? new Date() } }
      : view === 'archive'
        ? { deletedAt: null, archivedAt: { not: null } }
        : view === 'starred'
          ? { deletedAt: null, archivedAt: null, starredAt: { not: null } }
          : { deletedAt: null, archivedAt: null }),
  }
  const words = input.query?.replace(/\s+/gu, ' ').trim() ?? ''
  if (words !== '') {
    const contains = containsWords(words)
    where.OR = [
      { name: { contains, mode: 'insensitive' } },
      { goal: { contains, mode: 'insensitive' } },
    ]
  }
  const rows = await db.project.findMany({
    where,
    select: {
      id: true,
      name: true,
      goal: true,
      instructions: true,
      starredAt: true,
      archivedAt: true,
      purgeAfter: true,
      activityAt: true,
      createdAt: true,
      _count: { select: { tasks: { where: { deletedAt: null } } } },
    },
  })
  const order = compareProjects(input.sort ?? 'recent')
  rows.sort((a, b) =>
    view === 'trash' && a.purgeAfter !== null && b.purgeAfter !== null
      ? a.purgeAfter.getTime() - b.purgeAfter.getTime() || order(a, b)
      : order(a, b),
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    goal: row.goal,
    starred: row.starredAt !== null,
    archived: row.archivedAt !== null,
    chats: row._count.tasks,
    hasInstructions: row.instructions !== null,
    activityAt: row.activityAt,
    createdAt: row.createdAt,
    purgeAfter: row.purgeAfter,
  }))
}

/** The change of a live project of `userId`; PROJECT_NOT_FOUND for any other. */
async function changeProject(
  db: Pick<Tx, 'project'>,
  input: { projectId: string; userId: string },
  data: Prisma.ProjectUpdateManyMutationInput,
): Promise<void> {
  const { count } = await db.project.updateMany({
    where: { id: input.projectId, ...ofUser(input.userId), deletedAt: null },
    data,
  })
  if (count !== 1) throw projectNotFound()
}

/** «Переименовать», the goal and «Память аккаунта» (ПР5, ПР18): a change counts as activity. */
export function updateProject(
  db: Pick<Tx, 'project'>,
  input: {
    projectId: string
    userId: string
    name?: string
    goal?: string | null
    useAccountMemory?: boolean
    now: Date
  },
): Promise<void> {
  return changeProject(db, input, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.useAccountMemory === undefined ? {} : { useAccountMemory: input.useAccountMemory }),
    activityAt: input.now,
  })
}

/** The instructions of the project (ПР7); null takes them away. */
export function setProjectInstructions(
  db: Pick<Tx, 'project'>,
  input: { projectId: string; userId: string; instructions: string | null; now: Date },
): Promise<void> {
  return changeProject(db, input, { instructions: input.instructions, activityAt: input.now })
}

/** «В избранное» / «Убрать из избранного». */
export function starProject(
  db: Pick<Tx, 'project'>,
  input: { projectId: string; userId: string; starred: boolean; now: Date },
): Promise<void> {
  return changeProject(db, input, { starredAt: input.starred ? input.now : null })
}

/**
 * «В архив» / «Из архива» (ПР20): the chats stay, a new chat does not start in it. «В архив» stops
 * the scheduled tasks of the project in the same transaction (ПР19, `project_gone`): its tasks are
 * locked first, then its row FOR UPDATE, the order a change of a task takes them in. «Из архива»
 * turns none on again — the client does.
 */
export async function archiveProject(
  db: PrismaClient,
  input: { projectId: string; userId: string; archived: boolean; now: Date },
): Promise<void> {
  if (!input.archived) return changeProject(db, input, { archivedAt: null })
  await db.$transaction(async (tx) => {
    await lockProjectSchedules(tx, input.projectId)
    await lockProjectRow(tx, input.projectId)
    await changeProject(tx, input, { archivedAt: input.now })
    await pauseProjectSchedules(tx, input.projectId)
  })
}

/** The row of a project FOR UPDATE: a task being turned on in it (FOR KEY SHARE) waits. */
async function lockProjectRow(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`
}

/**
 * «Удалить» (ПР20): the project goes into the trash for 30 days with its chats, which the cabinet
 * no longer shows. A project already there keeps its day of purging. In the same transaction its
 * chats whose pass is queued or runs are stopped, as «Удалить диалог» stops one (slice 84.5): the
 * press of `cancel` by the author and `turn.cancel` for core. A chat that waits for its client
 * stays as it is — it does nothing, and «Вернуть» gives it back open. The scheduled tasks of the
 * project stop with them (ПР19, `project_gone`): locked after the chats and before the project.
 */
export async function trashProject(
  db: PrismaClient,
  input: { projectId: string; userId: string; now: Date },
): Promise<{ purgeAfter: Date }> {
  const project = await projectOwnedBy(db, input.projectId, input.userId, { deleted: true })
  if (project === null) throw projectNotFound()
  if (project.purgeAfter !== null) return { purgeAfter: project.purgeAfter }
  const purgeAfter = projectPurgeAfter(input.now)
  const trashed = await db.$transaction(async (tx) => {
    // The chats before the project: the order a pass locks them in (lockProjectChats); the tasks
    // before it too, the order a change of a task takes them in (ПР19).
    const chats = await lockProjectChats(tx, project.id)
    await lockProjectSchedules(tx, project.id)
    await lockProjectRow(tx, project.id)
    const { count } = await tx.project.updateMany({
      where: { id: project.id, deletedAt: null },
      data: { deletedAt: input.now, purgeAfter },
    })
    // Deleted meanwhile by another request of the author: it stopped the chats, its day stands.
    if (count !== 1) return false
    await stopProjectChats(tx, { chats, statuses: projectBusyStatuses, authorId: input.userId })
    await pauseProjectSchedules(tx, project.id)
    // Its artifacts go with it, marked as the project's (docs/plan/88-artifacts.md, Ар42).
    await trashProjectArtifacts(tx, {
      projectId: project.id,
      userId: input.userId,
      now: input.now,
      purgeAfter,
    })
    return true
  })
  if (trashed) return { purgeAfter }
  return trashProject(db, input)
}

/**
 * «Вернуть» (ПР20): back from the trash, until the day it is purged — with the artifacts its
 * «Удалить» put there, not those the owner trashed before (Ар42).
 */
export async function restoreProject(
  db: Pick<PrismaClient, 'project' | '$transaction'>,
  input: { projectId: string; userId: string; now: Date },
): Promise<void> {
  const project = await projectOwnedBy(db, input.projectId, input.userId, { deleted: true })
  if (project === null) throw projectNotFound()
  if (project.deletedAt === null) return
  await db.$transaction(async (tx) => {
    await lockProjectRow(tx, project.id)
    const { count } = await tx.project.updateMany({
      where: { id: project.id, deletedAt: { not: null }, purgeAfter: { gt: input.now } },
      data: { deletedAt: null, purgeAfter: null, activityAt: input.now },
    })
    if (count !== 1) throw projectNotFound()
    await restoreProjectArtifacts(tx, {
      projectId: project.id,
      userId: input.userId,
      now: input.now,
    })
  })
}

/**
 * «Удалить навсегда» (ПР38): a project of the trash goes now, not on its day — its day becomes the
 * moment it went into the trash (`purge_after = deleted_at`). That moment is earlier than the clock
 * of any «Вернуть», which only returns a project whose day is still ahead: a «Вернуть» that read
 * its clock before this press and writes after it is refused too. From then on the project is out
 * of «Корзина», and core purges it the way it purges a project whose 30 days are over
 * (`ProjectTrash.purge`, within a minute): the files, the chats, the scheduled tasks, the memory and
 * the mirror of the repository. A repeat, or a project whose day came already, changes nothing
 * until core purged it — then it is PROJECT_NOT_FOUND. PROJECT_NOT_IN_TRASH — «Вернуть» came first.
 */
export async function purgeProjectNow(
  db: Pick<Tx, 'project' | '$executeRaw'>,
  input: { projectId: string; userId: string; now: Date },
): Promise<void> {
  const project = await projectOwnedBy(db, input.projectId, input.userId, { deleted: true })
  if (project === null) throw projectNotFound()
  if (project.purgeAfter === null) throw projectNotInTrash()
  if (project.purgeAfter <= input.now) return
  const changed = await db.$executeRaw`
    UPDATE projects SET purge_after = deleted_at
    WHERE id = ${project.id}::uuid AND deleted_at IS NOT NULL AND purge_after > ${input.now}`
  // Changed meanwhile — «Вернуть», another press, or core purged it: read it again.
  if (changed !== 1) return purgeProjectNow(db, input)
}

/** A new chat, the end of a pass: the project rises in «Недавние». */
export async function touchProjectActivity(
  db: Pick<Tx, 'project'>,
  projectId: string,
  now: Date,
): Promise<void> {
  await db.project.updateMany({
    where: { id: projectId, activityAt: { lt: now } },
    data: { activityAt: now },
  })
}

/** The statuses in which a pass of a chat is queued or runs: its project does not change (ПР2). */
export const projectBusyStatuses: readonly TaskStatus[] = ['queued', 'preparing', 'running']

/**
 * «Перенести в проект…» and «Убрать из проекта» (ПР2) of a chat the caller locked (the lock under
 * which the next message queues it). TASK_PROJECT_BUSY while a pass of the chat is queued or runs:
 * `mcp` reads the scope of a turn from the database on every call. The project must be a live one
 * of the user, out of «Архив», in the chat's own workspace — a project of another workspace is
 * PROJECT_NOT_FOUND here, and the trigger `tasks_project_workspace` refuses it below. The order of
 * the chat in the list does not change.
 */
export async function moveChatToProject(
  tx: Tx,
  input: {
    task: { id: string; workspaceId: string; status: TaskStatus }
    projectId: string | null
    userId: string
    now: Date
  },
): Promise<{ projectId: string | null; moved: boolean }> {
  const { task, projectId } = input
  const current = await tx.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { projectId: true },
  })
  if (current.projectId === projectId) return { projectId, moved: false }
  if (projectBusyStatuses.includes(task.status)) throw taskProjectBusy()
  // The agent worked in the repository of the project from this chat (ПР2): its branch and its
  // commits belong to that repository, so the chat stays where it is.
  if (await chatHasRepoBranch(tx, task.id)) throw taskProjectHasBranch()
  if (projectId !== null) {
    const project = await projectForChat(tx, projectId, input.userId)
    if (project.workspaceId !== task.workspaceId) throw projectNotFound()
  }
  // SQL, not the model: a move leaves `updated_at` — the order of the list — as the chat's own work
  // left it.
  await tx.$executeRaw`UPDATE tasks SET project_id = ${projectId}::uuid WHERE id = ${task.id}::uuid`
  if (projectId !== null) await touchProjectActivity(tx, projectId, input.now)
  return { projectId, moved: true }
}
