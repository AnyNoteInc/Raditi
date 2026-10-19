import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_QUEUE,
  agentTurnCancelDedupeKey,
  agentTurnCancelJobSchema,
  CANDIDATE_REBASE_JOB,
  candidateRebaseDedupeKey,
  candidateRebaseJobSchema,
  type AgentTurnCancelJob,
  type CandidateRebaseJob,
} from '@repo/domain'

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
