import { describe, expect, it } from 'vitest'

import {
  conflict,
  DomainError,
  driverPrepareInvalid,
  isTooLarge,
  publicationTooLarge,
  repositoryTooLarge,
  sandboxCommandFailed,
  snapshotTooLarge,
  turnOutputRejected,
  turnOutputTooLarge,
} from '../errors.ts'
import {
  execLost,
  isSnapshotCredential,
  leaseLost,
  siteBusy,
  siteHeld,
  snapshotHasCredential,
  snapshotSaveWroteNothing,
  turnEvidenceSchema,
  turnPhases,
} from './turn-runner.ts'

describe('turn failure codes', () => {
  it('gives every size limit a 413 of its own', () => {
    for (const [error, code] of [
      [publicationTooLarge(), 'PUBLICATION_TOO_LARGE'],
      [snapshotTooLarge(), 'SNAPSHOT_TOO_LARGE'],
      [repositoryTooLarge(), 'REPOSITORY_TOO_LARGE'],
      [turnOutputTooLarge(), 'TURN_OUTPUT_TOO_LARGE'],
    ] as const) {
      expect(error).toMatchObject({ code, httpStatus: 413 })
      expect(isTooLarge(error)).toBe(true)
    }
    expect(isTooLarge(new DomainError('BAD_REQUEST', 'x', 413))).toBe(false)
  })

  it('tells a busy site, a held site and a lost lease apart from a generic conflict', () => {
    expect(siteBusy()).toMatchObject({ code: 'SITE_BUSY', httpStatus: 409 })
    expect(siteHeld()).toMatchObject({ code: 'SITE_HELD', httpStatus: 409 })
    expect(leaseLost()).toMatchObject({ code: 'LEASE_LOST', httpStatus: 409 })
  })

  it('reports agent, driver and sandbox failures as a failed turn (502), not as invalid input', () => {
    for (const [error, code] of [
      [turnOutputRejected(), 'TURN_OUTPUT_REJECTED'],
      [driverPrepareInvalid(), 'DRIVER_PREPARE_INVALID'],
      [sandboxCommandFailed(), 'SANDBOX_COMMAND_FAILED'],
    ] as const) {
      expect(error).toMatchObject({ code, httpStatus: 502 })
      expect(isTooLarge(error)).toBe(false)
    }
  })

  it('marks a snapshot refused for a turn credential without a copy of the value', () => {
    const error = snapshotHasCredential()
    expect(error).toMatchObject({ code: 'SNAPSHOT_NOT_WRITTEN', httpStatus: 502 })
    expect(isSnapshotCredential(error)).toBe(true)
    expect(snapshotSaveWroteNothing(error)).toBe(true)
    expect(isSnapshotCredential(new DomainError('SNAPSHOT_NOT_WRITTEN', 'x', 502))).toBe(false)
    expect(isSnapshotCredential(new Error('snapshot_credential'))).toBe(false)
  })

  it.each([
    [new DomainError('SNAPSHOT_NOT_WRITTEN', 'x', 502), true],
    [snapshotTooLarge(), true],
    [publicationTooLarge(), true],
    [new DomainError('SNAPSHOT_SAVE_FAILED', 'x', 502), false],
    [new DomainError('TURN_INTERRUPTED', 'timeout', 409), false],
    [conflict('Snapshot already exists'), false],
    [new Error('SNAPSHOT_NOT_WRITTEN'), false],
    ['written', false],
  ])('knows whether a failed save wrote nothing: %s', (error, nothing) => {
    expect(snapshotSaveWroteNothing(error)).toBe(nothing)
  })
})

describe('turn evidence', () => {
  const evidence = {
    fence: {
      siteId: '22222222-2222-4222-8222-222222222222',
      taskId: '11111111-1111-4111-8111-111111111111',
      operation: 'turn',
      epoch: 3,
    },
    sessionId: 'session-1',
    turn: 1,
    sequence: 5,
    phase: 'resumed',
    execId: 'exec-1',
    cursor: { stdout: 120, stderr: 0 },
    recoveredFromEpoch: 2,
  } as const

  it('records a resumed exec and a lost one', () => {
    expect(turnEvidenceSchema.parse(evidence)).toEqual(evidence)
    expect(
      turnEvidenceSchema.safeParse({ ...evidence, phase: 'failed', reason: 'exec_lost' }).success,
    ).toBe(true)
    expect(execLost()).toMatchObject({ code: 'EXEC_LOST', httpStatus: 502 })
  })

  it('records the outcome a failed turn closes its assignment with', () => {
    const failed = { ...evidence, phase: 'failed', reason: 'exec_lost' } as const
    for (const outcome of ['lost', 'failed'])
      expect(turnEvidenceSchema.safeParse({ ...failed, outcome }).success).toBe(true)
    // Completed is journaled as `completed`, never as a failed entry.
    expect(turnEvidenceSchema.safeParse({ ...failed, outcome: 'completed' }).success).toBe(false)
  })

  it('records a turn given up without proof that its container is gone', () => {
    const vacating = { ...evidence, phase: 'vacating', reason: 'cancelled' } as const
    expect(turnEvidenceSchema.safeParse(vacating).success).toBe(true)
    expect(turnEvidenceSchema.safeParse({ ...vacating, containerId: 'c1' }).success).toBe(true)
  })

  it('records a checkpoint that waits for its runner before publication', () => {
    const waiting = { ...evidence, phase: 'recovery', reason: 'awaiting_runner' } as const
    expect(turnEvidenceSchema.safeParse(waiting).success).toBe(true)
    expect(turnEvidenceSchema.safeParse({ ...waiting, reason: 'runner_away' }).success).toBe(false)
  })

  it('records the recovered checkpoint of a turn without a repository, without git (plan 57)', () => {
    const recovered = {
      fence: evidence.fence,
      sessionId: evidence.sessionId,
      turn: evidence.turn,
      sequence: 9,
      phase: 'checkpoint_recovered',
      snapshotPrefix: 'sessions/session-1/turns/0001/',
      recoveredFromEpoch: 2,
    } as const
    expect(turnEvidenceSchema.parse(recovered)).toEqual(recovered)
    expect(turnPhases).toContain('checkpoint_recovered')
  })

  it('keeps only the fence of a lease grant', () => {
    const grant = { ...evidence.fence, expiresAt: new Date(), serverNow: new Date() }
    expect(turnEvidenceSchema.parse({ ...evidence, fence: grant }).fence).toEqual(evidence.fence)
  })
})
