import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnCancelJobSchema,
  agentTurnJobSchema,
  CANDIDATE_REBASE_JOB,
  candidateRebaseJobSchema,
  MAX_SANDBOX_TURN_MS,
  TURN_PUBLICATION_GRACE_MS,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'
import type { z } from 'zod'

import { CandidateRebase } from './candidate-rebase.ts'
import { PassRunner } from './pass-runner.ts'

/**
 * How many jobs of `agent-turns` one core works on at once: passes of different sites run side
 * by side (one site, one turn — the site lease), and a cancel or an update is not kept waiting
 * behind them for long.
 */
export const AGENT_TURN_CONCURRENCY = 8

/**
 * The lock of a job outlives the longest pass: a turn of 20 minutes, its publication grace and
 * the settlement after it. BullMQ renews it while the worker lives; a job whose worker died is
 * not run again (`maxStalledCount` 0): recovery owns the turn it may have started (spec §8).
 */
export const AGENT_TURN_LOCK_MS = MAX_SANDBOX_TURN_MS + TURN_PUBLICATION_GRACE_MS + 5 * 60_000

/** A payload that does not pass its schema never will: no retry. */
function parsed<T>(schema: z.ZodType<T>, job: Job): T {
  const result = schema.safeParse(job.data)
  if (!result.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
  return result.data
}

/**
 * Works the `agent-turns` queue (docs/plan/53-chat-preview-release.md, «Очереди и задания»):
 * a pass of the agent, the client's «Отменить» of a pass, «Обновить» of a candidate. Every
 * handler reads the state from PostgreSQL; the payload carries ids only, and so do the logs.
 */
@Processor(AGENT_TURN_QUEUE, {
  concurrency: AGENT_TURN_CONCURRENCY,
  lockDuration: AGENT_TURN_LOCK_MS,
  maxStalledCount: 0,
})
export class TurnsProcessor extends WorkerHost {
  readonly #logger = new Logger(TurnsProcessor.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(PassRunner) private readonly passes: Pick<PassRunner, 'run' | 'cancel'>,
    @Inject(CandidateRebase) private readonly rebase: Pick<CandidateRebase, 'run'>,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case AGENT_TURN_JOB:
        return this.passes.run(parsed(agentTurnJobSchema, job))
      case AGENT_TURN_CANCEL_JOB:
        return this.passes.cancel(parsed(agentTurnCancelJobSchema, job))
      case CANDIDATE_REBASE_JOB:
        await this.rebase.run(parsed(candidateRebaseJobSchema, job))
        return
      default:
        // A job this build does not know (left by another version) cannot succeed later.
        throw new UnrecoverableError(`Unknown ${AGENT_TURN_QUEUE} job "${job.name}"`)
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error): void {
    this.#warn(`${AGENT_TURN_QUEUE} ${job?.name ?? '?'} failed`, err)
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.#warn(`worker ${AGENT_TURN_QUEUE}`, err)
  }
}
