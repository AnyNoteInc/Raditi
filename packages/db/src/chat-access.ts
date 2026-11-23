import type { Prisma } from './generated/prisma/client.ts'

/**
 * A chat the user may open: a task of a workspace they are a member of, not deleted itself
 * («Удалить диалог») and not of a project in the trash, where its chats go with it
 * (docs/plan/84-projects.md, ПР20), and of a project only by its author (ПР1). A task of someone
 * else and a task that does not exist answer the same NOT_FOUND.
 */
export const accessibleTasks = (userId: string) =>
  ({
    deletedAt: null,
    workspace: { members: { some: { userId } } },
    // A project is its author's alone (ПР1): another member never drives its chats, nor reads
    // the private code and the memory they carry (ревью, безопасность 9).
    OR: [{ projectId: null }, { project: { deletedAt: null, createdById: userId } }],
  }) satisfies Prisma.TaskWhereInput
