import {
  runnerApiErrors,
  type RunnerApiErrorCode,
  type RunnerConflict,
  type SiteLeaseFence,
} from '@repo/domain'

/** A refusal of the runner API: its status and the whole body the runner gets, nothing more. */
export class RunnerApiError extends Error {
  private constructor(
    readonly status: number,
    readonly body: RunnerConflict | { error: RunnerApiErrorCode },
  ) {
    super(body.error)
    this.name = 'RunnerApiError'
  }

  static of(code: RunnerApiErrorCode): RunnerApiError {
    return new RunnerApiError(runnerApiErrors[code], { error: code })
  }

  static conflict(body: RunnerConflict): RunnerApiError {
    return new RunnerApiError(409, body)
  }

  static leaseLost(): RunnerApiError {
    return RunnerApiError.conflict({ error: 'LEASE_LOST' })
  }

  static superseded(fence: SiteLeaseFence): RunnerApiError {
    const { siteId, taskId, operation, epoch } = fence
    return RunnerApiError.conflict({
      error: 'FENCE_SUPERSEDED',
      fence: { siteId, taskId, operation, epoch },
    })
  }
}
