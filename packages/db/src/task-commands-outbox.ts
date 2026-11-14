import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_QUEUE,
  agentTurnCancelDedupeKey,
  agentTurnCancelJobSchema,
  CANDIDATE_REBASE_JOB,
  CANDIDATE_REWIND_JOB,
  candidateRebaseDedupeKey,
  candidateRebaseJobSchema,
  candidateRewindDedupeKey,
  candidateRewindJobSchema,
  CHAT_NOTIFY_DELAY_MS,
  CHAT_NOTIFY_JOB,
  chatNotifyDedupeKey,
  chatNotifyJobSchema,
  QUEUE_DRAIN_JOB,
  queueDrainDedupeKey,
  queueDrainJobSchema,
  type AgentTurnCancelJob,
  type ChatNotifyJob,
  type QueueDrainJob,
  type CandidateRebaseJob,
  type CandidateRewindJob,
} from '@repo/domain'

import type { Prisma } from './generated/prisma/client.ts'
import { enqueueOutbox, type OutboxWriter } from './outbox.ts'

// Commands of a dialog that core carries out on the `agent-turns` queue
// (docs/plan/53-chat-preview-release.md, «Очереди и задания»): web writes each with the
// `feed.request` of the command, in the transaction of that row. Ids only (CLAUDE.md, rule 2);
// the key carries the request, so every press gets its job. Each helper returns false when a
// row with its key already exists.

const lower = (id: string): string => id.toLowerCase()

/** «Отменить» while a pass is preparing or running: core stops it and cancels the task. */
export async function enqueueTurnCancel(
  tx: OutboxWriter,
  job: AgentTurnCancelJob,
): Promise<boolean> {
  const parsed = agentTurnCancelJobSchema.parse(job)
  const payload: AgentTurnCancelJob = { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: AGENT_TURN_CANCEL_JOB,
    payload,
    dedupeKey: agentTurnCancelDedupeKey(payload),
  })
}

/**
 * The queue of a chat after a pass ended (docs/plan/75, ВВ2): core takes its words into the feed.
 * Written only when the chat has words queued: a chat without a queue gets no job.
 */
export async function enqueueQueueDrain(
  tx: OutboxWriter & Pick<Prisma.TransactionClient, 'taskQueuedMessage'>,
  job: QueueDrainJob,
): Promise<boolean> {
  const parsed = queueDrainJobSchema.parse(job)
  if ((await tx.taskQueuedMessage.count({ where: { taskId: parsed.taskId } })) === 0) return false
  const payload: QueueDrainJob = { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: QUEUE_DRAIN_JOB,
    payload,
    dedupeKey: queueDrainDedupeKey(payload),
  })
}

/**
 * A chat waits for its client (docs/plan/75, ВВ6): core decides when it is due whether the client
 * is told, and how. `now` — the moment of the ending.
 */
export async function enqueueChatNotify(
  tx: OutboxWriter,
  job: ChatNotifyJob,
  now: Date,
): Promise<boolean> {
  const parsed = chatNotifyJobSchema.parse(job)
  const payload: ChatNotifyJob = { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: CHAT_NOTIFY_JOB,
    payload,
    dedupeKey: chatNotifyDedupeKey(payload),
    availableAt: new Date(now.getTime() + CHAT_NOTIFY_DELAY_MS),
  })
}

/** «Обновить» (`/update`): core carries the candidate onto the current `main`. */
export async function enqueueCandidateRebase(
  tx: OutboxWriter,
  job: CandidateRebaseJob,
): Promise<boolean> {
  const parsed = candidateRebaseJobSchema.parse(job)
  const payload: CandidateRebaseJob = { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: CANDIDATE_REBASE_JOB,
    payload,
    dedupeKey: candidateRebaseDedupeKey(payload),
  })
}

/** `/undo` and `/redo` in a chat with the repository: core moves the branch and the candidate. */
export async function enqueueCandidateRewind(
  tx: OutboxWriter,
  job: CandidateRewindJob,
): Promise<boolean> {
  const parsed = candidateRewindJobSchema.parse(job)
  const payload: CandidateRewindJob = { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: AGENT_TURN_QUEUE,
    type: CANDIDATE_REWIND_JOB,
    payload,
    dedupeKey: candidateRewindDedupeKey(payload),
  })
}
