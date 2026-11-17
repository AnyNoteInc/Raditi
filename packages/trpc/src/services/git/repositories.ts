import { randomUUID } from 'node:crypto'

import {
  enqueueOutbox,
  enqueueRepoGone,
  repoHookSelect,
  lockProjectChats,
  pauseAgentSchedulesForRepository,
  projectOwnedBy,
  type Prisma,
  type PrismaClient,
} from '@repo/db'
import {
  gitConnectionNotReady,
  gitConnectionProviders,
  gitJobNames,
  gitConnectionReasonText,
  isGitConnectionReason,
  parseRepositoryLink,
  projectArchived,
  projectHasRepository,
  projectNotFound,
  repoBranchSchema,
  repoNotInConnection,
  repoRefusalTexts,
  repoSecretsFoundPaths,
  repoWebUrl,
  taskProjectBusy,
  type GitConnectionKind,
  type RepoMirrorState,
  type RepoMode,
  type RepoProviderKind,
} from '@repo/domain'

import { WRITE } from '../chat/dialog-lock.ts'
import { connectionOf, ownConnection, type GitServices } from './connections.ts'

// The repository of a project (docs/plan/84-projects.md, ПР9, ПР10, §4.4; slice 84.17): one, by an
// open link (read only, no connection) or by a connection of the author (read and write). The row
// is written `syncing` with the job of core that reads it — the provider's size, the first fetch,
// gitleaks — in one transaction; the cabinet reads its state. A link to a private repository ends
// `unreachable`, which the client reads as REPO_LINK_PRIVATE.

type Tx = Prisma.TransactionClient

/** Statuses of a chat during which the repository is not taken away (ПР32). */
const busyStatuses = new Set(['queued', 'preparing', 'running'])

export interface ProjectRepoView {
  id: string
  provider: RepoProviderKind
  host: string
  path: string
  webUrl: string
  defaultBranch: string
  mode: RepoMode
  mirrorState: RepoMirrorState
  /** The connection it reads through; null for an open link. */
  connection: { id: string; kind: GitConnectionKind; login: string; state: string } | null
  /** Why it is not ready, in the client's words; null while it syncs or when it is ready. */
  refusal: { code: string; message: string } | null
  /** Files of the main branch that look like a password or a key (ПР12): paths only. */
  secretsFound: string[]
  fetchedAt: Date | null
}

const viewSelect = {
  id: true,
  provider: true,
  host: true,
  path: true,
  webUrl: true,
  defaultBranch: true,
  mode: true,
  mirrorState: true,
  secretsFound: true,
  fetchedAt: true,
  connection: {
    select: { id: true, kind: true, accountLogin: true, state: true, stateReason: true },
  },
} as const

type ViewRow = Prisma.ProjectRepositoryGetPayload<{ select: typeof viewSelect }>

function refusalOf(row: ViewRow): ProjectRepoView['refusal'] {
  if (
    row.connection !== null &&
    row.connection.state !== 'ok' &&
    row.connection.state !== 'checking'
  ) {
    const reason = row.connection.stateReason ?? 'reauth'
    // The words name the provider of the connection's own kind (rule 8: a table, never a
    // comparison); a reason of another version of the code reads as a sign-in to renew.
    return {
      code: 'GIT_CONNECTION_REAUTH',
      message: gitConnectionReasonText(
        isGitConnectionReason(reason) ? reason : 'reauth',
        row.connection.kind as GitConnectionKind,
      ),
    }
  }
  if (row.mirrorState === 'unreachable')
    return { code: 'REPO_LINK_PRIVATE', message: repoRefusalTexts.REPO_LINK_PRIVATE }
  if (row.mirrorState === 'too_large')
    return { code: 'REPO_TOO_LARGE', message: repoRefusalTexts.REPO_TOO_LARGE }
  if (row.mirrorState === 'failed')
    return {
      code: 'REPO_FETCH_FAILED',
      message: 'Не удалось получить репозиторий — нажмите «Обновить» или попробуйте позже',
    }
  return null
}

const viewOf = (row: ViewRow): ProjectRepoView => ({
  id: row.id,
  provider: row.provider as RepoProviderKind,
  host: row.host,
  path: row.path,
  webUrl: row.webUrl,
  defaultBranch: row.defaultBranch,
  mode: row.mode as RepoMode,
  mirrorState: row.mirrorState as RepoMirrorState,
  connection:
    row.connection === null
      ? null
      : {
          id: row.connection.id,
          kind: row.connection.kind as GitConnectionKind,
          login: row.connection.accountLogin,
          state: row.connection.state,
        },
  refusal: refusalOf(row),
  secretsFound: repoSecretsFoundPaths(row.secretsFound),
  fetchedAt: row.fetchedAt,
})

/** The repository of a project the user owns, or null. */
export async function readProjectRepo(
  db: Pick<Tx, 'project' | 'projectRepository'>,
  input: { userId: string; projectId: string },
): Promise<ProjectRepoView | null> {
  if ((await projectOwnedBy(db, input.projectId, input.userId)) === null) throw projectNotFound()
  const row = await db.projectRepository.findUnique({
    where: { projectId: input.projectId },
    select: viewSelect,
  })
  return row === null ? null : viewOf(row)
}

async function liveProject(tx: Tx, userId: string, projectId: string) {
  const project = await projectOwnedBy(tx, projectId, userId)
  if (project === null) throw projectNotFound()
  if (project.archivedAt !== null) throw projectArchived()
  // The row of the project, locked: two attaches of one project are one after the other.
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`
  if ((await tx.projectRepository.count({ where: { projectId } })) > 0) throw projectHasRepository()
  return project
}

function enqueueAttach(tx: Pick<Tx, 'outboxEvent'>, projectRepositoryId: string) {
  return enqueueOutbox(tx, {
    topic: 'git',
    type: gitJobNames.repoAttach,
    payload: { projectRepositoryId },
    dedupeKey: `git.repo.attach:${projectRepositoryId}:${Math.floor(Date.now() / 10_000)}`,
  })
}

/**
 * The repository an open link names (ПР9): parsed, its host checked (§4.6) — then written with the
 * project, read only, for core to read anonymously. Used by `projectRepo.attach` and by
 * `project.create({ publicRepositoryUrl })`.
 */
export async function checkedLink(services: GitServices, link: string) {
  const ref = parseRepositoryLink(link)
  await services.checkHost(ref.host)
  return ref
}

export async function attachLinkInTransaction(
  tx: Tx,
  input: {
    projectId: string
    workspaceId: string
    ref: { provider: RepoProviderKind; host: string; path: string }
  },
): Promise<{ projectRepositoryId: string }> {
  const id = randomUUID()
  await tx.projectRepository.create({
    data: {
      id,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      connectionId: null,
      provider: input.ref.provider,
      host: input.ref.host,
      path: input.ref.path,
      webUrl: repoWebUrl(input.ref),
      // The main branch of a link is the provider's: core writes it with the first fetch.
      defaultBranch: 'main',
      mode: 'read',
    },
  })
  await enqueueAttach(tx, id)
  return { projectRepositoryId: id }
}

export async function attachLink(
  db: PrismaClient,
  services: GitServices,
  input: { userId: string; projectId: string; publicUrl: string },
): Promise<{ projectRepositoryId: string }> {
  const ref = await checkedLink(services, input.publicUrl)
  return db.$transaction(async (tx) => {
    await pauseAgentSchedulesForRepository(tx, input.projectId)
    const project = await liveProject(tx, input.userId, input.projectId)
    return attachLinkInTransaction(tx, {
      projectId: project.id,
      workspaceId: project.workspaceId,
      ref,
    })
  }, WRITE)
}

/**
 * A repository of a connection of the author (P-git-repo-pick): only their own connection, in the
 * workspace of the project, and only a repository core listed for it (ПР10).
 */
export async function attachConnected(
  db: PrismaClient,
  input: {
    userId: string
    projectId: string
    connectionId: string
    providerRepoId: string
    defaultBranch: string
  },
): Promise<{ projectRepositoryId: string }> {
  if (!repoBranchSchema.safeParse(input.defaultBranch).success) throw repoNotInConnection()
  return db.$transaction(async (tx) => {
    await pauseAgentSchedulesForRepository(tx, input.projectId)
    const project = await liveProject(tx, input.userId, input.projectId)
    const connection = await tx.gitConnection.findFirst({
      where: {
        id: input.connectionId,
        workspaceId: project.workspaceId,
        ...ownConnection(input.userId),
      },
      select: { id: true, kind: true, host: true, state: true },
    })
    // Another user's connection, or one of another workspace, is as one that does not exist.
    if (connection === null) throw repoNotInConnection()
    if (connection.state !== 'ok') throw gitConnectionNotReady()
    const repo = await tx.gitConnectionRepository.findUnique({
      where: {
        connectionId_providerRepoId: {
          connectionId: connection.id,
          providerRepoId: input.providerRepoId,
        },
      },
      select: { path: true, defaultBranch: true, branches: true, canPush: true },
    })
    if (repo === null) throw repoNotInConnection()
    const known = Array.isArray(repo.branches) ? (repo.branches as unknown[]) : []
    if (input.defaultBranch !== repo.defaultBranch && !known.includes(input.defaultBranch))
      throw repoNotInConnection()
    const ref = {
      provider: gitConnectionProviders[connection.kind as GitConnectionKind],
      host: connection.host,
      path: repo.path,
    }
    const id = randomUUID()
    await tx.projectRepository.create({
      data: {
        id,
        projectId: project.id,
        workspaceId: project.workspaceId,
        connectionId: connection.id,
        provider: ref.provider,
        host: ref.host,
        providerRepoId: input.providerRepoId,
        path: ref.path,
        webUrl: repoWebUrl(ref),
        defaultBranch: input.defaultBranch,
        mode: repo.canPush ? 'write' : 'read',
      },
    })
    await enqueueAttach(tx, id)
    return { projectRepositoryId: id }
  }, WRITE)
}

/** «Обновить» of a repository that failed: core reads it again. */
export async function retryAttach(
  db: PrismaClient,
  input: { userId: string; projectId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const project = await projectOwnedBy(tx, input.projectId, input.userId)
    if (project === null) throw projectNotFound()
    const row = await tx.projectRepository.findUnique({
      where: { projectId: project.id },
      select: { id: true },
    })
    if (row === null) throw projectNotFound()
    await tx.projectRepository.update({ where: { id: row.id }, data: { mirrorState: 'syncing' } })
    await enqueueAttach(tx, row.id)
  }, WRITE)
}

/** «Отключить репозиторий»: not while a chat of the project is at work (ПР32). */
export async function detachRepo(
  db: PrismaClient,
  input: { userId: string; projectId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const project = await projectOwnedBy(tx, input.projectId, input.userId)
    if (project === null) throw projectNotFound()
    // The chats first, as a pass and the trash lock them (project-trash.ts).
    const chats = await lockProjectChats(tx, project.id)
    if (chats.some((chat) => busyStatuses.has(chat.status))) throw taskProjectBusy()
    const repos = await tx.projectRepository.findMany({
      where: { projectId: project.id },
      select: repoHookSelect,
    })
    await tx.projectRepository.deleteMany({ where: { projectId: project.id } })
    // Core removes the mirror and the bundles of what was detached (ПР20), and its hook (84.26).
    for (const repo of repos) await enqueueRepoGone(tx, repo)
  }, WRITE)
}

/** The repositories a connection of the user sees (P-git-repo-pick). */
export async function connectionRepositories(
  db: PrismaClient,
  input: { userId: string; connectionId: string; query?: string },
) {
  const connection = await connectionOf(db, input.userId, input.connectionId)
  const state =
    connection.state === 'checking' ? 'syncing' : connection.state === 'ok' ? 'ready' : 'failed'
  if (state !== 'ready')
    return {
      state,
      reason: connection.stateReason,
      items: [] as {
        providerRepoId: string
        path: string
        name: string
        visibility: string
        defaultBranch: string
        canPush: boolean
        syncedAt: Date
      }[],
    } as const
  const query = input.query?.trim()
  const items = await db.gitConnectionRepository.findMany({
    where: {
      connectionId: connection.id,
      ...(query
        ? {
            OR: [
              { path: { contains: query, mode: 'insensitive' } },
              { name: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ syncedAt: 'desc' }, { path: 'asc' }],
    take: 200,
    select: {
      providerRepoId: true,
      path: true,
      name: true,
      visibility: true,
      defaultBranch: true,
      canPush: true,
      syncedAt: true,
    },
  })
  return { state, reason: null, items } as const
}

/** The branches of a repository of a connection: core reads them on the first look. */
export async function repositoryBranches(
  db: PrismaClient,
  input: { userId: string; connectionId: string; providerRepoId: string },
): Promise<{ state: 'syncing' | 'ready'; names: string[] }> {
  const connection = await connectionOf(db, input.userId, input.connectionId)
  const repo = await db.gitConnectionRepository.findUnique({
    where: {
      connectionId_providerRepoId: {
        connectionId: connection.id,
        providerRepoId: input.providerRepoId,
      },
    },
    select: { branches: true, defaultBranch: true },
  })
  if (repo === null) throw repoNotInConnection()
  if (Array.isArray(repo.branches))
    return {
      state: 'ready',
      names: repo.branches.filter((name): name is string => typeof name === 'string'),
    }
  await enqueueOutbox(db, {
    topic: 'git',
    type: gitJobNames.repoInspect,
    payload: { connectionId: connection.id, providerRepoId: input.providerRepoId },
    dedupeKey: `git.repo.inspect:${connection.id}:${input.providerRepoId}:${Math.floor(Date.now() / 30_000)}`,
  })
  return { state: 'syncing', names: [repo.defaultBranch] }
}
