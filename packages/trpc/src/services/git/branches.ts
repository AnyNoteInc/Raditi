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
  repoAlreadyMerged,
  readRepoCiPaths,
  readRepoConfirmToken,
  REPO_CONFIRM_TTL_SECONDS,
  REPO_DIFF_KEPT_BYTES,
  repoChanged,
  repoCiChangeNeedsCard,
  repoCiConfigForeign,
  repoCiDeclined,
  repoCiDiffKey,
  repoCiDiffTooLarge,
  repoCiLintSchema,
  repoConfirmInvalid,
  repoConfirmUsed,
  repoDiffKey,
  repoNothingToPush,
  repoProposalPayloadSchema,
  repoReadOnly,
  signRepoConfirmToken,
  splitDiffByFile,
  gitConnectionReauth,
  type CiRefusal,
  type CiStatus,
  type ObjectStorage,
  type RepoCiLint,
  type RepoActionKind,
  type RepoActionState,
  type RepoBranchState,
  type RepoConfirmKind,
  type RepoConfirmMac,
} from '@repo/domain'

import { accessibleTask, taskNotFound } from '../chat/access.ts'
import { WRITE } from '../chat/dialog-lock.ts'
import { lastRunOf } from './runs.ts'

// The chat's branch in the repository of its project, for the card «Изменения в ветке»
// (docs/plan/84-projects.md, ПР13, ПР14, ПР26, §4.4; slice 84.19): what it holds, the diff of a
// turn, and the two steps of «Отправить в ветку» and «Открыть запрос на слияние» — `preparePush`
// binds a token to the head of the chat and the diff of its card, `confirmPush` writes the press
// (`repo_actions` with the token itself) and the job of core, which checks the token again. Web
// never reaches the provider. A change of build settings goes by its own card instead (ПР16; slice
// 84.20): `prepareCiChange` shows the diff of those files `git.ci_lint` of core kept and CI Lint,
// `{ state: 'loading' }` until it has, and binds the token to the SHA-256 of that diff;
// `confirmCiChange` is «Разрешить и отправить», `declineCiChange` «Не отправлять».

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
      ciPaths: true,
      connection: { select: { state: true, createdById: true } },
    },
  })
  return { task, project, repo }
}

/**
 * `/undo` took back changes the client was sent (ПР25): the head of the chat is an earlier turn
 * than the one whose head the branch at the client has — or none stands at all.
 */
async function takesBack(
  db: Pick<Tx, 'taskTurn'>,
  taskId: string,
  sentSha: string | null,
  headTurnNo: number | null,
): Promise<boolean> {
  if (sentSha === null) return false
  const sent = await db.taskTurn.findFirst({
    where: { taskId, headSha: sentSha },
    orderBy: { turnNo: 'desc' },
    select: { turnNo: true },
  })
  return sent !== null && (headTurnNo === null || headTurnNo < sent.turnNo)
}

export interface ChatBranchView {
  /** The project of the chat: its page of builds is `/projects/<id>/repository`. */
  projectId: string
  branch: string
  state: RepoBranchState
  /** The head of the chat in Радити; null — every change was taken back. */
  headSha: string | null
  /** The branch at the client has the chat's head: nothing waits to be sent. */
  sent: boolean
  /** The client may press: the repository takes writes by the author's connection. */
  canPush: boolean
  /**
   * What waits to be sent touches build settings (ПР16): `needed` — only by the card «Агент хочет
   * изменить настройки сборки»; `declined` — the client said «Не отправлять» to it; `foreign` — the
   * configuration lives in another project, nothing is sent.
   */
  ciChange: 'none' | 'needed' | 'declined' | 'foreign'
  mergeRequest: { number: number; state: string; checks: string; url: string } | null
  /**
   * The newest build of the branch at the client as core polled it (ПР17): the card shows its
   * status and is read again while it goes — no reload, no webhook.
   */
  lastRun: { id: string; status: CiStatus; refusal: CiRefusal | null; url: string } | null
  /** `/undo` took changes back since the branch was sent. */
  rewinds: boolean
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
  const { task, project, repo } = await ownChat(db, input.userId, input.taskId.toLowerCase())
  if (repo === null) return null
  const branch = await chatBranch(db, task.id)
  if (branch === null || branch.projectRepositoryId !== repo.id) return null
  const unsent = await unsentBranch(db, task.id)
  const head = unsent?.head.headSha ?? branch.mirrorSha
  const foreign = readRepoCiPaths(repo.ciPaths).foreign
  const lint = unsent?.ciTouched ? await ciLintOf(db, task.id, unsent.head.headSha) : null
  const ciChange = foreign
    ? 'foreign'
    : !unsent?.ciTouched
      ? 'none'
      : lint?.declined
        ? 'declined'
        : 'needed'
  const mr = await db.projectMergeRequest.findFirst({
    where: { projectRepositoryId: repo.id, sourceBranch: branch.branch },
    orderBy: { number: 'desc' },
    select: { number: true, state: true, checks: true, webUrl: true },
  })
  const lastRun =
    branch.remoteSha === null
      ? null
      : await lastRunOf(db, { projectRepositoryId: repo.id, branch: branch.branch, sha: null })
  const action = await db.repoAction.findFirst({
    where: { taskId: task.id, projectRepositoryId: repo.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, state: true, error: true },
  })
  return {
    projectId: project.id,
    branch: branch.branch,
    state: branch.state,
    headSha: head,
    sent: unsent === null,
    canPush:
      repo.mode === 'write' &&
      repo.connection?.state === 'ok' &&
      repo.connection.createdById === input.userId,
    ciChange,
    mergeRequest: mr
      ? { number: mr.number, state: mr.state, checks: mr.checks, url: mr.webUrl }
      : null,
    lastRun,
    rewinds:
      (unsent !== null && unsent.card === null) ||
      (await takesBack(db, task.id, branch.mirrorSha, unsent?.head.turnNo ?? null)),
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

/** «Посмотреть изменения» of one card, by its head: the diff its turn left, when kept (≤ 2 МиБ). */
export async function readTurnDiff(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  input: { userId: string; taskId: string; headSha: string },
): Promise<{ patch: string | null; truncated: boolean }> {
  const { task } = await ownChat(db, input.userId, input.taskId.toLowerCase())
  const card = await db.taskEvent.findFirst({
    where: {
      taskId: task.id,
      type: 'feed.repo_changes',
      payload: { path: ['headSha'], equals: input.headSha },
    },
    select: { turn: { select: { turnNo: true } } },
  })
  if (!card?.turn) throw taskNotFound()
  const object = await storage.get('artifacts', repoDiffKey(task.id, card.turn.turnNo))
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
  // `/undo` after the merge request was accepted: the main branch has them already (ПР25).
  if (
    branch.state === 'merged' &&
    (unsent.card === null || (await takesBack(db, task.id, branch.mirrorSha, unsent.head.turnNo)))
  )
    throw repoAlreadyMerged()
  if (readRepoCiPaths(repo.ciPaths).foreign) throw repoCiConfigForeign()
  // A change of build settings goes only by its own card (ПР16): `prepareCiChange`.
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
  return confirmPress(db, mac, input, 'push')
}

/** A press of a card of the chat's branch: `push` («Отправить в ветку») or `ci_change` (ПР16). */
async function confirmPress(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: {
    userId: string
    confirmToken: string
    mergeRequest?: { title: string; description: string; draft: boolean; reservedId: string | null }
    now: Date
  },
  kind: Extract<RepoConfirmKind, 'push' | 'ci_change'>,
): Promise<{ actionId: string }> {
  const claims = readRepoConfirmToken(input.confirmToken, macOf(mac), input.now)
  if (claims.kind !== kind || claims.userId !== input.userId || claims.taskId === null)
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
          kind: kind === 'ci_change' ? 'ci_push' : claims.opensMergeRequest ? 'open_mr' : 'push',
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

// --- the card of build settings (ПР16) --------------------------------------------------------

/** What `git.ci_lint` of core left for this head of the chat; null — not yet (or another head). */
async function ciLintOf(
  db: Pick<Tx, 'projectRepoBranch'>,
  taskId: string,
  headSha: string,
): Promise<RepoCiLint | null> {
  const row = await db.projectRepoBranch.findUnique({
    where: { taskId },
    select: { ciLint: true },
  })
  const lint = repoCiLintSchema.safeParse(row?.ciLint)
  return lint.success && lint.data.headSha === headSha ? lint.data : null
}

export type PreparedCiChange =
  | { state: 'loading' }
  | {
      state: 'ready'
      branch: string
      headSha: string
      files: { path: string; additions: number; deletions: number; diff: string }[]
      ciDiffSha256: string | null
      lint: { valid: boolean; errors: string[] } | null
      opensMergeRequest: boolean
      proposal: PreparedPush['proposal']
      confirmToken: string
      expiresAt: Date
    }

/** One job of core a minute at most asks again for a head that has no result yet. */
const CI_LINT_RETRY_MS = 60_000

/**
 * `projectRepo.prepareCiChange` (ПР16): the diff of the build settings of what waits to be sent and
 * CI Lint, as `git.ci_lint` of core kept them, and the token bound to the SHA-256 of that diff.
 * `{ state: 'loading' }` — core has not read this head yet: its job is asked for (web never calls
 * the provider). The diff is read from `raditi-artifacts` and checked against its SHA-256.
 */
export async function prepareCiChange(
  db: PrismaClient,
  storage: Pick<ObjectStorage, 'get'>,
  mac: RepoConfirmMac | null | undefined,
  input: { userId: string; taskId: string; now: Date },
): Promise<PreparedCiChange> {
  const sign = macOf(mac)
  const { task, project, repo } = await ownChat(db, input.userId, input.taskId.toLowerCase())
  assertWritable(repo, input.userId)
  if (readRepoCiPaths(repo.ciPaths).foreign) throw repoCiConfigForeign()
  const branch = await chatBranch(db, task.id)
  if (branch === null || branch.projectRepositoryId !== repo.id) throw repoNothingToPush()
  const unsent = await unsentBranch(db, task.id)
  if (unsent === null || !unsent.ciTouched) throw repoNothingToPush()
  const head = unsent.head.headSha
  const lint = await ciLintOf(db, task.id, head)
  if (lint === null) {
    await enqueueOutbox(db, {
      topic: 'git',
      type: gitJobNames.ciLint,
      payload: { taskId: task.id, headSha: head },
      dedupeKey: `git.ci_lint:${task.id}:${head}:${Math.floor(input.now.getTime() / CI_LINT_RETRY_MS)}`,
    })
    return { state: 'loading' }
  }
  if (lint.declined) throw repoCiDeclined()
  if (lint.tooLarge) throw repoCiDiffTooLarge()
  let patch = ''
  if (lint.ciDiffSha256 !== null) {
    const object = await storage.get('artifacts', repoCiDiffKey(task.id, head))
    if (!object) throw repoChanged()
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of object) {
      length += chunk.byteLength
      if (length > REPO_DIFF_KEPT_BYTES) throw repoCiDiffTooLarge()
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks, length)
    if (createHash('sha256').update(bytes).digest('hex') !== lint.ciDiffSha256) throw repoChanged()
    patch = bytes.toString('utf8')
  }
  const stats = new Map(lint.files.map((file) => [file.path, file]))
  const files = splitDiffByFile(patch).map((file) => ({
    path: file.path,
    additions: stats.get(file.path)?.additions ?? 0,
    deletions: stats.get(file.path)?.deletions ?? 0,
    diff: file.diff,
  }))
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
      kind: 'ci_change',
      userId: input.userId,
      projectId: project.id,
      projectRepositoryId: repo.id,
      taskId: task.id,
      number: null,
      targetBranch: branch.branch,
      headSha: head,
      diffSha256: unsent.card?.diffSha256 ?? null,
      ciDiffSha256: lint.ciDiffSha256,
      opensMergeRequest,
      deploy: null,
      nonce: randomBytes(16).toString('hex'),
      expiresAt,
    },
    sign,
  )
  return {
    state: 'ready',
    branch: branch.branch,
    headSha: head,
    files,
    ciDiffSha256: lint.ciDiffSha256,
    lint: lint.lint,
    opensMergeRequest,
    proposal,
    confirmToken,
    expiresAt: new Date(expiresAt * 1000),
  }
}

/** `projectRepo.confirmCiChange` — «Разрешить и отправить» (ПР16): a row `ci_push` and the job. */
export function confirmCiChange(
  db: PrismaClient,
  mac: RepoConfirmMac | null | undefined,
  input: Parameters<typeof confirmPush>[2],
): Promise<{ actionId: string }> {
  return confirmPress(db, mac, input, 'ci_change')
}

/**
 * `projectRepo.declineCiChange` — «Не отправлять» (ПР16): the change of build settings of this head
 * is not sent; nothing waits to be sent until the agent takes those files back.
 */
export async function declineCiChange(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<{ declined: true }> {
  const { task, repo } = await ownChat(db, input.userId, input.taskId.toLowerCase())
  if (repo === null) throw repoNothingToPush()
  const unsent = await unsentBranch(db, task.id)
  if (unsent === null || !unsent.ciTouched) throw repoNothingToPush()
  const lint = await ciLintOf(db, task.id, unsent.head.headSha)
  if (lint === null) throw repoChanged()
  await db.projectRepoBranch.updateMany({
    where: { taskId: task.id, projectRepositoryId: repo.id },
    data: { ciLint: { ...lint, declined: true } },
  })
  return { declined: true }
}
