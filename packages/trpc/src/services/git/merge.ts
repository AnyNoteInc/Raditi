import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { enqueueOutbox, Prisma, projectOwnedBy, type PrismaClient } from '@repo/db'
import {
  gitConnectionReauth,
  gitConnectUnavailable,
  gitJobNames,
  gitNotSupported,
  projectNotFound,
  readRepoConfirmToken,
  REPO_CONFIRM_TTL_SECONDS,
  repoAlreadyMerged,
  repoChanged,
  repoConfirmInvalid,
  repoConfirmUsed,
  repoDeployGone,
  repoForeignCommits,
  repoMergeTargetChanged,
  repoNotMergeable,
  repoOffersDeploy,
  repoOffersWhenGreen,
  repoProviderOffers,
  repoReadOnly,
  signRepoConfirmToken,
  type ChecksState,
  type RepoActionKind,
  type RepoActionState,
  type RepoConfirmClaims,
  type RepoConfirmMac,
  type RepoMergeMode,
  type RepoProviderKind,
} from '@repo/domain'

import { WRITE } from '../chat/dialog-lock.ts'

// «Принять в основную ветку» and «Выкатить» (docs/plan/84-projects.md, ПР15, §4.4; slice 84.22):
// the two steps of the trusted cards. `prepareMerge` binds a token to the merge request, its target
// branch and its head as core last read them; `prepareDeploy` binds one to a manual job of the head
// of the main branch. `confirm…` writes the press — a row of `repo_actions` that holds the token —
// and the job `git.action` of core, which reads the provider again before it merges or plays
// anything. Web never reaches the provider; no tool of the agent and no run without a person comes
// here (ПР19): only a procedure of a signed-in client.

type Tx = Prisma.TransactionClient

/** The HMAC of the cards (REPO_CONFIRM_SECRET); none — no card is offered (ПР15). */
const macOf = (mac: RepoConfirmMac | null | undefined): RepoConfirmMac => {
  if (!mac) throw gitConnectUnavailable()
  return mac
}

const repoSelect = {
  id: true,
  provider: true,
  defaultBranch: true,
  mode: true,
  mirrorState: true,
  ciPolledAt: true,
  connection: { select: { state: true, createdById: true } },
} as const

/**
 * The repository of a project its author owns and may write to by the author's own connection:
 * what a merge and a deploy need. PROJECT_NOT_FOUND for another's project.
 */
async function writableRepository(
  db: Pick<Tx, 'project' | 'projectRepository'>,
  userId: string,
  projectId: string,
) {
  const project = await projectOwnedBy(db, projectId, userId)
  if (project === null) throw projectNotFound()
  const repo = await db.projectRepository.findUnique({ where: { projectId }, select: repoSelect })
  if (repo === null || repo.mode !== 'write' || repo.connection === null) throw repoReadOnly()
  if (repo.connection.state === 'reauth_needed') throw gitConnectionReauth()
  if (repo.connection.state !== 'ok' || repo.connection.createdById !== userId) throw repoReadOnly()
  return { project, repo, provider: repo.provider as RepoProviderKind }
}

const nonce = () => randomBytes(16).toString('hex')
const expiry = (now: Date) => Math.floor(now.getTime() / 1000) + REPO_CONFIRM_TTL_SECONDS

export interface PreparedMerge {
  number: number
  title: string
  source: string
  target: string
  headSha: string
  checks: ChecksState
  url: string
  /** «Удалить ветку … после принятия» — on by default (ПР15). */
  deleteBranch: boolean
  /**
   * «Принять, когда сборка пройдёт»: a provider with `autoMerge` (GitLab), or one the platform waits
   * for itself (GitHub, `checksWait`; core refuses it without required checks, ПР15).
   */
  whenGreen: boolean
  confirmToken: string
  expiresAt: Date
}

/**
 * `projectRepo.prepareMerge` (ПР15): the merge request as core last read it — open, into the main
 * branch — and the token of exactly that: the user, the project, the request, its target and its
 * head. A stale head is caught by core (the provider's 409) and said «Изменения обновились».
 */
export async function prepareMerge(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; projectId: string; number: number; now: Date },
): Promise<PreparedMerge> {
  const sign = macOf(mac)
  const { project, repo, provider } = await writableRepository(db, input.userId, input.projectId)
  const mr = await db.projectMergeRequest.findUnique({
    where: { projectRepositoryId_number: { projectRepositoryId: repo.id, number: input.number } },
    select: {
      number: true,
      taskId: true,
      title: true,
      sourceBranch: true,
      targetBranch: true,
      headSha: true,
      state: true,
      checks: true,
      webUrl: true,
    },
  })
  if (mr === null) throw repoNotMergeable()
  if (mr.state === 'merged') throw repoAlreadyMerged()
  if (mr.state !== 'open') throw repoNotMergeable()
  if (mr.targetBranch !== repo.defaultBranch) throw repoMergeTargetChanged()
  // The merge request of a chat merges only the commit Радити sent there (ревью, безопасность 4).
  if (mr.taskId !== null) {
    const branch = await db.projectRepoBranch.findUnique({
      where: { taskId: mr.taskId },
      select: { remoteSha: true, branch: true },
    })
    if (branch?.branch === mr.sourceBranch && branch.remoteSha !== mr.headSha)
      throw repoForeignCommits()
  }
  const expiresAt = expiry(input.now)
  const confirmToken = signRepoConfirmToken(
    {
      kind: 'merge',
      userId: input.userId,
      projectId: project.id,
      projectRepositoryId: repo.id,
      taskId: mr.taskId,
      number: mr.number,
      targetBranch: mr.targetBranch,
      headSha: mr.headSha,
      diffSha256: null,
      ciDiffSha256: null,
      opensMergeRequest: false,
      deploy: null,
      nonce: nonce(),
      expiresAt,
    },
    sign,
  )
  return {
    number: mr.number,
    title: mr.title,
    source: mr.sourceBranch,
    target: mr.targetBranch,
    headSha: mr.headSha,
    checks: mr.checks as ChecksState,
    url: mr.webUrl,
    deleteBranch: true,
    whenGreen: repoOffersWhenGreen(repoProviderOffers[provider]),
    confirmToken,
    expiresAt: new Date(expiresAt * 1000),
  }
}

/** A press of a trusted card, written once with its token, and the job of core — one transaction. */
async function writePress(
  db: PrismaClient,
  input: {
    userId: string
    confirmToken: string
    claims: RepoConfirmClaims
    kind: Extract<RepoActionKind, 'merge' | 'deploy'>
    merge: { mode: RepoMergeMode; deleteBranch: boolean } | null
  },
): Promise<{ actionId: string }> {
  const tokenSha256 = createHash('sha256').update(input.confirmToken).digest('hex')
  try {
    return await db.$transaction(async (tx) => {
      const { project, repo, provider } = await writableRepository(
        tx,
        input.userId,
        input.claims.projectId,
      )
      if (project.id !== input.claims.projectId || repo.id !== input.claims.projectRepositoryId)
        throw repoChanged()
      if (input.merge?.mode === 'when_green' && !repoOffersWhenGreen(repoProviderOffers[provider]))
        throw gitNotSupported('a merge when green')
      if ((await tx.repoAction.count({ where: { tokenSha256 } })) > 0) throw repoConfirmUsed()
      const actionId = randomUUID()
      await tx.repoAction.create({
        data: {
          id: actionId,
          projectRepositoryId: repo.id,
          taskId: input.claims.taskId,
          createdById: input.userId,
          kind: input.kind,
          args: { token: input.confirmToken, mergeRequest: null, merge: input.merge },
          tokenSha256,
        },
      })
      await enqueueOutbox(tx, {
        topic: 'git',
        type: gitJobNames.action,
        payload: { actionId },
        dedupeKey: `git.action:${actionId}`,
      })
      return { actionId }
    }, WRITE)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw repoConfirmUsed()
    throw error
  }
}

/** `projectRepo.confirmMerge` (ПР15): «Принять в основную ветку» or «…, когда сборка пройдёт». */
export async function confirmMerge(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: {
    userId: string
    confirmToken: string
    mode: RepoMergeMode
    deleteBranch: boolean
    now: Date
  },
): Promise<{ actionId: string }> {
  const claims = readRepoConfirmToken(input.confirmToken, macOf(mac), input.now)
  if (claims.kind !== 'merge' || claims.userId !== input.userId || claims.number === null)
    throw repoConfirmInvalid()
  return writePress(db, {
    userId: input.userId,
    confirmToken: input.confirmToken,
    claims,
    kind: 'merge',
    merge: { mode: input.mode, deleteBranch: input.deleteBranch },
  })
}

export type PreparedDeploy =
  | { state: 'loading' }
  | {
      state: 'ready'
      ref: string
      /** «Выкатится коммит <sha>» — the head of the main branch the jobs are of; null — none. */
      sha: string | null
      actions: {
        id: string
        kind: 'manual_job' | 'workflow_dispatch'
        name: string
        confirmToken: string
      }[]
      expiresAt: Date
    }

/** One job of core a minute at most reads the manual jobs again for a look at the card. */
const DEPLOY_RESYNC_MS = 60_000

/**
 * `projectRepo.prepareDeploy` (ПР15): the manual jobs of the head of the main branch core keeps
 * (`project_deploy_actions`, written by polling), a token for each — bound to the branch, its head
 * and the job. `loading` until core has polled the repository once; each look asks core to read the
 * jobs again at most once a minute, and core reads the head again before it plays one.
 */
export async function prepareDeploy(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; projectId: string; now: Date },
): Promise<PreparedDeploy> {
  const sign = macOf(mac)
  const { project, repo, provider } = await writableRepository(db, input.userId, input.projectId)
  const offer = repoProviderOffers[provider]
  if (!repoOffersDeploy(offer)) throw gitNotSupported('a deploy job')
  const minute = Math.floor(input.now.getTime() / DEPLOY_RESYNC_MS)
  if (repo.mirrorState === 'ready')
    await enqueueOutbox(db, {
      topic: 'git',
      type: repo.ciPolledAt === null ? gitJobNames.poll : gitJobNames.deployActions,
      payload: { projectRepositoryId: repo.id },
      dedupeKey: `git.deploy.look:${repo.id}:${minute}`,
    })
  if (repo.ciPolledAt === null) return { state: 'loading' }
  const rows = await db.projectDeployAction.findMany({
    where: { projectRepositoryId: repo.id, ref: repo.defaultBranch },
    orderBy: [{ syncedAt: 'desc' }, { name: 'asc' }],
    take: 50,
    select: { sha: true, kind: true, providerActionId: true, name: true, syncedAt: true },
  })
  // One build, one head: the jobs of the newest read.
  const sha = rows[0]?.sha ?? null
  const expiresAt = expiry(input.now)
  // The kinds the provider offers (ПР15): manual jobs of GitLab, `workflow_dispatch` of GitHub.
  const kinds = new Set<string>([
    ...(offer.manualJobs ? ['manual_job'] : []),
    ...(offer.workflowDispatch ? ['workflow_dispatch'] : []),
  ])
  const actions = rows
    .filter((row) => row.sha === sha && kinds.has(row.kind))
    .map((row) => ({
      id: row.providerActionId,
      kind: row.kind as 'manual_job' | 'workflow_dispatch',
      name: row.name,
      confirmToken: signRepoConfirmToken(
        {
          kind: 'deploy',
          userId: input.userId,
          projectId: project.id,
          projectRepositoryId: repo.id,
          taskId: null,
          number: null,
          targetBranch: repo.defaultBranch,
          headSha: row.sha,
          diffSha256: null,
          ciDiffSha256: null,
          opensMergeRequest: false,
          deploy: {
            kind: row.kind as 'manual_job' | 'workflow_dispatch',
            id: row.providerActionId,
            ref: repo.defaultBranch,
          },
          nonce: nonce(),
          expiresAt,
        },
        sign,
      ),
    }))
  return {
    state: 'ready',
    ref: repo.defaultBranch,
    sha: actions.length ? sha : null,
    actions,
    expiresAt: new Date(expiresAt * 1000),
  }
}

/** `projectRepo.confirmDeploy` (ПР15): «Выкатить» — one manual job of the head of the main branch. */
export async function confirmDeploy(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; confirmToken: string; now: Date },
): Promise<{ actionId: string }> {
  const claims = readRepoConfirmToken(input.confirmToken, macOf(mac), input.now)
  if (claims.kind !== 'deploy' || claims.userId !== input.userId || claims.deploy === null)
    throw repoConfirmInvalid()
  const kept = await db.projectDeployAction.count({
    where: {
      projectRepositoryId: claims.projectRepositoryId,
      kind: claims.deploy.kind,
      providerActionId: claims.deploy.id,
    },
  })
  if (kept === 0) throw repoDeployGone()
  return writePress(db, {
    userId: input.userId,
    confirmToken: input.confirmToken,
    claims,
    kind: 'deploy',
    merge: null,
  })
}

export interface RepoActionView {
  id: string
  kind: RepoActionKind
  state: RepoActionState
  error: string | null
}

/** `projectRepo.action`: how far core got with a press of the author, for «Выкатить» on P-repo. */
export async function readRepoAction(
  db: PrismaClient,
  input: { userId: string; projectId: string; actionId: string },
): Promise<RepoActionView> {
  if ((await projectOwnedBy(db, input.projectId, input.userId)) === null) throw projectNotFound()
  const row = await db.repoAction.findFirst({
    where: {
      id: input.actionId,
      createdById: input.userId,
      repository: { projectId: input.projectId },
    },
    select: { id: true, kind: true, state: true, error: true },
  })
  if (row === null) throw projectNotFound()
  return {
    id: row.id,
    kind: row.kind as RepoActionKind,
    state: row.state as RepoActionState,
    error: row.error,
  }
}
