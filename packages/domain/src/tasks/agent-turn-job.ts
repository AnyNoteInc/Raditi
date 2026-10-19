import { z } from 'zod'

import type { QueueName } from '../ports/job-queue.ts'
import { feedEventIdSchema } from './client-feed.ts'

/**
 * The job of a pass of the agent (docs/plan/53-chat-preview-release.md, «Очереди и задания»;
 * N11/N12): put by web with the `feed.request` it answers (`task.create`, `task.message`,
 * «Продолжить») and by core when the site was busy. Ids only (CLAUDE.md rule 2); the processor
 * reads the task, its requests and its holds from PostgreSQL.
 */
export const AGENT_TURN_QUEUE = 'agent-turns' satisfies QueueName
export const AGENT_TURN_JOB = 'turn.run'

export const agentTurnJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** `tasks.attempt` when the request was written. */
  attempt: z.number().int().min(1),
  /** `task_events.id` of the `feed.request` this pass answers. */
  requestEventId: feedEventIdSchema,
})
export type AgentTurnJob = z.infer<typeof agentTurnJobSchema>

/** The outbox key: `turn.run:<taskId>:<attempt>:<requestEventId>` — one pass per request. */
export const agentTurnDedupeKey = (job: AgentTurnJob): string =>
  `${AGENT_TURN_JOB}:${job.taskId}:${job.attempt}:${job.requestEventId}`

/**
 * The job id of a pass put again directly (no database write, so no outbox) after `SITE_BUSY`:
 * `tag` makes it repeat at most once per tag, e.g. the lease epoch the pass waited for.
 */
export const agentTurnRetryJobId = (job: AgentTurnJob, tag: string): string =>
  `${agentTurnDedupeKey(job)}:retry:${tag}`

/**
 * Stop the pass a client cancelled while it was preparing or running (`task.cancel`): web
 * writes the `feed.request` of the command and this job; core stops the turn and moves the task
 * to `cancelled` itself, from the state in the database (docs/plan/53-chat-preview-release.md,
 * «Очереди и задания»). Ids only.
 */
export const AGENT_TURN_CANCEL_JOB = 'turn.cancel'

export const agentTurnCancelJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** `task_events.id` of the `feed.request` of the command `cancel`: who asked and when. */
  requestEventId: feedEventIdSchema,
})
export type AgentTurnCancelJob = z.infer<typeof agentTurnCancelJobSchema>

/** The outbox key: `turn.cancel:<taskId>:<requestEventId>` — one stop per press. */
export const agentTurnCancelDedupeKey = (job: AgentTurnCancelJob): string =>
  `${AGENT_TURN_CANCEL_JOB}:${job.taskId}:${job.requestEventId}`

/**
 * «Обновить» (`/update`, Р27): core carries the diff of the dialog's candidate onto the current
 * `main` without the model, rebuilds the preview and runs the checks again. Put by web
 * (`candidate.update`) with the `feed.request` of the command. Ids only.
 */
export const CANDIDATE_REBASE_JOB = 'candidate.rebase'

export const candidateRebaseJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** `task_events.id` of the `feed.request` of the command `update`. */
  requestEventId: feedEventIdSchema,
})
export type CandidateRebaseJob = z.infer<typeof candidateRebaseJobSchema>

/** The outbox key: `candidate.rebase:<taskId>:<requestEventId>`. */
export const candidateRebaseDedupeKey = (job: CandidateRebaseJob): string =>
  `${CANDIDATE_REBASE_JOB}:${job.taskId}:${job.requestEventId}`
