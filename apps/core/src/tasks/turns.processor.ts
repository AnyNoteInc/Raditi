import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnCancelJobSchema,
  agentTurnJobSchema,
  CANDIDATE_EDIT_JOB,
  CANDIDATE_REBASE_JOB,
  CANDIDATE_REWIND_JOB,
  candidateEditJobSchema,
  candidateRebaseJobSchema,
  candidateRewindJobSchema,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'
import type { z } from 'zod'

import { CandidateEdit } from './candidate-edit.ts'
import { CandidateRebase } from './candidate-rebase.ts'
import { CandidateRewind } from './candidate-rewind.ts'
import { PassRunner } from './pass-runner.ts'

/**
 * How many jobs of `agent-turns` one core works on at once. Not the number of turns: those are
 * bounded by TurnCapacity (AGENT_TURN_CAPACITY, at most 64) and a pass without a place gives its
 * worker up at once (docs/plan/70-turn-without-time-limit.md, ВР16, ВР17). So turns without a
 * time limit hold at most the capacity of these, and a cancel, an update or an edit always finds
 * one free.
 */
export const AGENT_TURN_CONCURRENCY = 80

/**
 * The lock of a job. A pass has no time limit (docs/plan/70-turn-without-time-limit.md, ВР8):
 * BullMQ renews the lock every half of it while the worker lives, so a pass of any length keeps
 * its job, and a job whose worker died is not run again (`maxStalledCount` 0): recovery owns the
 * turn it may have started (spec §8).
 */
export const AGENT_TURN_LOCK_MS = 5 * 60_000

/** A payload that does not pass its schema never will: no retry. */
function parsed<T>(schema: z.ZodType<T>, job: Job): T {
  const result = schema.safeParse(job.data)
  if (!result.success) throw new UnrecoverableError(`Invalid ${job.name} payload`)
  return result.data
}

/**
 * Works the `agent-turns` queue (docs/plan/53-chat-preview-release.md, «Очереди и задания»):
 * a pass of the agent, the client's «Отменить» of a pass, «Обновить» of a candidate, `/undo` of a
 * turn. Every handler reads the state from PostgreSQL; the payload carries ids only, and so do
 * the logs.
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
    @Inject(CandidateRewind) private readonly rewind: Pick<CandidateRewind, 'run'>,
    @Inject(CandidateEdit) private readonly edit: Pick<CandidateEdit, 'run'>,
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
      case CANDIDATE_REWIND_JOB:
        await this.rewind.run(parsed(candidateRewindJobSchema, job))
        return
      case CANDIDATE_EDIT_JOB:
        await this.edit.run(parsed(candidateEditJobSchema, job))
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
