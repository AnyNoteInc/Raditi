import { describe, expect, it } from 'vitest'

import { queueNames } from '../ports/job-queue.ts'
import {
  AGENT_TURN_CANCEL_JOB,
  AGENT_TURN_JOB,
  AGENT_TURN_QUEUE,
  agentTurnCancelDedupeKey,
  agentTurnCancelJobSchema,
  agentTurnDedupeKey,
  agentTurnJobSchema,
  agentTurnRetryJobId,
  CANDIDATE_REBASE_JOB,
  candidateRebaseDedupeKey,
  candidateRebaseJobSchema,
} from './agent-turn-job.ts'

const id = '0196abcd-0000-7000-8000-00000000000a'

describe('the agent turn job', () => {
  it('runs on agent-turns as turn.run with the request it answers', () => {
    expect(queueNames).toContain(AGENT_TURN_QUEUE)
    expect(AGENT_TURN_JOB).toBe('turn.run')
    const job = { taskId: id, attempt: 1, requestEventId: '4812' }
    expect(agentTurnJobSchema.parse(job)).toEqual(job)
    expect(agentTurnJobSchema.safeParse({ ...job, requestEventId: 4812 }).success).toBe(false)
    expect(agentTurnJobSchema.safeParse({ ...job, text: 'Поменяйте телефон' }).success).toBe(false)
    expect(agentTurnDedupeKey(job)).toBe(`turn.run:${id}:1:4812`)
    expect(agentTurnRetryJobId(job, 'epoch-7')).toBe(`turn.run:${id}:1:4812:retry:epoch-7`)
  })
})

describe('the commands of a dialog on agent-turns', () => {
  const job = { taskId: id, requestEventId: '4812' }

  it('stops a pass as turn.cancel, one job per press', () => {
    expect(AGENT_TURN_CANCEL_JOB).toBe('turn.cancel')
    expect(agentTurnCancelJobSchema.parse(job)).toEqual(job)
    expect(agentTurnCancelJobSchema.safeParse({ taskId: id }).success).toBe(false)
    expect(agentTurnCancelJobSchema.safeParse({ ...job, by: 'customer' }).success).toBe(false)
    expect(agentTurnCancelDedupeKey(job)).toBe(`turn.cancel:${id}:4812`)
    expect(agentTurnCancelDedupeKey({ ...job, requestEventId: '4813' })).not.toBe(
      agentTurnCancelDedupeKey(job),
    )
  })

  it('carries a candidate onto the current version as candidate.rebase', () => {
    expect(CANDIDATE_REBASE_JOB).toBe('candidate.rebase')
    expect(candidateRebaseJobSchema.parse(job)).toEqual(job)
    expect(candidateRebaseJobSchema.safeParse({ ...job, requestEventId: '0' }).success).toBe(false)
    expect(candidateRebaseDedupeKey(job)).toBe(`candidate.rebase:${id}:4812`)
  })
})
