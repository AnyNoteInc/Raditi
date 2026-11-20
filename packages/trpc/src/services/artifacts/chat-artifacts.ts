import { artifactRole, type PrismaClient } from '@repo/db'
import { DomainError } from '@repo/domain'

import { accessibleTask } from '../chat/access.ts'

// The artifacts of a chat beside it (docs/plan/88-artifacts.md, Ар44, Ар46; slice 88.11): the menu
// «+», the tabs and «Результаты» name them by group — made here (created or edited by its turns),
// mentioned in it (attached, or named by the client with `@artifact:<id>`), of its project. Only
// what the reader may read: its role on each artifact, as every path asks it (Ар37).

export type ChatArtifactGroup = 'made' | 'mentioned' | 'project'

const groupOf = (how: string): ChatArtifactGroup | null =>
  how === 'created' || how === 'edited'
    ? 'made'
    : how === 'mentioned' || how === 'attached'
      ? 'mentioned'
      : null

export async function chatArtifactsOf(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<
  { id: string; kind: string; title: string; version: number; group: ChatArtifactGroup }[]
> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true, projectId: true },
  })
  if (!task) throw new DomainError('NOT_FOUND', 'No such chat', 404)
  const live = { deletedAt: null, takenDownAt: null }
  const [links, project] = await Promise.all([
    db.artifactChat.findMany({
      where: { taskId: task.id, artifact: live },
      orderBy: { firstAt: 'asc' },
      select: {
        how: true,
        artifact: { select: { id: true, kind: true, title: true, currentVersion: true } },
      },
    }),
    task.projectId
      ? db.artifact.findMany({
          where: { projectId: task.projectId, ...live },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: 30,
          select: { id: true, kind: true, title: true, currentVersion: true },
        })
      : Promise.resolve([]),
  ])
  const rows: {
    id: string
    kind: string
    title: string
    version: number
    group: ChatArtifactGroup
  }[] = []
  const seen = new Set<string>()
  const add = async (
    artifact: { id: string; kind: string; title: string; currentVersion: number },
    group: ChatArtifactGroup,
  ) => {
    if (seen.has(artifact.id)) return
    seen.add(artifact.id)
    if ((await artifactRole(db, { artifactId: artifact.id, userId: input.userId })) === null) return
    rows.push({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      version: artifact.currentVersion,
      group,
    })
  }
  for (const link of links) {
    const group = groupOf(link.how)
    if (group !== null) await add(link.artifact, group)
  }
  for (const artifact of project) await add(artifact, 'project')
  return rows
}
