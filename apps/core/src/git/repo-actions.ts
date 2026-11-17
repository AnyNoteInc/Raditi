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
  gitNotSupported,
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
  repoActionKinds,
  repoAlreadyMerged,
  repoAutoMergeOff,
  repoChanged,
  repoCiChangeNeedsCard,
  repoCiConfigForeign,
  repoCiDeclined,
  repoCiDiffTooLarge,
  repoCiLintSchema,
  repoConfirmInvalid,
  repoDeployGone,
  repoForeignCommits,
  repoChecksFailed,
  repoMergeTargetChanged,
  repoNoRequiredChecks,
  repoNotAllowed,
  repoNothingToPush,
  repoNotMergeable,
  repoPushConflict,
  repoReadOnly,
  type GitAuth,
  type GitConnectionKind,
  type GitProvider,
  type PullRequest,
  type RepoActionArgs,
  type RepoActionKind,
  type RepoConfirmClaims,
  type RepoMergeArgs,
  type RepoConfirmMac,
  type RepoProviderKind,
  type RepoRef,
} from '@repo/domain'

import type { GitWorkspaceService } from '../git-workspace/git-workspace.service.ts'
import { buildPathsOf } from './build-paths.ts'
import type { GitAuthSource } from './git-auth-source.ts'
import type { GitProviderFactory } from './git-jobs.ts'
import { openGitOperation, type GitOperation } from './git-operation.ts'
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
// «Принять в основную ветку» (`merge`, ПР15; slice 84.22) reads the merge request again — its target
// branch must still be the one the card showed and the main branch, its head the card's — and merges
// with that head expected; «Принять, когда сборка пройдёт» leaves the row `waiting` until `git.poll`
// reads the request merged, or the wait taken off. «Выкатить» (`deploy`) plays a manual job of the
// newest build of the main branch only while the head of that branch is still the card's. Nothing
// but a press of the client writes such a row: the agent and runs without a person never do (ПР19).
// A connection of the GitHub App acts for an installation, not for a person (ПР10, slice 84.25):
// before every push, request, merge and deploy core asks the provider what the person who connected
// it may do in this repository — push for a push and a request, `maintain` for a merge or a deploy
// into a protected branch. Where the provider has no wait of its own (GitHub), «Принять, когда
// сборка пройдёт» is the platform's (ПР15): the press waits while `git.poll` reads the checks of the
// head — the required checks of the main branch and every check suite — and merges with the head
// expected once they passed; without required checks the wait is refused.

/** A queued press older than this lost its job: it is put again while its token lives. */
export const REPO_ACTION_REQUEUE_MS = 2 * 60_000
/**
 * A press still `running` this long after it was made lost its core: every request of a press is
 * bounded (60 s a git command, the transport's time), so no live core holds one this long.
 */
export const REPO_ACTION_LOST_MS = 15 * 60_000

/** A press «Принять, когда сборка пройдёт» the platform waits for ends after this (ПР15). */
export const REPO_MERGE_WAIT_MAX_MS = 7 * 24 * 60 * 60_000

/** How a press of a merge waits for the build: the provider merges, or the platform does. */
export type MergeWait = 'provider' | 'platform'

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
  createdAt: Date
}

const actionSelect = {
  id: true,
  projectRepositoryId: true,
  taskId: true,
  createdById: true,
  kind: true,
  args: true,
  tokenSha256: true,
  state: true,
  createdAt: true,
} as const

/** What a press left: kept in `repo_actions.result`, and the request the chat links to. */
interface ActionResult {
  json: Record<string, string | number | boolean | null>
  number?: number
  url?: string
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
      select: actionSelect,
    })) as ActionRow | null
    if (row === null) return
    // A row is taken once: another delivery of the job finds it running or ended.
    const taken = await prisma.repoAction.updateMany({
      where: { id: actionId, state: 'queued' },
      data: { state: 'running' },
    })
    if (taken.count === 0) return
    try {
      const { claims, args } = this.#checkToken(row)
      if (row.kind === 'merge') {
        const merged = await this.#merge(row, claims, args.merge!)
        await this.#finish(row, merged.waiting ? 'waiting' : 'done', null, merged)
      } else if (row.kind === 'deploy')
        await this.#finish(row, 'done', null, await this.#deploy(row, claims))
      else {
        const pushed = await this.#push(row, claims)
        await this.#finish(row, 'done', null, {
          json: {
            sha: pushed.sha,
            rebased: pushed.rebased,
            ...(pushed.mergeRequest
              ? { number: pushed.mergeRequest.number, url: pushed.mergeRequest.url }
              : {}),
          },
          ...(pushed.mergeRequest
            ? { number: pushed.mergeRequest.number, url: pushed.mergeRequest.url }
            : {}),
        })
      }
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
    const select = actionSelect
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

  /**
   * The token of the row, checked as web checked it, and its claims against the row (ПР15). A
   * press that waits for the build is checked again at the moment it was made (`at`): its token
   * expired since, its HMAC and claims did not.
   */
  #checkToken(
    row: ActionRow,
    at: Date = this.#now(),
  ): { claims: RepoConfirmClaims; args: RepoActionArgs } {
    if (this.#o.mac === null) throw repoConfirmInvalid()
    const args = repoActionArgsSchema.safeParse(row.args)
    if (!args.success) throw repoConfirmInvalid()
    const claims = readRepoConfirmToken(args.data.token, this.#o.mac, at)
    if (
      tokenSha256(args.data.token) !== row.tokenSha256 ||
      claims.userId !== row.createdById ||
      claims.projectRepositoryId !== row.projectRepositoryId ||
      claims.taskId !== row.taskId ||
      row.kind !== kindOfClaims(claims)
    )
      throw repoConfirmInvalid()
    const merge = args.data.merge ?? null
    switch (claims.kind) {
      case 'push':
      case 'ci_change':
        if (
          claims.taskId === null ||
          merge !== null ||
          (args.data.mergeRequest !== null) !== claims.opensMergeRequest
        )
          throw repoConfirmInvalid()
        break
      case 'merge':
        if (
          claims.number === null ||
          claims.targetBranch === null ||
          claims.deploy !== null ||
          merge === null ||
          args.data.mergeRequest !== null
        )
          throw repoConfirmInvalid()
        break
      case 'deploy':
        if (
          claims.deploy === null ||
          claims.targetBranch === null ||
          merge !== null ||
          args.data.mergeRequest !== null
        )
          throw repoConfirmInvalid()
        break
    }
    return { claims, args: args.data }
  }

  /**
   * The repository of the press as it stands now: the one who pressed is still the author of the
   * project and a member of its workspace, the repository takes writes by that person's own
   * connection, which is `ok`.
   */
  async #writableRepository(row: ActionRow, claims: RepoConfirmClaims) {
    const { prisma } = this.#o
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
            installationId: true,
            githubUserId: true,
          },
        },
      },
    })
    if (repo === null || repo.projectId !== project.id) throw repoConfirmInvalid()
    if (repo.mode !== 'write' || repo.connection === null) throw repoReadOnly()
    if (repo.connection.state === 'reauth_needed') throw gitConnectionReauth()
    if (repo.connection.state !== 'ok' || repo.connection.createdById !== claims.userId)
      throw gitAccessDenied()
    return { project, repo, connection: repo.connection }
  }

  /**
   * The provider of the repository by the connection of the one who pressed, the access of the
   * operation to write, and their right (ПР10). The caller closes the operation.
   */
  async #operation(
    repo: {
      provider: string
      host: string
      path: string
      providerRepoId: string | null
      connection: {
        id: string
        workspaceId: string
        kind: string
        host: string
        installationId: bigint | null
        githubUserId: string | null
      }
    },
    need: { right: 'push' | 'merge'; branch: string; workflows?: boolean },
  ) {
    const ref: RepoRef = {
      provider: repo.provider as RepoProviderKind,
      host: repo.host,
      path: repo.path,
      ...(repo.providerRepoId === null ? {} : { providerRepoId: repo.providerRepoId }),
    }
    const grant = await this.#o.auth.grantFor({
      id: repo.connection.id,
      workspaceId: repo.connection.workspaceId,
      kind: repo.connection.kind as GitConnectionKind,
      host: repo.connection.host,
      installationId: repo.connection.installationId,
    })
    const op = await openGitOperation(this.#o, {
      kind: ref.provider,
      host: ref.host,
      grant,
      repo: ref,
      access: 'write',
      ...(need.workflows ? { workflows: true } : {}),
    })
    try {
      // The right of the one who connected it, at the provider, before anything is sent (ПР10).
      const info = await op.provider.getRepository(op.auth, ref)
      if (info === null) throw gitAccessDenied()
      await this.#checkPerson(op, info.ref, repo.connection.githubUserId, need)
      return { ref, address: op.address, provider: op.provider, auth: op.auth, info, op }
    } catch (error) {
      await op.close()
      throw error
    }
  }

  /**
   * What the person a connection of an app acts for may do here (ПР10): push for a push and a
   * merge request; for a merge or a deploy into a protected branch — `maintain`. A connection that
   * is the person's own (a GitLab token, a GitLab sign-in) has nobody else to check: the provider
   * refuses what its own access may not do.
   */
  async #checkPerson(
    op: Pick<GitOperation, 'provider' | 'auth'>,
    ref: RepoRef,
    person: string | null,
    need: { right: 'push' | 'merge'; branch: string },
  ): Promise<void> {
    if (person === null) return
    if (!op.provider.personRights) throw gitAccessDenied()
    const rights = await op.provider.personRights(op.auth, ref, person)
    if (!rights.push) throw repoNotAllowed('push')
    if (need.right !== 'merge' || rights.maintain) return
    const rules = op.provider.branchRules
      ? await op.provider.branchRules(op.auth, ref, need.branch)
      : { protected: true }
    if (rules.protected) throw repoNotAllowed('merge')
  }

  /**
   * «Принять в основную ветку» and «Принять, когда сборка пройдёт» (ПР15). The merge request is
   * read again: its target must still be what the card showed and the main branch (a target the
   * client changed after the card is refused), its source and its head the card's; the provider
   * merges only with that head expected — a new head is its 409, REPO_CHANGED. Where the provider
   * has no wait of its own (`support.checksWait`), the platform waits: the required checks of the
   * main branch and every check suite of the head; pending — the press waits, failed — refused,
   * passed — merged now. `continuing` — a press that waits, read again by `git.poll`.
   */
  async #merge(
    row: ActionRow,
    claims: RepoConfirmClaims,
    merge: RepoMergeArgs,
    continuing = false,
  ): Promise<ActionResult & { waiting: boolean }> {
    const { prisma } = this.#o
    const { repo, connection } = await this.#writableRepository(row, claims)
    const number = claims.number!
    const cached = await prisma.projectMergeRequest.findUnique({
      where: { projectRepositoryId_number: { projectRepositoryId: repo.id, number } },
      select: { sourceBranch: true, taskId: true },
    })
    if (cached === null || cached.taskId !== row.taskId) throw repoConfirmInvalid()
    const { provider, auth, info, op } = await this.#operation(
      { ...repo, connection },
      { right: 'merge', branch: repo.defaultBranch },
    )
    try {
      const whenGreen = merge.mode === 'when_green'
      const wait: MergeWait | null = !whenGreen
        ? null
        : provider.support.autoMerge
          ? 'provider'
          : provider.support.checksWait && provider.headChecks && provider.branchRules
            ? 'platform'
            : null
      if (whenGreen && wait === null) throw gitNotSupported('a merge when green')
      const read = await provider.getPullRequest(auth, info.ref, number)
      if (read === null || read.state === 'closed') throw repoNotMergeable()
      if (read.state === 'merged') throw repoAlreadyMerged()
      if (read.targetBranch !== claims.targetBranch || read.targetBranch !== repo.defaultBranch)
        throw repoMergeTargetChanged()
      if (read.sourceBranch !== cached.sourceBranch || read.headSha !== claims.headSha)
        throw repoChanged()
      // A chat's branch: the head is the commit Радити sent, nothing pushed past it (ревью,
      // безопасность 4).
      if (row.taskId !== null) {
        const branch = await prisma.projectRepoBranch.findUnique({
          where: { taskId: row.taskId },
          select: { remoteSha: true, branch: true },
        })
        if (branch?.branch === read.sourceBranch && branch.remoteSha !== read.headSha)
          throw repoForeignCommits()
      }
      if (read.state === 'draft') throw repoNotMergeable()
      const json = {
        number,
        url: read.url,
        mode: merge.mode,
        deleteBranch: merge.deleteBranch,
      }
      if (wait === 'platform') {
        // «Сборка прошла» needs a check the main branch requires: a workflow of the agent's own
        // branch could report success otherwise (ПР15, ревью).
        const rules = await provider.branchRules!(auth, info.ref, read.targetBranch)
        if (rules.requiredChecks.length === 0) throw repoNoRequiredChecks()
        const checks = await provider.headChecks!(
          auth,
          info.ref,
          claims.headSha,
          rules.requiredChecks,
        )
        if (checks === 'failure') throw repoChecksFailed()
        if (checks === 'pending')
          return {
            waiting: true,
            json: { ...json, mergeSha: null, wait: 'platform', headSha: claims.headSha },
            number,
            url: read.url,
          }
      }
      const merged = await provider.mergePullRequest(auth, info.ref, number, {
        expectedHeadSha: claims.headSha,
        deleteBranch: merge.deleteBranch,
        whenGreen: wait === 'provider',
      })
      const now = this.#now()
      const mergeSha = merged.mergeSha ?? null
      await prisma.$transaction(async (tx) => {
        await tx.projectMergeRequest.updateMany({
          where: { projectRepositoryId: repo.id, number },
          data:
            merged.state === 'merged'
              ? { state: 'merged', mergeSha, autoMerge: false, syncedAt: now }
              : { autoMerge: true, syncedAt: now },
        })
        if (merged.state === 'merged')
          await tx.projectRepoBranch.updateMany({
            where: {
              projectRepositoryId: repo.id,
              branch: read.sourceBranch,
              state: { in: ['pushed', 'closed'] },
              ...(row.taskId === null ? {} : { taskId: row.taskId }),
            },
            data: { state: 'merged' },
          })
      })
      if (continuing) this.#o.logger.log(`git.action ${row.id}: merged after its checks`)
      return {
        waiting: merged.state === 'scheduled',
        json: { ...json, mergeSha, ...(wait === null ? {} : { wait }) },
        number,
        url: read.url,
      }
    } finally {
      await op.close()
    }
  }

  /**
   * The presses «Принять, когда сборка пройдёт» the platform waits for (ПР15), on a poll of their
   * repository: each is checked again — its token as of the moment it was made, the person, the
   * repository, the right — and the merge request read again; checks passed — merged, failed or the
   * head moved — the press ends with that said in the chat; still running — it waits on, up to
   * REPO_MERGE_WAIT_MAX_MS.
   */
  async continueWaits(projectRepositoryId: string): Promise<{ merged: number; ended: number }> {
    const rows = (await this.#o.prisma.repoAction.findMany({
      where: {
        projectRepositoryId,
        kind: 'merge',
        state: 'waiting',
        result: { path: ['wait'], equals: 'platform' },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: actionSelect,
    })) as ActionRow[]
    let merged = 0
    let ended = 0
    for (const row of rows) {
      try {
        if (this.#now().getTime() - row.createdAt.getTime() > REPO_MERGE_WAIT_MAX_MS)
          throw repoAutoMergeOff()
        const { claims, args } = this.#checkToken(row, row.createdAt)
        if (claims.kind !== 'merge' || args.merge?.mode !== 'when_green') throw repoConfirmInvalid()
        const result = await this.#merge(row, claims, args.merge, true)
        if (result.waiting) continue
        if (await this.#finish(row, 'done', null, result, 'waiting')) merged++
      } catch (error) {
        const code = isDomainError(error) ? error.code : 'GIT_OPERATION_FAILED'
        // Merged by the client in the meantime: what the press asked for is done.
        if (code === repoAlreadyMerged().code) {
          if (await this.#finish(row, 'done', null, null, 'waiting')) ended++
          continue
        }
        // A provider that does not answer now is asked again on the next poll.
        if (code === 'GIT_PROVIDER_FAILED') continue
        this.#o.logger.warn(`git.action ${row.id}: ${code}`)
        if (await this.#finish(row, 'failed', code.slice(0, 40), null, 'waiting')) ended++
      }
    }
    return { merged, ended }
  }

  /**
   * «Выкатить» (ПР15): a manual job of the newest build of the main branch, or a workflow that runs
   * on `workflow_dispatch` at its head. The head of the main branch is read again first — moved
   * since the card, REPO_CHANGED, so nothing unmerged and nothing the client did not see goes out —
   * and the action must still be of that head.
   */
  async #deploy(row: ActionRow, claims: RepoConfirmClaims): Promise<ActionResult> {
    const { prisma } = this.#o
    const { repo, connection } = await this.#writableRepository(row, claims)
    const asked = claims.deploy!
    if (claims.targetBranch !== repo.defaultBranch || asked.ref !== repo.defaultBranch)
      throw repoChanged()
    const { provider, auth, info, op } = await this.#operation(
      { ...repo, connection },
      { right: 'merge', branch: repo.defaultBranch },
    )
    try {
      const supported =
        asked.kind === 'manual_job'
          ? provider.support.manualJobs
          : provider.support.workflowDispatch
      if (!supported || !provider.branchHead) throw gitNotSupported('this deploy')
      const head = await provider.branchHead(auth, info.ref, repo.defaultBranch)
      if (head !== claims.headSha) throw repoChanged()
      const action = (await provider.listDeployActions(auth, info.ref, repo.defaultBranch)).find(
        (item) => item.kind === asked.kind && item.id === asked.id,
      )
      if (action === undefined) throw repoDeployGone()
      if (action.sha !== claims.headSha || action.ref !== repo.defaultBranch) throw repoChanged()
      const started = await provider.startDeploy(auth, info.ref, action)
      // The build and its jobs are read again: the played job is not a manual one any more.
      for (const type of [gitJobNames.poll, gitJobNames.deployActions])
        await enqueueOutbox(prisma, {
          topic: 'git',
          type,
          payload: { projectRepositoryId: repo.id },
          dedupeKey: `${type}:deploy:${row.id}`,
        })
      return { json: { sha: head, job: action.id, name: action.name, runId: started.runId } }
    } finally {
      await op.close()
    }
  }

  async #push(
    row: ActionRow,
    claims: RepoConfirmClaims,
  ): Promise<{ sha: string; rebased: boolean; mergeRequest: PullRequest | null }> {
    const { prisma, workspace } = this.#o
    const taskId = claims.taskId!
    const { project, repo, connection } = await this.#writableRepository(row, claims)
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, title: true },
    })
    if (task?.projectId !== project.id) throw repoConfirmInvalid()
    // What the card showed must be what stands now: the head of the chat and the diff of its card.
    const unsent = await unsentBranch(prisma, taskId)
    if (unsent === null) return this.#mergeRequestOnly(row, claims, taskId)
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
    // The card's flag is read again from the commits themselves (ревью, безопасность 2): an
    // ordinary «Отправить» sends nothing of the build settings, whatever the card was told.
    if (claims.kind !== 'ci_change' && branch !== null) {
      const change = await workspace.buildSettingsChange({
        projectRepositoryId: repo.id,
        from: branch.mirrorSha ?? branch.baseSha,
        to: unsent.head.headSha,
        isBuildPath: buildPathsOf(repo),
        maxBytes: 0,
      })
      if (change.paths.length) throw repoCiChangeNeedsCard()
    }
    if (
      branch === null ||
      branch.projectRepositoryId !== repo.id ||
      branch.branch !== claims.targetBranch ||
      !isAgentBranch(branch.branch, repo.defaultBranch)
    )
      throw repoChanged()

    // `workflows` only in the access of a press the card of build settings allowed (ПР16): GitHub
    // refuses a push of a workflow without it — the second line.
    const { ref, address, provider, auth, info, op } = await this.#operation(
      { ...repo, connection },
      { right: 'push', branch: branch.branch, workflows: claims.kind === 'ci_change' },
    )
    const access = op.access
    let pushed: { sha: string; rebased: boolean } | null = null
    let mergeRequest: PullRequest | null = null
    try {
      await this.#cancelAutoMerge(provider, auth, info.ref, repo.id, branch.branch)
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
        await workspace
          .moveChatRef(repo.id, taskId, current, unsent.head.headSha)
          .catch(() => false)

      if (claims.opensMergeRequest)
        mergeRequest = await this.#openMergeRequest(provider, auth, info.ref, row, {
          repositoryId: repo.id,
          taskId,
          branch: sentBranch,
          target: repo.defaultBranch,
          head: pushed.sha,
        })
      return { ...pushed, mergeRequest }
    } finally {
      await op.close()
    }
  }

  /**
   * The merge request of a branch sent already (ревью C5): the push went, the merge request did
   * not open. Nothing is pushed: the head the token names is what the client was sent.
   */
  async #mergeRequestOnly(
    row: ActionRow,
    claims: RepoConfirmClaims,
    taskId: string,
  ): Promise<{ sha: string; rebased: boolean; mergeRequest: PullRequest | null }> {
    const { prisma } = this.#o
    const { repo, connection } = await this.#writableRepository(row, claims)
    const branch = await chatBranch(prisma, taskId)
    if (
      !claims.opensMergeRequest ||
      claims.diffSha256 !== null ||
      branch === null ||
      branch.projectRepositoryId !== repo.id ||
      branch.branch !== claims.targetBranch ||
      branch.state !== 'pushed' ||
      branch.mirrorSha !== claims.headSha ||
      branch.remoteSha === null
    )
      throw repoNothingToPush()
    const open = await prisma.projectMergeRequest.findFirst({
      where: {
        projectRepositoryId: repo.id,
        sourceBranch: branch.branch,
        state: { in: ['open', 'draft', 'merged'] },
      },
      select: { number: true },
    })
    if (open !== null) throw repoNothingToPush()
    const remoteSha = branch.remoteSha
    const { provider, auth, info, op } = await this.#operation(
      { ...repo, connection },
      { right: 'push', branch: branch.branch },
    )
    try {
      const mergeRequest = await this.#openMergeRequest(provider, auth, info.ref, row, {
        repositoryId: repo.id,
        taskId,
        branch: branch.branch,
        target: repo.defaultBranch,
        head: remoteSha,
      })
      return { sha: remoteSha, rebased: false, mergeRequest }
    } finally {
      await op.close()
    }
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

  /**
   * «Отправить в ветку» first takes the wait for the build off (ПР15): the provider's auto-merge, and
   * the presses the platform waits for — what they would merge is not the branch any more.
   */
  async #cancelAutoMerge(
    provider: GitProvider,
    auth: GitAuth,
    ref: RepoRef,
    repositoryId: string,
    branch: string,
  ): Promise<void> {
    const requests = await this.#o.prisma.projectMergeRequest.findMany({
      where: { projectRepositoryId: repositoryId, sourceBranch: branch },
      select: { number: true, autoMerge: true },
    })
    for (const { number, autoMerge } of requests) {
      if (autoMerge && provider.support.autoMerge && provider.cancelAutoMerge) {
        await provider.cancelAutoMerge(auth, ref, number)
        await this.#o.prisma.projectMergeRequest.updateMany({
          where: { projectRepositoryId: repositoryId, number },
          data: { autoMerge: false, syncedAt: this.#now() },
        })
      }
      // A press that waited for the build ends: what it would have merged is not the branch now.
      await endWaitingMerges(this.#o.prisma, {
        projectRepositoryId: repositoryId,
        number,
        merged: false,
        now: this.#now(),
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
    state: 'done' | 'failed' | 'waiting',
    error: string | null,
    result: ActionResult | null,
    from: 'queued' | 'running' | 'waiting' = 'running',
  ): Promise<boolean> {
    const { prisma } = this.#o
    return prisma.$transaction(async (tx) => {
      const ended = await tx.repoAction.updateMany({
        where: { id: row.id, state: from },
        data: {
          state,
          error,
          // `waiting` has not ended: the provider merges once the build passes.
          finishedAt: state === 'waiting' ? null : this.#now(),
          ...(result ? { result: result.json } : {}),
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
            kind: feedKindOf(row.kind),
            state,
            ...(result?.number === undefined ? {} : { number: result.number }),
            ...(result?.url === undefined ? {} : { url: result.url }),
            ...(error ? { error: error.replace(/[^A-Z0-9_]/g, '_').slice(0, 64) } : {}),
          },
        },
      })
      return true
    })
  }
}

/** The kind of row a press of these claims writes (web writes it so, core checks it so). */
function kindOfClaims(claims: RepoConfirmClaims): RepoActionKind {
  switch (claims.kind) {
    // A press of «Разрешить и отправить» is `ci_push`, whatever else it opens (ПР16).
    case 'ci_change':
      return 'ci_push'
    case 'push':
      return claims.opensMergeRequest ? 'open_mr' : 'push'
    case 'merge':
    case 'deploy':
      return claims.kind
  }
}

const feedKindOf = (kind: string): RepoActionKind =>
  (repoActionKinds as readonly string[]).includes(kind) ? (kind as RepoActionKind) : 'push'

/**
 * The presses «Принять, когда сборка пройдёт» of one merge request that still wait (ПР15) end:
 * `done` when the provider merged it (`git.poll` read it so), `failed` REPO_AUTO_MERGE_OFF when the
 * wait was taken off — by «Отправить в ветку», in the repository, or the request closed. Each row
 * ends by a conditional update, and the chat is told once.
 */
export async function endWaitingMerges(
  prisma: PrismaClient,
  input: {
    projectRepositoryId: string
    number: number
    merged: boolean
    now: Date
    /**
     * Only the presses the provider waits for (its auto-merge was taken off); the platform's own
     * waits (ПР15) end by their own reading of the checks. Absent — every wait of the request.
     */
    only?: MergeWait
  },
): Promise<number> {
  const found = await prisma.repoAction.findMany({
    where: {
      projectRepositoryId: input.projectRepositoryId,
      kind: 'merge',
      state: 'waiting',
      result: { path: ['number'], equals: input.number },
    },
    select: { id: true, taskId: true, result: true },
    take: 20,
  })
  const waitOf = (result: unknown): MergeWait =>
    (result as Record<string, unknown> | null)?.wait === 'platform' ? 'platform' : 'provider'
  const waiting =
    input.only === undefined ? found : found.filter((row) => waitOf(row.result) === input.only)
  let ended = 0
  for (const row of waiting) {
    const result = (row.result ?? {}) as Record<string, unknown>
    const url = typeof result.url === 'string' ? result.url : undefined
    const done = await prisma.$transaction(async (tx) => {
      const changed = await tx.repoAction.updateMany({
        where: { id: row.id, state: 'waiting' },
        data: {
          state: input.merged ? 'done' : 'failed',
          error: input.merged ? null : repoAutoMergeOff().code,
          finishedAt: input.now,
        },
      })
      if (changed.count === 0) return false
      if (row.taskId !== null)
        await insertFeedEvent(tx, {
          taskId: row.taskId,
          row: {
            type: 'feed.repo_action',
            payload: {
              v: 1,
              actionId: row.id,
              kind: 'merge',
              state: input.merged ? 'done' : 'failed',
              number: input.number,
              ...(url ? { url } : {}),
              ...(input.merged ? {} : { error: repoAutoMergeOff().code }),
            },
          },
        })
      return true
    })
    if (done) ended++
  }
  return ended
}
