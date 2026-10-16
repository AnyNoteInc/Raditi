import { DomainError, isProduction, type AppEnv } from '@repo/domain'

import type { Prisma, WorkspaceDataClass } from './generated/prisma/client.ts'

/** The name a personal workspace gets when it is created for its user. */
export const PERSONAL_WORKSPACE_NAME = 'Мои проекты'

export interface PersonalWorkspaceOwner {
  userId: string
  /** APP_ENV of the process: it decides the data class of what the user creates. */
  appEnv: AppEnv
}

/**
 * What a user creates themselves holds real client data only in production; in every other
 * environment it is synthetic and needs no provider clearance (spec §16, §18).
 */
export function personalWorkspaceDataClass(appEnv: AppEnv): WorkspaceDataClass {
  return isProduction(appEnv) ? 'client' : 'synthetic'
}

/**
 * Serializes what one user does to their own workspaces across web replicas: the first site
 * and the first payment must end in one workspace. READ COMMITTED sees the previous holder's
 * committed rows after this lock. NO KEY: rows that reference the user (sessions, consents)
 * are not held up. Returns false when the user no longer exists.
 */
export async function lockUserRow(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
): Promise<boolean> {
  const users = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE
  `
  return users.length > 0
}

/**
 * The user's personal workspace: the oldest one they created with the data class of this
 * environment where they are the only member and the owner. Shared or inherited workspaces
 * are never implicitly chosen. null while the user has none.
 */
export function findPersonalWorkspace(
  db: Pick<Prisma.TransactionClient, 'workspace'>,
  { userId, appEnv }: PersonalWorkspaceOwner,
): Promise<{ id: string } | null> {
  return db.workspace.findFirst({
    where: {
      createdById: userId,
      dataClass: personalWorkspaceDataClass(appEnv),
      members: {
        some: { userId, role: 'owner' },
        every: { userId, role: 'owner' },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
}

/**
 * The user's personal workspace, created when they have none: named «Мои проекты», created by
 * the user, who is its only member and its owner. Takes the lock of `lockUserRow` itself, so
 * concurrent callers of one user get one workspace; the transaction must be READ COMMITTED.
 * Throws UNAUTHORIZED when the user no longer exists.
 */
export async function ensurePersonalWorkspace(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'workspace'>,
  owner: PersonalWorkspaceOwner,
): Promise<{ id: string }> {
  if (!(await lockUserRow(tx, owner.userId))) {
    throw new DomainError('UNAUTHORIZED', 'The user no longer exists', 401)
  }
  return (
    (await findPersonalWorkspace(tx, owner)) ??
    (await tx.workspace.create({
      data: {
        name: PERSONAL_WORKSPACE_NAME,
        createdById: owner.userId,
        dataClass: personalWorkspaceDataClass(owner.appEnv),
        members: { create: { userId: owner.userId, role: 'owner' } },
      },
      select: { id: true },
    }))
  )
}
