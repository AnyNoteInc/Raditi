import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  chatBranch,
  enqueueOutbox,
  Prisma,
  projectOwnedBy,
  unsentBranch,
  type PrismaClient,
} from '@repo/db'
import {
  gitConnectUnavailable,
  gitJobNames,
  readRepoConfirmToken,
  REPO_CONFIRM_TTL_SECONDS,
  REPO_DIFF_KEPT_BYTES,
  repoChanged,
  repoCiChangeNeedsCard,
  repoConfirmInvalid,
  repoConfirmUsed,
  repoDiffKey,
  repoNothingToPush,
  repoProposalPayloadSchema,
  repoReadOnly,
  signRepoConfirmToken,
  gitConnectionReauth,
  type ObjectStorage,
  type RepoActionKind,
  type RepoActionState,
  type RepoBranchState,
  type RepoConfirmMac,
} from '@repo/domain'

import { accessibleTask, taskNotFound } from '../chat/access.ts'
import { WRITE } from '../chat/dialog-lock.ts'

// The chat's branch in the repository of its project, for the card «Изменения в ветке»
// (docs/plan/84-projects.md, ПР13, ПР14, ПР26, §4.4; slice 84.19): what it holds, the diff of a
// turn, and the two steps of «Отправить в ветку» and «Открыть запрос на слияние» — `preparePush`
// binds a token to the head of the chat and the diff of its card, `confirmPush` writes the press
// (`repo_actions` with the token itself) and the job of core, which checks the token again. Web
// never reaches the provider.

type Tx = Prisma.TransactionClient

/** The chat of a project the user owns, with its repository. NOT_FOUND for anything else. */
async function ownChat(
  db: Pick<Tx, 'task' | 'project' | 'projectRepository'>,
  userId: string,
  taskId: string,
) {
  const task = await db.task.findFirst({
    where: accessibleTask(userId, taskId),
    select: { id: true, title: true, projectId: true },
  })
  if (task?.projectId == null) throw taskNotFound()
  const project = await projectOwnedBy(db, task.projectId, userId)
  if (project === null) throw taskNotFound()
  const repo = await db.projectRepository.findUnique({
    where: { projectId: project.id },
    select: {
      id: true,
      defaultBranch: true,
      mode: true,
      webUrl: true,
      connection: { select: { state: true, createdById: true } },
    },
  })
  return { task, project, repo }
}

export interface ChatBranchView {
  branch: string
  state: RepoBranchState
  /** The head of the chat in Радити; null — every change was taken back. */
  headSha: string | null
  /** The branch at the client has the chat's head: nothing waits to be sent. */
  sent: boolean
  /** The client may press: the repository takes writes by the author's connection. */
  canPush: boolean
  mergeRequest: { number: number; state: string; url: string } | null
  /** The last press and how far core got. */
  lastAction: {
    id: string
    kind: RepoActionKind
    state: RepoActionState
    error: string | null
  } | null
}

export async function readChatBranch(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<ChatBranchView | null> {
  const { task, repo } = await ownChat(db, input.userId, input.taskId.toLowerCase())
  if (repo === null) return null
  const branch = await chatBranch(db, task.id)
  if (branch === null || branch.projectRepositoryId !== repo.id) return null
  const unsent = await unsentBranch(db, task.id)
  const head = unsent?.head.headSha ?? branch.mirrorSha
  const mr = await db.projectMergeRequest.findFirst({
    where: { projectRepositoryId: repo.id, sourceBranch: branch.branch },
    orderBy: { number: 'desc' },
    select: { number: true, state: true, webUrl: true },
  })
  const action = await db.repoAction.findFirst({
    where: { taskId: task.id, projectRepositoryId: repo.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, state: true, error: true },
  })
  return {
    branch: branch.branch,
    state: branch.state,
    headSha: head,
    sent: unsent === null,
    canPush:
      repo.mode === 'write' &&
      repo.connection?.state === 'ok' &&
      repo.connection.createdById === input.userId,
    mergeRequest: mr ? { number: mr.number, state: mr.state, url: mr.webUrl } : null,
    lastAction: action
      ? {
          id: action.id,
          kind: action.kind as RepoActionKind,
          state: action.state as RepoActionState,
          error: action.error,
        }
      : null,
  }
}

/** «Посмотреть изменения» of one card: the diff its turn left, when it was kept (≤ 2 МиБ). */
export async function readTurnDiff(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; turn: number },
): Promise<{ patch: string | null; truncated: boolean }> {
  const { task } = await ownChat(db, input.userId, input.taskId.toLowerCase())
  const card = await db.taskEvent.findFirst({
    where: { taskId: task.id, type: 'feed.repo_changes', turn: { turnNo: input.turn } },
    select: { id: true },
  })
  if (card === null) throw taskNotFound()
  const object = await storage.get('artifacts', repoDiffKey(task.id, input.turn))
  if (!object) return { patch: null, truncated: true }
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of object) {
    length += chunk.byteLength
    if (length > REPO_DIFF_KEPT_BYTES) return { patch: null, truncated: true }
    chunks.push(chunk)
  }
  return { patch: Buffer.concat(chunks, length).toString('utf8'), truncated: false }
}

export interface PreparedPush {
  branch: string
  headSha: string
  diffSha256: string | null
  stat: {
    files: number
    additions: number
    deletions: number
    list: { path: string; additions: number; deletions: number }[]
  }
  /** `/undo` took changes back: the push sends a commit that returns them. */
  rewinds: boolean
  /** The first push of the branch opens the merge request too (ПР14). */
  opensMergeRequest: boolean
  /** What the card proposes for the merge request: the agent's proposal, or the chat's title. */
  proposal: { title: string; description: string; draft: boolean; reservedId: string | null } | null
  confirmToken: string
  expiresAt: Date
}

/** The HMAC of the cards (REPO_CONFIRM_SECRET); none — no card is offered (ПР15). */
const macOf = (mac: RepoConfirmMac | null | undefined): RepoConfirmMac => {
  if (!mac) throw gitConnectUnavailable()
  return mac
}

/** The press may go on: a repository that takes writes by the author's own connection. */
function assertWritable(
  repo: Awaited<ReturnType<typeof ownChat>>['repo'],
  userId: string,
): asserts repo is NonNullable<Awaited<ReturnType<typeof ownChat>>['repo']> {
  if (repo === null) throw repoNothingToPush()
  if (repo.mode !== 'write' || repo.connection === null) throw repoReadOnly()
  if (repo.connection.state === 'reauth_needed') throw gitConnectionReauth()
  if (repo.connection.state !== 'ok' || repo.connection.createdById !== userId) throw repoReadOnly()
}

/** `projectRepo.preparePush` (ПР13): what the button sends, and the token of exactly that. */
export async function preparePush(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; taskId: string; now: Date },
): Promise<PreparedPush> {
  const sign = macOf(mac)
  const { task, project, repo } = await ownChat(db, input.userId, input.taskId.toLowerCase())
  assertWritable(repo, input.userId)
  const branch = await chatBranch(db, task.id)
  if (branch === null || branch.projectRepositoryId !== repo.id) throw repoNothingToPush()
  const unsent = await unsentBranch(db, task.id)
  if (unsent === null) throw repoNothingToPush()
  // A change of build settings goes only with the card of ПР16 (slice 84.20).
  if (unsent.ciTouched) throw repoCiChangeNeedsCard()
  const open = await db.projectMergeRequest.findFirst({
    where: {
      projectRepositoryId: repo.id,
      sourceBranch: branch.branch,
      state: { in: ['open', 'draft'] },
    },
    select: { number: true },
  })
  const opensMergeRequest = open === null
  const proposal = opensMergeRequest ? await proposalOf(db, task.id, task.title) : null
  const expiresAt = Math.floor(input.now.getTime() / 1000) + REPO_CONFIRM_TTL_SECONDS
  const confirmToken = signRepoConfirmToken(
    {
      kind: 'push',
      userId: input.userId,
      projectId: project.id,
      projectRepositoryId: repo.id,
      taskId: task.id,
      number: null,
      targetBranch: branch.branch,
      headSha: unsent.head.headSha,
      diffSha256: unsent.card?.diffSha256 ?? null,
      ciDiffSha256: null,
      opensMergeRequest,
      deploy: null,
      nonce: randomBytes(16).toString('hex'),
      expiresAt,
    },
    sign,
  )
  const list = unsent.cards.flatMap((card) => card.list).slice(0, 50)
  return {
    branch: branch.branch,
    headSha: unsent.head.headSha,
    diffSha256: unsent.card?.diffSha256 ?? null,
    stat: { files: unsent.files, additions: unsent.additions, deletions: unsent.deletions, list },
    rewinds: unsent.card === null,
    opensMergeRequest,
    proposal,
    confirmToken,
    expiresAt: new Date(expiresAt * 1000),
  }
}

/** The agent's last proposal of the chat (`feed.repo_proposal`), else the chat's title. */
async function proposalOf(
  db: Pick<PrismaClient, 'taskEvent'>,
  taskId: string,
  title: string | null,
): Promise<NonNullable<PreparedPush['proposal']>> {
  const row = await db.taskEvent.findFirst({
    where: { taskId, type: 'feed.repo_proposal' },
    orderBy: { id: 'desc' },
    select: { payload: true },
  })
  const payload = row?.payload as Record<string, unknown> | null | undefined
  const parsed = repoProposalPayloadSchema.safeParse({
    title: payload?.title,
    description: payload?.description,
    draft: payload?.draft,
  })
  if (parsed.success && typeof payload?.reservedId === 'string')
    return { ...parsed.data, reservedId: payload.reservedId }
  return {
    title: (title ?? '').trim().slice(0, 120) || 'Изменения агента',
    description: '',
    draft: false,
    reservedId: null,
  }
}

/**
 * `projectRepo.confirmPush` (ПР13, ПР15): the token checked, the press written once — the token's
 * hash is unique — with the token itself for core, and the job `git.action`, in one transaction.
 */
export async function confirmPush(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: {
    userId: string
    confirmToken: string
    mergeRequest?: { title: string; description: string; draft: boolean; reservedId: string | null }
    now: Date
  },
): Promise<{ actionId: string }> {
  const claims = readRepoConfirmToken(input.confirmToken, macOf(mac), input.now)
  if (claims.kind !== 'push' || claims.userId !== input.userId || claims.taskId === null)
    throw repoConfirmInvalid()
  if (claims.opensMergeRequest !== Boolean(input.mergeRequest)) throw repoConfirmInvalid()
  const mergeRequest = input.mergeRequest
    ? {
        ...repoProposalPayloadSchema.parse({
          title: input.mergeRequest.title,
          description: input.mergeRequest.description,
          draft: input.mergeRequest.draft,
        }),
        reservedId: input.mergeRequest.reservedId,
      }
    : null
  const tokenSha256 = createHash('sha256').update(input.confirmToken).digest('hex')
  try {
    return await db.$transaction(async (tx) => {
      const { task, project, repo } = await ownChat(tx, input.userId, claims.taskId!)
      if (project.id !== claims.projectId || repo?.id !== claims.projectRepositoryId)
        throw repoChanged()
      assertWritable(repo, input.userId)
      if ((await tx.repoAction.count({ where: { tokenSha256 } })) > 0) throw repoConfirmUsed()
      const actionId = randomUUID()
      await tx.repoAction.create({
        data: {
          id: actionId,
          projectRepositoryId: repo.id,
          taskId: task.id,
          createdById: input.userId,
          kind: claims.opensMergeRequest ? 'open_mr' : 'push',
          args: { token: input.confirmToken, mergeRequest },
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
