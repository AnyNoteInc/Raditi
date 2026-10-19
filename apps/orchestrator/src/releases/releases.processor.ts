import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  RELEASE_ADVANCE_JOB,
  RELEASE_QUEUE,
  RELEASE_UNDO_PLAN_JOB,
  releaseAdvanceJobSchema,
  releaseUndoPlanJobSchema,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import { ReleaseSkill } from './release-skill.ts'
import { UndoPlanner } from './undo-planner.ts'

/** Releases of different sites go side by side; one site has one release at a time (barrier). */
export const RELEASE_CONCURRENCY = 4
/**
 * One run publishes at most: a commit, two pushes, a tag, a wrapping and a secret, each bounded
 * by its own timeout. A job whose worker died is not run again (`maxStalledCount` 0): the
 * sweeper wakes the release, and the next run takes its lease over.
 */
export const RELEASE_LOCK_MS = 10 * 60_000

/**
 * Works `release.advance` of the `deploys` queue (docs/plan/53-chat-preview-release.md, «Очереди
 * и задания»): put by web at the confirmation, by the release API after a report and by the
 * sweeper. The payload names the release and the counter of its wake-up; the skill reads the row.
 * And `release.undoPlan` («Отмена выпуска»): the plan of an undo the window of the client asks for.
 */
@Processor(RELEASE_QUEUE, {
  concurrency: RELEASE_CONCURRENCY,
  lockDuration: RELEASE_LOCK_MS,
  maxStalledCount: 0,
})
export class ReleasesProcessor extends WorkerHost {
  readonly #logger = new Logger(ReleasesProcessor.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(ReleaseSkill) private readonly skill: Pick<ReleaseSkill, 'advance'>,
    @Inject(UndoPlanner) private readonly planner: Pick<UndoPlanner, 'plan'>,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name === RELEASE_UNDO_PLAN_JOB) {
      const parsed = releaseUndoPlanJobSchema.safeParse(job.data)
      if (!parsed.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
      await this.planner.plan(parsed.data)
      return
    }
    if (job.name !== RELEASE_ADVANCE_JOB)
      // A job this build does not know (left by another version) cannot succeed later.
      throw new UnrecoverableError(`Unknown ${RELEASE_QUEUE} job "${job.name}"`)
    const parsed = releaseAdvanceJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
    await this.skill.advance(parsed.data)
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#warn(`${RELEASE_QUEUE} ${job?.name ?? '?'} failed`, err)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${RELEASE_QUEUE}`, err)
  }
}
