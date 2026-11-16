import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  gitActionPayloadSchema,
  gitCiLintPayloadSchema,
  gitConnectionSyncPayloadSchema,
  gitJobNames,
  gitRepoAttachPayloadSchema,
  gitRepoInspectPayloadSchema,
} from '@repo/domain'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import type { GitJobs } from './git-jobs.ts'
import { GIT_JOBS, GIT_QUEUE, REPO_ACTIONS } from './git.tokens.ts'
import type { RepoActions } from './repo-actions.ts'

/**
 * Works the queue `git` (docs/plan/84-projects.md, §4.3): the check of a connection, the branches
 * of a repository and the first fetch of the repository of a project. One attempt each: a failed
 * job is put again by the client's «Обновить» or its next look. Job data holds ids only; logs carry
 * the job name and id, never a token or a path of the client.
 */
@Processor(GIT_QUEUE, { concurrency: 2 })
export class GitProcessor extends WorkerHost {
  readonly #logger = new Logger(GitProcessor.name)
  readonly #jobs: Pick<
    GitJobs,
    'syncConnection' | 'inspectRepository' | 'attachRepository' | 'lintBranch'
  >
  readonly #actions: Pick<RepoActions, 'run'>
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(GIT_JOBS)
    jobs: Pick<GitJobs, 'syncConnection' | 'inspectRepository' | 'attachRepository' | 'lintBranch'>,
    @Inject(REPO_ACTIONS) actions: Pick<RepoActions, 'run'>,
  ) {
    super()
    this.#jobs = jobs
    this.#actions = actions
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
