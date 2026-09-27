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
  isSnapshotCredential,
  leaseLost,
  siteBusy,
  siteHeld,
  snapshotHasCredential,
  snapshotSaveWroteNothing,
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
