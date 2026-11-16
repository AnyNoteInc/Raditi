import { InjectQueue } from '@nestjs/bullmq'
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { gitJobNames, REPO_POLL_EVERY_MS } from '@repo/domain'
import { errorMessage } from '@repo/observability'
import type { Queue } from 'bullmq'

import { BACKGROUND_JOBS } from '../config/config.tokens.ts'
import { GIT_QUEUE } from './git.tokens.ts'

/** The id of the job scheduler of `git.poll`: one for all core processes. */
export const GIT_POLL_SCHEDULER_ID = 'git.poll'
/** After a failed registration the scheduler is tried again this much later. */
export const GIT_POLL_SCHEDULER_RETRY_MS = 30_000

/**
 * Registers the tick of `git.poll` (docs/plan/84-projects.md, ПР17, §4.3; slice 84.21) as a BullMQ
 * job scheduler, as LeadsScheduler does: every core process upserts the same one, each tick makes
 * one job for one worker. A tick has one attempt and leaves Redis at once: the next one reads the
 * rows again. Builds change in the chat without a reload and without webhooks (Э10).
 */
@Injectable()
export class GitPollScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #logger = new Logger(GitPollScheduler.name)
  readonly #queue: Pick<Queue, 'upsertJobScheduler'>
  readonly #background: boolean
  #retry: NodeJS.Timeout | undefined
  #stopping = false

  constructor(
    @InjectQueue(GIT_QUEUE) queue: Pick<Queue, 'upsertJobScheduler'>,
    @Inject(BACKGROUND_JOBS) background: boolean,
  ) {
    this.#queue = queue
    this.#background = background
  }

  onApplicationBootstrap(): void {
    if (!this.#background) return
    void this.register()
  }

  /** Upserts the scheduler; resolves to whether it stands. Never rejects. */
  async register(): Promise<boolean> {
    if (this.#stopping) return false
    try {
      await this.#queue.upsertJobScheduler(
        GIT_POLL_SCHEDULER_ID,
        { every: REPO_POLL_EVERY_MS },
        {
          name: gitJobNames.poll,
          data: {},
          opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 60 * 60 } },
        },
      )
    } catch (error) {
      if (this.#stopping) return false
      this.#logger.warn(
        `The poll of builds is not registered, next try in ${GIT_POLL_SCHEDULER_RETRY_MS / 1_000} s: ` +
          errorMessage(error),
      )
      this.#retry = setTimeout(() => void this.register(), GIT_POLL_SCHEDULER_RETRY_MS)
      this.#retry.unref()
      return false
    }
    this.#logger.log(`Builds of repositories are polled every ${REPO_POLL_EVERY_MS / 1_000} s`)
    return true
  }

  onModuleDestroy(): void {
    this.#stopping = true
    clearTimeout(this.#retry)
  }
}
