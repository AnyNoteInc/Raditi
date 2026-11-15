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
  /**
   * The place of the pass in the queue by the tier of its workspace (`tierQueuePriority`, plan
   * 69): 1 — «Агентство» … 4 — no tariff; the relay hands it to the queue, a repeat keeps it.
   * Absent in jobs of before 13.11.2026.
   */
  priority: z.number().int().min(1).max(4).optional(),
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
 * The queue of a chat after its pass ended (docs/plan/75-chat-input-output.md, ВВ2, ВВ4): core
 * takes the words that waited into the feed and starts the next pass, when the ending allows it.
 * Written by core in the transaction of the ending, so it exists exactly when the ending was
 * committed. Ids and counters only.
 */
export const QUEUE_DRAIN_JOB = 'queue.drain'

export const queueDrainJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** The attempt and the turn of the pass that ended: a later ending gets a job of its own. */
  attempt: z.number().int().min(1),
  turnNo: z.number().int().min(0),
})
export type QueueDrainJob = z.infer<typeof queueDrainJobSchema>

/** The outbox key: `queue.drain:<taskId>:<attempt>:<turnNo>` — one per ending of a pass. */
export const queueDrainDedupeKey = (job: QueueDrainJob): string =>
  `${QUEUE_DRAIN_JOB}:${job.taskId}:${job.attempt}:${job.turnNo}`

/**
 * A chat waits for its client after a pass (docs/plan/75-chat-input-output.md, ВВ6, ВВ7): core
 * tells the client — Web Push, a letter — unless the client looks at the chat. Written by core in
 * the transaction of the ending, due `CHAT_NOTIFY_DELAY_MS` later. Ids and the kind only.
 */
export const CHAT_NOTIFY_JOB = 'chat.notify'
export const CHAT_NOTIFY_DELAY_MS = 45_000
export const chatNotifyKinds = ['answered', 'question', 'ready', 'failed', 'limit'] as const
export type ChatNotifyKind = (typeof chatNotifyKinds)[number]

export const chatNotifyJobSchema = z.strictObject({
  taskId: z.uuid(),
  kind: z.enum(chatNotifyKinds),
  /** The attempt and the turn of the pass that ended: one notification per ending. */
  attempt: z.number().int().min(1),
  turnNo: z.number().int().min(0),
})
export type ChatNotifyJob = z.infer<typeof chatNotifyJobSchema>

export const chatNotifyDedupeKey = (job: ChatNotifyJob): string =>
  `${CHAT_NOTIFY_JOB}:${job.taskId}:${job.attempt}:${job.turnNo}:${job.kind}`
