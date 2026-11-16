import { createHash, randomUUID } from 'node:crypto'

import {
  chatBranch,
  insertFeedEvent,
  projectOwnedBy,
  repoChatBranchName,
  unsentBranch,
  type PrismaClient,
} from '@repo/db'
import {
  gitAccessDenied,
  gitConnectionReauth,
  isAgentBranch,
  isDomainError,
  neutraliseMergeRequestDescription,
  neutraliseMergeRequestTitle,
  readRepoConfirmToken,
  repoActionArgsSchema,
  repoChanged,
  repoCiChangeNeedsCard,
  repoConfirmInvalid,
  repoNothingToPush,
  repoPushConflict,
  repoReadOnly,
  type GitAuth,
  type GitConnectionKind,
  type GitGrant,
  type GitProvider,
  type PullRequest,
  type RepoConfirmClaims,
  type RepoConfirmMac,
  type RepoProviderKind,
  type RepoRef,
} from '@repo/domain'

import { GIT_CREDENTIAL_TTL_SECONDS } from '../git-workspace/git-auth.ts'
import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import type { GitAuthSource } from './git-auth-source.ts'
import type { GitProviderFactory } from './git-jobs.ts'
import type { ResolvePublicHost } from './public-host.ts'

// `git.action` (docs/plan/84-projects.md, ПР13–ПР15, §4.3, §4.4; slice 84.19): a row of
// `repo_actions` a button of the client wrote. The row runs only by the token it holds: core
// checks its HMAC again (REPO_CONFIRM_SECRET), its time, that the one who pressed is the author of
// the project and still in its workspace, and that its claims are this row and this chat — the
// head of the chat's branch and the diff of its card as they stand now. Then the provider: the
// access of the connection to write, the push with the head it expects at the client (on top of
// commits the client added; a conflict is said in the chat), the merge request with a title and
// a description made harmless and read again after it was opened. `RepoChanges` never writes such
// a row: every push is a press.

/** Names of a branch tried at the client when the chat's own is taken there. */
const NAME_TRIES = 5

export interface RepoActionsOptions {
  prisma: PrismaClient
  auth: Pick<GitAuthSource, 'grantFor'>
  resolvePublic: ResolvePublicHost
  provider: GitProviderFactory
  workspace: Pick<GitWorkspaceService, 'pushChatBranch' | 'moveChatRef' | 'readChatRef'>
  /** HMAC by REPO_CONFIRM_SECRET; null — no secret: no action runs. */
  mac: RepoConfirmMac | null
  logger: { log(line: string): void; warn(line: string): void }
  now?: () => Date
}

interface ActionRow {
  id: string
  projectRepositoryId: string
  taskId: string | null
  createdById: string
  kind: string
  args: unknown
  tokenSha256: string
  state: string
}

/** A refusal of the action that is said, not thrown. */
class Refused extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const tokenSha256 = (token: string) => createHash('sha256').update(token).digest('hex')

export class RepoActions {
  readonly #o: RepoActionsOptions
  readonly #now: () => Date

  constructor(options: RepoActionsOptions) {
    this.#o = options
    this.#now = options.now ?? (() => new Date())
  }

  /** `git.action`: one attempt; the row ends `done` or `failed` and the chat is told. */
  async run(actionId: string): Promise<void> {
    const { prisma } = this.#o
    const row = (await prisma.repoAction.findUnique({
      where: { id: actionId },
      select: {
        id: true,
        projectRepositoryId: true,
        taskId: true,
        createdById: true,
        kind: true,
        args: true,
        tokenSha256: true,
        state: true,
      },
    })) as ActionRow | null
    if (row === null) return
    // A row is taken once: another delivery of the job finds it running or ended.
    const taken = await prisma.repoAction.updateMany({
      where: { id: actionId, state: 'queued' },
      data: { state: 'running' },
    })
    if (taken.count === 0) return
    try {
      const claims = this.#checkToken(row)
      const result = await this.#push(row, claims)
      await this.#finish(row, 'done', null, result)
    } catch (error) {
      const code =
        error instanceof Refused
          ? error.code
          : isDomainError(error)
            ? error.code
            : 'GIT_OPERATION_FAILED'
      this.#o.logger.warn(`git.action ${actionId}: ${code}`)
      await this.#finish(row, 'failed', code.slice(0, 40), null)
    }
  }

  /** The token of the row, checked as web checked it, and its claims against the row (ПР15). */
  #checkToken(row: ActionRow): RepoConfirmClaims {
    if (this.#o.mac === null) throw repoConfirmInvalid()
    const args = repoActionArgsSchema.safeParse(row.args)
    if (!args.success) throw repoConfirmInvalid()
    const claims = readRepoConfirmToken(args.data.token, this.#o.mac, this.#now())
    const kind = claims.opensMergeRequest ? 'open_mr' : 'push'
    if (
      tokenSha256(args.data.token) !== row.tokenSha256 ||
      claims.kind !== 'push' ||
      row.kind !== kind ||
      claims.userId !== row.createdById ||
      claims.projectRepositoryId !== row.projectRepositoryId ||
      claims.taskId === null ||
      claims.taskId !== row.taskId ||
      (args.data.mergeRequest !== null) !== claims.opensMergeRequest
    )
      throw repoConfirmInvalid()
    return claims
  }

  async #push(
    row: ActionRow,
    claims: RepoConfirmClaims,
  ): Promise<{ sha: string; rebased: boolean; mergeRequest: PullRequest | null }> {
    const { prisma, workspace } = this.#o
    const taskId = claims.taskId!
    // The one who pressed: still the author of the project and a member of its workspace.
    const project = await projectOwnedBy(prisma, claims.projectId, claims.userId)
    if (project === null) throw repoConfirmInvalid()
    const repo = await prisma.projectRepository.findUnique({
      where: { id: row.projectRepositoryId },
      select: {
        id: true,
        projectId: true,
        provider: true,
        host: true,
        path: true,
        providerRepoId: true,
        defaultBranch: true,
        mode: true,
        connection: {
          select: {
            id: true,
            workspaceId: true,
            kind: true,
            host: true,
            state: true,
            createdById: true,
          },
        },
      },
    })
    if (repo === null || repo.projectId !== project.id) throw repoConfirmInvalid()
    if (repo.mode !== 'write' || repo.connection === null) throw repoReadOnly()
    if (repo.connection.state === 'reauth_needed') throw gitConnectionReauth()
    if (repo.connection.state !== 'ok' || repo.connection.createdById !== claims.userId)
      throw gitAccessDenied()
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, title: true },
    })
    if (task?.projectId !== project.id) throw repoConfirmInvalid()
    // What the card showed must be what stands now: the head of the chat and the diff of its card.
    const unsent = await unsentBranch(prisma, taskId)
    if (unsent === null) throw repoNothingToPush()
    if (
      unsent.head.headSha !== claims.headSha ||
      (unsent.card?.diffSha256 ?? null) !== claims.diffSha256
    )
      throw repoChanged()
    if (unsent.ciTouched) throw repoCiChangeNeedsCard()
    let branch = await chatBranch(prisma, taskId)
    if (
      branch === null ||
      branch.projectRepositoryId !== repo.id ||
      branch.branch !== claims.targetBranch ||
      !isAgentBranch(branch.branch, repo.defaultBranch)
    )
      throw repoChanged()

    const ref: RepoRef = {
      provider: repo.provider as RepoProviderKind,
      host: repo.host,
      path: repo.path,
      ...(repo.providerRepoId === null ? {} : { providerRepoId: repo.providerRepoId }),
    }
    const grant: GitGrant = await this.#o.auth.grantFor({
      id: repo.connection.id,
      workspaceId: repo.connection.workspaceId,
      kind: repo.connection.kind as GitConnectionKind,
      host: repo.connection.host,
    })
    const address = await this.#o.resolvePublic(ref.host)
    const provider = this.#o.provider({ kind: ref.provider, host: ref.host, address })
    const auth: GitAuth =
      grant.kind === 'token' ? { kind: 'bearer', token: grant.token } : { kind: 'anonymous' }
    // The right of the one who connected it, at the provider, before anything is sent (ПР10).
    const info = await provider.getRepository(auth, ref)
    if (info === null) throw gitAccessDenied()
    await this.#cancelAutoMerge(provider, auth, info.ref, repo.id, branch.branch)
    const access = await provider.issueCredentials(grant, info.ref, 'write', {
      ttlSeconds: GIT_CREDENTIAL_TTL_SECONDS,
    })
    let pushed: { sha: string; rebased: boolean } | null = null
    try {
      for (let attempt = 0; attempt < NAME_TRIES + 2 && pushed === null; attempt++) {
        const result = await workspace.pushChatBranch({
          projectRepositoryId: repo.id,
          chatId: taskId,
          remote: { cloneUrl: info.cloneUrl, pin: { host: ref.host, address }, access },
          branch: branch.branch,
          defaultBranch: repo.defaultBranch,
          head: unsent.head.headSha,
          sent:
            branch.mirrorSha !== null && branch.remoteSha !== null
              ? { remote: branch.remoteSha, mirror: branch.mirrorSha }
              : null,
          committedAt: this.#now().toISOString(),
        })
        if (result.kind === 'pushed') pushed = result
        else if (result.kind === 'conflict') throw new Refused(repoPushConflict().code)
        else if (result.kind === 'name_taken')
          // The name is someone's at the client: the chat takes the next one free in Радити.
          branch = await repoChatBranchName(prisma, {
            taskId,
            title: task.title,
            after: branch.branch,
          })
        // `raced`: the branch moved between the check and the push — once again.
        else if (attempt > 0) throw repoChanged()
      }
    } finally {
      await access.revoke?.().catch(() => undefined)
    }
    if (pushed === null) throw repoChanged()
    const sentBranch = branch.branch
    await prisma.projectRepoBranch.updateMany({
      where: { taskId, projectRepositoryId: repo.id },
      data: { mirrorSha: unsent.head.headSha, remoteSha: pushed.sha, state: 'pushed' },
    })
    // The ref of the mirror follows the head the client sent (ПР25: `/undo` moved only the turns).
    const current = await workspace.readChatRef(repo.id, taskId).catch(() => null)
    if (current !== unsent.head.headSha)
      await workspace.moveChatRef(repo.id, taskId, current, unsent.head.headSha).catch(() => false)

    let mergeRequest: PullRequest | null = null
    if (claims.opensMergeRequest)
      mergeRequest = await this.#openMergeRequest(provider, auth, info.ref, row, {
        repositoryId: repo.id,
        taskId,
        branch: sentBranch,
        target: repo.defaultBranch,
        head: pushed.sha,
      })
    return { ...pushed, mergeRequest }
  }

  /** «Отправить в ветку» first takes the provider's wait for the pipeline off (ПР15). */
  async #cancelAutoMerge(
    provider: GitProvider,
    auth: GitAuth,
    ref: RepoRef,
    repositoryId: string,
    branch: string,
  ): Promise<void> {
    if (!provider.support.autoMerge || !provider.cancelAutoMerge) return
    const waiting = await this.#o.prisma.projectMergeRequest.findMany({
      where: { projectRepositoryId: repositoryId, sourceBranch: branch, autoMerge: true },
      select: { number: true },
    })
    for (const { number } of waiting) {
      await provider.cancelAutoMerge(auth, ref, number)
      await this.#o.prisma.projectMergeRequest.updateMany({
        where: { projectRepositoryId: repositoryId, number },
        data: { autoMerge: false, syncedAt: this.#now() },
      })
    }
  }

  /**
   * The merge request of the first push (ПР14): the title and the description the client left on
   * the card, made harmless; read again at once — the target, the draft and no auto-merge must be
   * what was asked, or the request is closed and the chat is told.
   */
  async #openMergeRequest(
    provider: GitProvider,
    auth: GitAuth,
    ref: RepoRef,
    row: ActionRow,
    at: { repositoryId: string; taskId: string; branch: string; target: string; head: string },
  ): Promise<PullRequest> {
    const args = repoActionArgsSchema.parse(row.args)
    const asked = args.mergeRequest!
    const opened = await provider.openPullRequest(auth, ref, {
      head: at.branch,
      base: at.target,
      title: neutraliseMergeRequestTitle(asked.title),
      body: neutraliseMergeRequestDescription(asked.description),
      draft: asked.draft,
    })
    const read = await provider.getPullRequest(auth, ref, opened.number)
    const wanted = asked.draft ? 'draft' : 'open'
    if (
      read === null ||
      read.targetBranch !== at.target ||
      read.sourceBranch !== at.branch ||
      read.state !== wanted ||
      read.autoMerge
    ) {
      await provider.closePullRequest(auth, ref, opened.number).catch(() => undefined)
      throw new Refused('REPO_MR_CHANGED')
    }
    const now = this.#now()
    const fields = {
      taskId: at.taskId,
      sourceBranch: read.sourceBranch,
      targetBranch: read.targetBranch,
      title: read.title.slice(0, 255),
      state: read.state,
      headSha: /^[0-9a-f]{40}$/.test(read.headSha) ? read.headSha : at.head,
      mergeSha: read.mergeSha,
      checks: read.checks,
      autoMerge: read.autoMerge,
      webUrl: read.url,
      syncedAt: now,
    }
    await this.#o.prisma.projectMergeRequest.upsert({
      where: {
        projectRepositoryId_number: { projectRepositoryId: at.repositoryId, number: read.number },
      },
      create: {
        id: randomUUID(),
        projectRepositoryId: at.repositoryId,
        number: read.number,
        ...fields,
      },
      update: fields,
    })
    return read
  }

  /** The row ends, and the chat reads what the button did (`feed.repo_action`, `feed.repo_left`). */
  async #finish(
    row: ActionRow,
    state: 'done' | 'failed',
    error: string | null,
    result: { sha: string; rebased: boolean; mergeRequest: PullRequest | null } | null,
  ): Promise<void> {
    const { prisma } = this.#o
    const mr = result?.mergeRequest ?? null
    await prisma.$transaction(async (tx) => {
      await tx.repoAction.updateMany({
        where: { id: row.id, state: 'running' },
        data: {
          state,
          error,
          finishedAt: this.#now(),
          ...(result
            ? {
                result: {
                  sha: result.sha,
                  rebased: result.rebased,
                  ...(mr ? { number: mr.number, url: mr.url } : {}),
                },
              }
            : {}),
        },
      })
      if (row.taskId === null) return
      if (error === 'REPO_PUSH_CONFLICT')
        await insertFeedEvent(tx, {
          taskId: row.taskId,
          row: { type: 'feed.repo_left', payload: { v: 1, reason: 'conflict' } },
        })
      await insertFeedEvent(tx, {
        taskId: row.taskId,
        row: {
          type: 'feed.repo_action',
          payload: {
            v: 1,
            actionId: row.id,
            kind: row.kind === 'open_mr' ? 'open_mr' : 'push',
            state,
            ...(mr ? { number: mr.number, url: mr.url } : {}),
            ...(error ? { error: error.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) } : {}),
          },
        },
      })
    })
  }
}
