import { createHash, randomUUID } from 'node:crypto'

import {
  chatBranch,
  enqueueOutbox,
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
  readRepoCiPaths,
  readRepoConfirmToken,
  gitJobNames,
  REPO_CONFIRM_TTL_SECONDS,
  REPO_DIFF_KEPT_BYTES,
  repoActionArgsSchema,
  repoChanged,
  repoCiChangeNeedsCard,
  repoCiConfigForeign,
  repoCiDeclined,
  repoCiDiffTooLarge,
  repoCiLintSchema,
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
import { buildPathsOf } from './build-paths.ts'
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
// a row: every push is a press. A branch whose change touches build settings goes only by the card
// «Агент хочет изменить настройки сборки» (`ci_push`, ПР16; slice 84.20): its token names the
// SHA-256 of the diff of those files, and core makes that diff again before it sends anything.

/** A queued press older than this lost its job: it is put again while its token lives. */
export const REPO_ACTION_REQUEUE_MS = 2 * 60_000
/**
 * A press still `running` this long after it was made lost its core: every request of a press is
 * bounded (60 s a git command, the transport's time), so no live core holds one this long.
 */
export const REPO_ACTION_LOST_MS = 15 * 60_000

/** Names of a branch tried at the client when the chat's own is taken there. */
const NAME_TRIES = 5

export interface RepoActionsOptions {
  prisma: PrismaClient
  auth: Pick<GitAuthSource, 'grantFor'>
  resolvePublic: ResolvePublicHost
  provider: GitProviderFactory
  workspace: Pick<
    GitWorkspaceService,
    'pushChatBranch' | 'moveChatRef' | 'readChatRef' | 'buildSettingsChange'
  >
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

  /**
   * The sweeper of presses (the open item of 84.19 and 84.20), on every tick of `git.poll`:
   * - `queued` older than REPO_ACTION_REQUEUE_MS while its token lives — its job is put again
   *   (the row is taken once, so a second delivery does nothing);
   * - `queued` past the life of its token — `failed` REPO_CONFIRM_EXPIRED: it never ran;
   * - `running` older than REPO_ACTION_LOST_MS — its core went away mid-way and nobody knows
   *   whether the provider got it: `failed` REPO_ACTION_LOST, the chat says to look at the branch
   *   and press again. It is not run again: its token has expired by then, and a push or a merge
   *   request that did reach the provider must not be repeated blindly.
   * Each step is a conditional update: two sweepers end a row once.
   */
  async sweep(): Promise<{ requeued: number; expired: number; lost: number }> {
    const { prisma } = this.#o
    const now = this.#now()
    const ttl = new Date(now.getTime() - REPO_CONFIRM_TTL_SECONDS * 1000)
    const select = {
      id: true,
      projectRepositoryId: true,
      taskId: true,
      createdById: true,
      kind: true,
      args: true,
      tokenSha256: true,
      state: true,
    } as const
    const waiting = await prisma.repoAction.findMany({
      where: {
        state: 'queued',
        createdAt: { lt: new Date(now.getTime() - REPO_ACTION_REQUEUE_MS), gte: ttl },
      },
      select: { id: true },
      take: 100,
    })
    for (const row of waiting)
      await enqueueOutbox(prisma, {
        topic: 'git',
        type: gitJobNames.action,
        payload: { actionId: row.id },
        dedupeKey: `git.action.again:${row.id}:${Math.floor(now.getTime() / REPO_ACTION_REQUEUE_MS)}`,
      })
    let expired = 0
    for (const row of (await prisma.repoAction.findMany({
      where: { state: 'queued', createdAt: { lt: ttl } },
      select,
      take: 100,
    })) as ActionRow[])
      if (await this.#finish(row, 'failed', 'REPO_CONFIRM_EXPIRED', null, 'queued')) expired++
    let lost = 0
    for (const row of (await prisma.repoAction.findMany({
      where: { state: 'running', createdAt: { lt: new Date(now.getTime() - REPO_ACTION_LOST_MS) } },
      select,
      take: 100,
    })) as ActionRow[]) {
      if (await this.#finish(row, 'failed', 'REPO_ACTION_LOST', null, 'running')) lost++
      this.#o.logger.warn(`git.action ${row.id}: REPO_ACTION_LOST`)
    }
    return { requeued: waiting.length, expired, lost }
  }

  /** The token of the row, checked as web checked it, and its claims against the row (ПР15). */
  #checkToken(row: ActionRow): RepoConfirmClaims {
    if (this.#o.mac === null) throw repoConfirmInvalid()
    const args = repoActionArgsSchema.safeParse(row.args)
    if (!args.success) throw repoConfirmInvalid()
    const claims = readRepoConfirmToken(args.data.token, this.#o.mac, this.#now())
    // A press of «Разрешить и отправить» is `ci_push`, whatever else it opens (ПР16).
    const kind =
      claims.kind === 'ci_change' ? 'ci_push' : claims.opensMergeRequest ? 'open_mr' : 'push'
    if (
      tokenSha256(args.data.token) !== row.tokenSha256 ||
      (claims.kind !== 'push' && claims.kind !== 'ci_change') ||
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
        ciPaths: true,
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
    // A configuration of another project or an address: what the build runs cannot be shown.
    if (readRepoCiPaths(repo.ciPaths).foreign) throw repoCiConfigForeign()
    if (unsent.ciTouched !== (claims.kind === 'ci_change')) {
      if (unsent.ciTouched) throw repoCiChangeNeedsCard()
      throw repoChanged()
    }
    if (claims.kind === 'ci_change') await this.#checkCiChange(taskId, repo, claims)
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
    // GitHub (Э10): `workflows` only in the token of a press the card of build settings allowed.
    const access = await provider.issueCredentials(grant, info.ref, 'write', {
      ttlSeconds: GIT_CREDENTIAL_TTL_SECONDS,
      workflows: claims.kind === 'ci_change',
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
      data: {
        mirrorSha: unsent.head.headSha,
        remoteSha: pushed.sha,
        state: 'pushed',
        // What the client allowed of the build settings (ПР16).
        ...(claims.kind === 'ci_change' ? { ciConfirmedSha256: claims.ciDiffSha256 } : {}),
      },
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

  /**
   * The card of build settings showed what stands now (ПР16): `git.ci_lint` of this head, not
   * declined and not too large, and the diff of the build paths since the last push, made again
   * here from the mirror, has the SHA-256 the token names.
   */
  async #checkCiChange(
    taskId: string,
    repo: { id: string; provider: string; ciPaths: unknown },
    claims: RepoConfirmClaims,
  ): Promise<void> {
    const branch = await this.#o.prisma.projectRepoBranch.findUnique({
      where: { taskId },
      select: { baseSha: true, mirrorSha: true, ciLint: true },
    })
    const lint = repoCiLintSchema.safeParse(branch?.ciLint)
    if (branch === null || !lint.success || lint.data.headSha !== claims.headSha)
      throw repoChanged()
    if (lint.data.declined) throw repoCiDeclined()
    if (lint.data.tooLarge) throw repoCiDiffTooLarge()
    const change = await this.#o.workspace.buildSettingsChange({
      projectRepositoryId: repo.id,
      from: branch.mirrorSha ?? branch.baseSha,
      to: claims.headSha,
      isBuildPath: buildPathsOf(repo, lint.data.includes),
      maxBytes: REPO_DIFF_KEPT_BYTES,
    })
    if (change.patch === null) throw repoCiDiffTooLarge()
    const sha256 = change.paths.length
      ? createHash('sha256').update(change.patch).digest('hex')
      : null
    if (sha256 !== claims.ciDiffSha256) throw repoChanged()
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
    from: 'queued' | 'running' = 'running',
  ): Promise<boolean> {
    const { prisma } = this.#o
    const mr = result?.mergeRequest ?? null
    return prisma.$transaction(async (tx) => {
      const ended = await tx.repoAction.updateMany({
        where: { id: row.id, state: from },
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
      // Another sweeper or the job itself ended it first: the chat is told once.
      if (ended.count === 0) return false
      if (row.taskId === null) return true
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
            kind: row.kind === 'open_mr' || row.kind === 'ci_push' ? row.kind : 'push',
            state,
            ...(mr ? { number: mr.number, url: mr.url } : {}),
            ...(error ? { error: error.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) } : {}),
          },
        },
      })
      return true
    })
  }
}
