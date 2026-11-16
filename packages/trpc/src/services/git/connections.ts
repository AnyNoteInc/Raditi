import { randomUUID } from 'node:crypto'

import { enqueueOutbox, findPersonalWorkspace, type Prisma, type PrismaClient } from '@repo/db'
import {
  gitConnectionInUse,
  gitConnectionLimit,
  gitConnectionLimits,
  gitConnectionNotFound,
  gitConnectionSecretPath,
  gitConnectUnavailable,
  gitHostRefused,
  githubHost,
  gitJobNames,
  gitlabComHost,
  gitlabComOffered,
  gitServerHostOf,
  workspaceEnvVarTombstone,
  type AppEnv,
  type GitConnectionKind,
  type GitConnectionState,
  type SecretStore,
} from '@repo/domain'

import { personalWorkspaceOf, WRITE } from '../chat/dialog-lock.ts'

// The git connections of a user (docs/plan/84-projects.md, ПР10, §4.4; slice 84.17). A connection
// acts in the name of the one who made it, so it is theirs, not the workspace's: every function
// takes the user and finds only their own connections, while they are a member. Its tokens are
// written to Vault first — by a writer that cannot read them back — then the row, its
// `credential_refs` entry and the job of core that checks it, in one transaction. Web never
// calls the client's own GitLab server: the check of a token is core's (`git.connection.sync`).

type Tx = Prisma.TransactionClient

/** What the procedures of git connections reach outside the database. The app builds it once. */
export interface GitServices {
  appEnv: AppEnv
  /** Two methods of Vault: nothing that holds this object can read a token back (`sites-writer`). */
  secrets: Pick<SecretStore, 'kvWrite' | 'kvMetadata'>
  /**
   * Resolves a host once and refuses it unless every address it has is public and outside the
   * platform's subnets (§4.6): GIT_HOST_REFUSED. No request goes to it from web.
   */
  checkHost(host: string): Promise<void>
  /** Raditi's OAuth app on gitlab.com is configured (GITLAB_OAUTH_CLIENT_*). */
  gitlabComConfigured: boolean
}

export const gitServicesOf = (services: GitServices | null | undefined): GitServices => {
  if (!services) throw gitConnectUnavailable()
  return services
}

export interface GitConnectionView {
  id: string
  kind: GitConnectionKind
  host: string
  /** null while core has not checked it yet. */
  login: string | null
  state: GitConnectionState
  reason: string | null
  checkedAt: Date | null
}

const viewSelect = {
  id: true,
  kind: true,
  host: true,
  accountLogin: true,
  accountId: true,
  state: true,
  stateReason: true,
  checkedAt: true,
} as const

type ViewRow = Prisma.GitConnectionGetPayload<{ select: typeof viewSelect }>

/** Before core's check the account is the connection's own id: there is no login to show yet. */
const viewOf = (row: ViewRow): GitConnectionView => ({
  id: row.id,
  kind: row.kind as GitConnectionKind,
  host: row.host,
  login: row.accountId === row.id ? null : row.accountLogin,
  state: row.state as GitConnectionState,
  reason: row.stateReason,
  checkedAt: row.checkedAt,
})

/** The connections of `userId`: theirs, in a workspace they are a member of (ПР10). */
export const ownConnection = (userId: string) =>
  ({
    createdById: userId,
    workspace: { members: { some: { userId } } },
  }) satisfies Prisma.GitConnectionWhereInput

/** One connection of the user, or GIT_CONNECTION_NOT_FOUND for any other. */
export async function connectionOf(
  db: Pick<Tx, 'gitConnection'>,
  userId: string,
  connectionId: string,
) {
  const row = await db.gitConnection.findFirst({
    where: { id: connectionId, ...ownConnection(userId) },
    select: { ...viewSelect, workspaceId: true, credentialRefId: true },
  })
  if (row === null) throw gitConnectionNotFound()
  return row
}

export async function listConnections(
  db: PrismaClient,
  services: GitServices | null | undefined,
  input: { userId: string; appEnv: AppEnv },
): Promise<{
  connections: GitConnectionView[]
  available: { github: boolean; gitlabCom: boolean; ownServer: boolean }
}> {
  const workspace = await findPersonalWorkspace(db, input)
  const rows =
    workspace === null
      ? []
      : await db.gitConnection.findMany({
          where: { workspaceId: workspace.id, ...ownConnection(input.userId) },
          orderBy: { createdAt: 'asc' },
          select: viewSelect,
        })
  return {
    connections: rows.map(viewOf),
    available: {
      // The GitHub App with writing is Э10 (ПР31): «Скоро».
      github: false,
      gitlabCom: services ? gitlabComOffered(input.appEnv, services.gitlabComConfigured) : false,
      ownServer: Boolean(services),
    },
  }
}

/** The connections of a workspace, under its lock: no more than ten together (§4.1). */
async function lockRoom(tx: Tx, workspaceId: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`git-conns:${workspaceId}`}, 0))`
  return tx.gitConnection.count({ where: { workspaceId } })
}

/** The sync of a connection, at most one waiting per press: the outbox keeps the key. */
export function enqueueConnectionSync(
  tx: Pick<Tx, 'outboxEvent'>,
  connectionId: string,
  at: Date,
): Promise<boolean> {
  return enqueueOutbox(tx, {
    topic: 'git',
    type: gitJobNames.connectionSync,
    payload: { connectionId },
    // One per connection and ten seconds: a double press is one check.
    dedupeKey: `git.connection.sync:${connectionId}:${Math.floor(at.getTime() / 10_000)}`,
  })
}

/** Erases the tokens of a connection: one version without a value (the writer never deletes). */
async function eraseTokens(services: GitServices, path: string, now: Date): Promise<void> {
  const metadata = await services.secrets.kvMetadata(path)
  if (metadata === null) return
  await services.secrets.kvWrite(path, workspaceEnvVarTombstone(now), {
    cas: metadata.currentVersion,
    maxVersions: 1,
  })
}

interface NewConnection {
  userId: string
  appEnv: AppEnv
  kind: Exclude<GitConnectionKind, 'github_app'>
  host: string
  /** Known at a sign-in (gitlab.com names the user); null for a token core checks later. */
  account: { login: string; id: string } | null
  tokens: Record<string, string>
  ip: string | null
  now?: Date
}

/**
 * Writes the tokens and the connection. A sign-in again to an account the user has connected
 * already replaces its tokens (a renewed sign-in after «Нужно войти в GitLab заново»); a new one
 * takes a place of the ten of the workspace.
 */
async function writeConnection(
  db: PrismaClient,
  services: GitServices,
  input: NewConnection,
): Promise<{ connectionId: string }> {
  const now = input.now ?? new Date()
  const { id: workspaceId } = await personalWorkspaceOf(db, input)
  const earlier =
    input.account === null
      ? null
      : await db.gitConnection.findFirst({
          where: {
            workspaceId,
            createdById: input.userId,
            kind: input.kind,
            host: input.host,
            accountId: input.account.id,
          },
          select: { id: true },
        })
  if (
    earlier === null &&
    (await db.gitConnection.count({ where: { workspaceId } })) >= gitConnectionLimits.perWorkspace
  )
    throw gitConnectionLimit()
  const connectionId = earlier?.id ?? randomUUID()
  const path = gitConnectionSecretPath(workspaceId, connectionId)
  const metadata = await services.secrets.kvMetadata(path)
  const { version } = await services.secrets.kvWrite(path, input.tokens, {
    cas: metadata?.currentVersion ?? 0,
    maxVersions: 1,
  })
  try {
    await db.$transaction(async (tx) => {
      if (earlier === null && (await lockRoom(tx, workspaceId)) >= gitConnectionLimits.perWorkspace)
        throw gitConnectionLimit()
      const ref = await tx.credentialRef.upsert({
        where: { vaultPath: path },
        create: { workspaceId, kind: 'git_connection', vaultPath: path, keyVersion: version },
        update: { keyVersion: version },
        select: { id: true },
      })
      const fields = {
        state: 'checking',
        stateReason: null,
        checkedAt: null,
        ...(input.account
          ? { accountLogin: input.account.login.slice(0, 100), accountId: input.account.id }
          : {}),
      }
      if (earlier === null)
        await tx.gitConnection.create({
          data: {
            id: connectionId,
            workspaceId,
            createdById: input.userId,
            kind: input.kind,
            host: input.host,
            // Before core's check: the host and the connection's own id stand for the account.
            accountLogin: input.host,
            accountId: connectionId,
            credentialRefId: ref.id,
            ...fields,
          },
        })
      else await tx.gitConnection.update({ where: { id: connectionId }, data: fields })
      await enqueueConnectionSync(tx, connectionId, now)
      await tx.auditLog.create({
        data: {
          actorType: 'user',
          actorId: input.userId,
          workspaceId,
          action: 'workspace.git_connection.connect',
          targetType: 'git_connection',
          targetId: connectionId,
          meta: { kind: input.kind, host: input.host },
          ip: input.ip,
        },
      })
    }, WRITE)
  } catch (error) {
    if (earlier === null) await eraseTokens(services, path, now).catch(() => undefined)
    throw error
  }
  return { connectionId }
}

/** «Свой сервер GitLab» (P-git-connect): an address and a token; core checks the token. */
export async function addTokenConnection(
  db: PrismaClient,
  services: GitServices,
  input: { userId: string; host: string; token: string; ip: string | null; now?: Date },
): Promise<{ connectionId: string }> {
  const host = gitServerHostOf(input.host)
  // GitHub takes no token here: its way is the GitHub App (Э10).
  if (host === null || host === githubHost) throw gitHostRefused()
  await services.checkHost(host)
  return writeConnection(db, services, {
    userId: input.userId,
    appEnv: services.appEnv,
    kind: 'gitlab_token',
    host,
    account: null,
    tokens: { token: input.token },
    ip: input.ip,
    ...(input.now ? { now: input.now } : {}),
  })
}

/**
 * The return from gitlab.com (`/api/git/gitlab/callback`): the tokens web just exchanged the code
 * for and the user they name. Never read back by web; core renews them.
 */
export async function connectGitlabOAuth(
  db: PrismaClient,
  services: GitServices,
  input: {
    userId: string
    account: { login: string; id: string }
    tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null }
    ip: string | null
    now?: Date
  },
): Promise<{ connectionId: string }> {
  if (!gitlabComOffered(services.appEnv, services.gitlabComConfigured))
    throw gitConnectUnavailable()
  return writeConnection(db, services, {
    userId: input.userId,
    appEnv: services.appEnv,
    kind: 'gitlab_oauth',
    host: gitlabComHost,
    account: input.account,
    tokens: {
      accessToken: input.tokens.accessToken,
      ...(input.tokens.refreshToken ? { refreshToken: input.tokens.refreshToken } : {}),
      ...(input.tokens.expiresAt ? { expiresAt: input.tokens.expiresAt.toISOString() } : {}),
    },
    ip: input.ip,
    ...(input.now ? { now: input.now } : {}),
  })
}

/** «Обновить»: core checks the access and lists the repositories again. */
export async function refreshConnection(
  db: PrismaClient,
  input: { userId: string; connectionId: string; now?: Date },
): Promise<void> {
  const row = await connectionOf(db, input.userId, input.connectionId)
  await db.$transaction(async (tx) => {
    if (row.state === 'refused')
      await tx.gitConnection.update({
        where: { id: row.id },
        data: { state: 'checking', stateReason: null },
      })
    await enqueueConnectionSync(tx, row.id, input.now ?? new Date())
  }, WRITE)
}

/** «Отключить»: refused while a project reads through it (GIT_CONNECTION_IN_USE). */
export async function removeConnection(
  db: PrismaClient,
  services: GitServices,
  input: { userId: string; connectionId: string; ip: string | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  const row = await connectionOf(db, input.userId, input.connectionId)
  const path = gitConnectionSecretPath(row.workspaceId, row.id)
  await db.$transaction(async (tx) => {
    const using = await tx.projectRepository.findMany({
      where: { connectionId: row.id },
      select: { project: { select: { name: true } } },
    })
    if (using.length) throw gitConnectionInUse(using.map((repo) => repo.project.name))
    await tx.gitConnection.delete({ where: { id: row.id } })
    if (row.credentialRefId)
      await tx.credentialRef.deleteMany({ where: { id: row.credentialRefId } })
    await tx.auditLog.create({
      data: {
        actorType: 'user',
        actorId: input.userId,
        workspaceId: row.workspaceId,
        action: 'workspace.git_connection.remove',
        targetType: 'git_connection',
        targetId: row.id,
        meta: { kind: row.kind, host: row.host },
        ip: input.ip,
      },
    })
  }, WRITE)
  // The row is gone first: a token nobody refers to is harmless while its erasure is retried.
  await eraseTokens(services, path, now)
}
