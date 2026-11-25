import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnCancelJobSchema,
  agentTurnJobSchema,
  ARTIFACT_DIAGRAM_JOB,
  ARTIFACT_NOTIFY_JOB,
  artifactDiagramJobSchema,
  CHAT_DIAGRAM_JOB,
  chatDiagramJobSchema,
  artifactNotifyJobSchema,
  CHAT_NOTIFY_JOB,
  chatNotifyJobSchema,
  QUEUE_DRAIN_JOB,
  queueDrainJobSchema,
  runnerLimits,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'
import type { z } from 'zod'

import { PassRunner } from './pass-runner.ts'
import { ArtifactDiagram } from './artifact-diagram.ts'
import { ChatDiagram } from './chat-diagram.ts'
import { ArtifactNotify } from './artifact-notify.ts'
import { ChatNotify } from './chat-notify.ts'
import { QueueDrain } from './queue-drain.ts'

/**
 * How many jobs of `agent-turns` one core works on at once: every turn a runner can hold
 * (`runnerLimits.capacity`, TurnCapacity) and 32 more, so a cancel or a notice always finds one
 * free while every turn runs (docs/plan/70-turn-without-time-limit.md, ВР16, ВР26). A
 * pass without a place gives its worker up at once.
 */
export const AGENT_TURN_CONCURRENCY = runnerLimits.capacity + 32

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
 * Works the `agent-turns` queue: a pass of the agent, the client's «Отменить» of a pass, the queue
 * of a chat after its pass and the notice of a waiting chat. Every handler reads the state from PostgreSQL; the payload carries ids only, and so do
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
    @Inject(QueueDrain) private readonly queue: Pick<QueueDrain, 'run'>,
    @Inject(ChatNotify) private readonly notify: Pick<ChatNotify, 'run'>,
    @Inject(ArtifactNotify) private readonly artifactNotify: Pick<ArtifactNotify, 'run'>,
    @Inject(ArtifactDiagram) private readonly artifactDiagram: Pick<ArtifactDiagram, 'run'>,
    @Inject(ChatDiagram) private readonly chatDiagram: Pick<ChatDiagram, 'run'>,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case AGENT_TURN_JOB:
        return this.passes.run(parsed(agentTurnJobSchema, job))
      case AGENT_TURN_CANCEL_JOB:
        return this.passes.cancel(parsed(agentTurnCancelJobSchema, job))
      case QUEUE_DRAIN_JOB:
        await this.queue.run(parsed(queueDrainJobSchema, job))
        return
      case CHAT_NOTIFY_JOB:
        await this.notify.run(parsed(chatNotifyJobSchema, job))
        return
      case ARTIFACT_NOTIFY_JOB:
        await this.artifactNotify.run(parsed(artifactNotifyJobSchema, job))
        return
      case ARTIFACT_DIAGRAM_JOB:
        await this.artifactDiagram.run(parsed(artifactDiagramJobSchema, job))
        return
      case CHAT_DIAGRAM_JOB:
        await this.chatDiagram.run(parsed(chatDiagramJobSchema, job))
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
