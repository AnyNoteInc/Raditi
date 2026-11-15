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

/**
 * `/undo` of a turn in a chat with the repository (docs/plan/61-chats-first.md, §5.14): core takes
 * `agent/<taskId>`, the candidate and the preview back to where the turn found them, without the
 * model; `/redo` brings them forward again, and the row of the press says which of the two it is.
 * Put by web (`task.undoTurn`, `task.redoTurn`) with the `feed.request` of the command. Ids only.
 */
export const CANDIDATE_REWIND_JOB = 'candidate.rewind'
/** The internal row of `task_events` that answers an `/undo` or a `/redo` (never shown to the client). */
export const CANDIDATE_REWIND_EVENT = 'candidate.rewind'
/**
 * The internal row a job writes right before it pushes (never shown to the client): the push may
 * have happened from here on, and `files` — what the feed will say — cannot be read again after it,
 * since the undone commit leaves the remote with the branch.
 */
export const CANDIDATE_REWIND_PUSH_EVENT = 'candidate.rewind.push'

export const candidateRewindJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** `task_events.id` of the `feed.request` of the command `turn_undo` or `turn_redo`. */
  requestEventId: feedEventIdSchema,
})
export type CandidateRewindJob = z.infer<typeof candidateRewindJobSchema>

/** The outbox key: `candidate.rewind:<taskId>:<requestEventId>`. */
export const candidateRewindDedupeKey = (job: CandidateRewindJob): string =>
  `${CANDIDATE_REWIND_JOB}:${job.taskId}:${job.requestEventId}`

/**
 * The client's edit of a file in «Терминал» of a chat with the code (owner's request of
 * 06.11.2026): core commits it to the chat's branch under the chat's lease — waiting while the
 * agent works — and records the next revision of its changes, so the agent's next turn starts
 * from it and `/release` takes it to the site. Put by web (`siteFiles.save`); the text lies in
 * the inbox bucket (`siteFileEditKey`). Ids only.
 */
export const CANDIDATE_EDIT_JOB = 'candidate.edit'

export const candidateEditJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** The id of the edit: its object in the inbox and its `feed.edit` row. */
  editId: z.uuid(),
})
export type CandidateEditJob = z.infer<typeof candidateEditJobSchema>

/** The outbox key: `candidate.edit:<taskId>:<editId>`. */
export const candidateEditDedupeKey = (job: CandidateEditJob): string =>
  `${CANDIDATE_EDIT_JOB}:${job.taskId}:${job.editId}`
