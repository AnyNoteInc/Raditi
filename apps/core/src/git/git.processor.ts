import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  gitActionPayloadSchema,
  gitCiLintPayloadSchema,
  gitConnectionSyncPayloadSchema,
  gitDeployActionsPayloadSchema,
  gitHookCreatePayloadSchema,
  gitHookRemovePayloadSchema,
  gitJobNames,
  gitLogPayloadSchema,
  gitPollPayloadSchema,
  gitRefreshPayloadSchema,
  gitRepoAttachPayloadSchema,
  gitRepoTreePayloadSchema,
  gitRepoForgetPayloadSchema,
  gitRepoInspectPayloadSchema,
} from '@repo/domain'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import type { GitJobs } from './git-jobs.ts'
import { GIT_JOBS, GIT_QUEUE, REPO_ACTIONS, REPO_CI, REPO_HOOKS } from './git.tokens.ts'
import type { RepoActions } from './repo-actions.ts'
import type { RepoCi } from './repo-ci.ts'
import type { RepoHooks } from './repo-hooks.ts'

/**
 * Works the queue `git` (docs/plan/84-projects.md, §4.3): the check of a connection, the branches
 * of a repository and the first fetch of the repository of a project; since 84.26 also the hints of
 * webhooks, the hooks of GitLab projects and the paths of the main branch for `@`. One attempt each: a failed
 * job is put again by the client's «Обновить» or its next look. Job data holds ids only; logs carry
 * the job name and id, never a token or a path of the client.
 */
@Processor(GIT_QUEUE, { concurrency: 2 })
export class GitProcessor extends WorkerHost {
  readonly #logger = new Logger(GitProcessor.name)
  readonly #jobs: Pick<
    GitJobs,
    | 'syncConnection'
    | 'inspectRepository'
    | 'attachRepository'
    | 'forgetRepository'
    | 'lintBranch'
    | 'sweep'
    | 'repoTree'
  >
  readonly #actions: Pick<RepoActions, 'run' | 'sweep'>
  readonly #ci: Pick<RepoCi, 'tick' | 'poll' | 'fetchLog' | 'syncDeployActions' | 'refresh'>
  readonly #hooks: Pick<RepoHooks, 'create' | 'remove' | 'tick'>
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(GIT_JOBS)
    jobs: Pick<
      GitJobs,
      | 'syncConnection'
      | 'inspectRepository'
      | 'attachRepository'
      | 'forgetRepository'
      | 'lintBranch'
      | 'sweep'
      | 'repoTree'
    >,
    @Inject(REPO_ACTIONS) actions: Pick<RepoActions, 'run' | 'sweep'>,
    @Inject(REPO_CI)
    ci: Pick<RepoCi, 'tick' | 'poll' | 'fetchLog' | 'syncDeployActions' | 'refresh'>,
    @Inject(REPO_HOOKS) hooks: Pick<RepoHooks, 'create' | 'remove' | 'tick'>,
  ) {
    super()
    this.#jobs = jobs
    this.#actions = actions
    this.#ci = ci
    this.#hooks = hooks
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case gitJobNames.connectionSync: {
        const data = gitConnectionSyncPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.connection.sync job')
        return this.#jobs.syncConnection(data.data.connectionId)
      }
      case gitJobNames.repoInspect: {
        const data = gitRepoInspectPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.repo.inspect job')
        return this.#jobs.inspectRepository(data.data.connectionId, data.data.providerRepoId)
      }
      case gitJobNames.repoAttach: {
        const data = gitRepoAttachPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.repo.attach job')
        return this.#jobs.attachRepository(data.data.projectRepositoryId)
      }
      // The mirror of a repository that was detached or whose project was purged (ПР20).
      case gitJobNames.repoForget: {
        const data = gitRepoForgetPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.repo.forget job')
        return this.#jobs.forgetRepository(data.data.projectRepositoryId)
      }
      // A press of the client on a card of a repository (docs/plan/84-projects.md, ПР13, ПР15).
      case gitJobNames.action: {
        const data = gitActionPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.action job')
        return this.#actions.run(data.data.actionId)
      }
      // The diff of the build settings of a chat's branch and its CI Lint (ПР16, slice 84.20).
      case gitJobNames.ciLint: {
        const data = gitCiLintPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.ci_lint job')
        return this.#jobs.lintBranch(data.data.taskId, data.data.headSha)
      }
      // The poll of builds and merge requests (ПР17; slice 84.21): the tick also ends the presses
      // a core left behind; with a repository — the look of its page.
      case gitJobNames.poll: {
        const data = gitPollPayloadSchema.safeParse(job.data ?? {})
        if (!data.success) throw new UnrecoverableError('Invalid git.poll job')
        if (data.data.projectRepositoryId !== undefined) {
          await this.#ci.poll(data.data.projectRepositoryId)
          return
        }
        // Each part of the tick goes whatever another did (ревью C13).
        for (const [part, run] of [
          ['actions', () => this.#actions.sweep()],
          ['ci', () => this.#ci.tick()],
          ['repositories', () => this.#jobs.sweep()],
          // Hooks to make, delivery ids past their week (slice 84.26).
          ['hooks', () => this.#hooks.tick()],
        ] as const)
          await run().catch((error: unknown) => this.#warn(`git.poll ${part}`, error))
        return
      }
      case gitJobNames.log: {
        const data = gitLogPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.log job')
        return this.#ci.fetchLog(data.data.projectRepositoryId, data.data.jobId)
      }
      case gitJobNames.deployActions: {
        const data = gitDeployActionsPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.repo.deploy_actions job')
        return this.#ci.syncDeployActions(data.data.projectRepositoryId)
      }
      // A hint of a webhook (ПР17; slice 84.26): the repository is read again from the provider.
      case gitJobNames.refresh: {
        const data = gitRefreshPayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.refresh job')
        await this.#ci.refresh(data.data)
        return
      }
      case gitJobNames.hookCreate: {
        const data = gitHookCreatePayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.hook.create job')
        return this.#hooks.create(data.data.projectRepositoryId)
      }
      case gitJobNames.hookRemove: {
        const data = gitHookRemovePayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.hook.remove job')
        return this.#hooks.remove(data.data)
      }
      // The paths of the main branch for `@` (ПР24; slice 84.26).
      case gitJobNames.repoTree: {
        const data = gitRepoTreePayloadSchema.safeParse(job.data)
        if (!data.success) throw new UnrecoverableError('Invalid git.repo.tree job')
        return this.#jobs.repoTree(data.data.projectRepositoryId, data.data.sha)
      }
      default:
        throw new UnrecoverableError(`Unknown git job "${job.name}"`)
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#logger.warn(
      `Git job ${job?.name ?? '?'} (job ${job?.id ?? '?'}) failed: ${errorMessage(err)}`,
    )
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${GIT_QUEUE}`, err)
  }
}
