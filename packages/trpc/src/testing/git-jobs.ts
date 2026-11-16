import type { PrismaClient } from '@repo/db'

// The jobs of the queue `git` a database test queued (docs/plan/84-projects.md, slices 84.17–84.22).
// The files of the suite share one base and run at the same time: each test reads and removes only
// the events whose payload names its own workspaces — their connections, repositories, presses and
// chats —, never every event of the topic.

const ownSql = `
  WITH own AS (
    SELECT id::text FROM git_connections WHERE workspace_id = ANY($1::uuid[])
    UNION ALL SELECT id::text FROM project_repositories WHERE workspace_id = ANY($1::uuid[])
    UNION ALL SELECT id::text FROM tasks WHERE workspace_id = ANY($1::uuid[])
    UNION ALL SELECT a.id::text FROM repo_actions a
      JOIN project_repositories r ON r.id = a.project_repository_id
      WHERE r.workspace_id = ANY($1::uuid[])
  )
  SELECT o.id::text AS id FROM outbox_events o
  WHERE o.topic = 'git' AND (
    o.payload->>'connectionId' IN (SELECT id FROM own) OR
    o.payload->>'projectRepositoryId' IN (SELECT id FROM own) OR
    o.payload->>'actionId' IN (SELECT id FROM own) OR
    o.payload->>'taskId' IN (SELECT id FROM own)
  )`

/** The ids of the `git` events of these workspaces. */
async function ownIds(db: PrismaClient, workspaceIds: readonly string[]): Promise<string[]> {
  if (workspaceIds.length === 0) return []
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(ownSql, [...workspaceIds])
  return rows.map((row) => row.id)
}

/** The `git` events of these workspaces, oldest first. */
export async function gitJobsOf(
  db: PrismaClient,
  workspaceIds: readonly string[],
  type?: string,
): Promise<{ type: string; payload: unknown }[]> {
  const ids = await ownIds(db, workspaceIds)
  if (ids.length === 0) return []
  const rows = await db.outboxEvent.findMany({
    where: { id: { in: ids }, ...(type ? { type } : {}) },
    orderBy: { createdAt: 'asc' },
    select: { type: true, payload: true },
  })
  return rows
}

/** Removes the `git` events of these workspaces (before their rows go). */
export async function dropGitJobsOf(
  db: PrismaClient,
  workspaceIds: readonly string[],
): Promise<void> {
  const ids = await ownIds(db, workspaceIds)
  if (ids.length === 0) return
  await db.outboxEvent.deleteMany({ where: { id: { in: ids } } })
}
