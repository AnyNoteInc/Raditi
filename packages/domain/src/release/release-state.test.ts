import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import { canTransition, taskStatuses, type TaskStatus } from '../tasks/task-status.ts'
import {
  assertReleaseTransition,
  canReleaseTransition,
  isTerminalReleaseStatus,
  releaseNextStatuses,
  releaseOutcomeOf,
  releaseOutcomes,
  releaseResolutions,
  releaseStatusAfterStep,
  releaseStatuses,
  releaseSteps,
  releaseStepsAllowedIn,
  releaseStepStates,
  releaseTaskEffects,
  taskStatusDuringRelease,
  terminalReleaseStatuses,
} from './release-state.ts'

describe('release statuses', () => {
  it('lists the statuses, steps and states of the plan', () => {
    expect(releaseStatuses).toEqual([
      'approved',
      'publishing',
      'published',
      'deploying',
      'verifying',
      'installed',
      'rolling_back',
      'rolled_back',
      'failed',
      'unknown',
    ])
    expect(releaseSteps).toEqual([
      'conflicts',
      'backup',
      'files',
      'db',
      'verify',
      'rollback',
      'reverify',
    ])
    expect(releaseStepStates).toEqual(['started', 'succeeded', 'failed', 'unknown'])
    expect(terminalReleaseStatuses).toEqual(['installed', 'rolled_back', 'failed'])
  })

  it('goes from the confirmation to the installed version', () => {
    const path = [
      'approved',
      'publishing',
      'published',
      'deploying',
      'verifying',
      'installed',
    ] as const
    for (let i = 1; i < path.length; i++)
      expect(canReleaseTransition(path[i - 1]!, path[i]!)).toBe(true)
  })

  it('ends without a write only before the job writes', () => {
    for (const from of ['approved', 'publishing', 'published', 'deploying'] as const)
      expect(canReleaseTransition(from, 'failed')).toBe(true)
    for (const from of ['verifying', 'rolling_back', 'unknown'] as const)
      expect(canReleaseTransition(from, 'failed')).toBe(false)
  })

  it('leaves unknown only by an operator decision or a rollback attempt', () => {
    expect(releaseNextStatuses('unknown')).toEqual(['installed', 'rolled_back', 'rolling_back'])
    expect(releaseResolutions).toEqual(['installed', 'rolled_back'])
    for (const status of terminalReleaseStatuses) {
      expect(releaseNextStatuses(status)).toEqual([])
      expect(isTerminalReleaseStatus(status)).toBe(true)
    }
    expect(isTerminalReleaseStatus('unknown')).toBe(false)
  })

  it('throws a conflict on a move it does not allow', () => {
    try {
      assertReleaseTransition('installed', 'rolling_back')
      expect.unreachable()
    } catch (error) {
      expect(isDomainError(error) && error.code).toBe('CONFLICT')
    }
  })
})

describe('step reports', () => {
  const conflictOf = (run: () => unknown) => {
    try {
      run()
      return null
    } catch (error) {
      return isDomainError(error) ? error.code : 'not a domain error'
    }
  }

  it('moves the release by the reports of the job', () => {
    expect(releaseStatusAfterStep('published', 'conflicts', 'started', false)).toBe('deploying')
    expect(releaseStatusAfterStep('published', 'conflicts', 'failed', false)).toBe('failed')
    expect(releaseStatusAfterStep('deploying', 'conflicts', 'failed', false)).toBe('failed')
    expect(releaseStatusAfterStep('deploying', 'backup', 'succeeded', false)).toBeNull()
    expect(releaseStatusAfterStep('deploying', 'backup', 'unknown', false)).toBe('failed')
    expect(releaseStatusAfterStep('deploying', 'files', 'started', true)).toBeNull()
    expect(releaseStatusAfterStep('deploying', 'files', 'failed', true)).toBe('rolling_back')
    expect(releaseStatusAfterStep('deploying', 'db', 'unknown', true)).toBe('unknown')
    expect(releaseStatusAfterStep('deploying', 'verify', 'started', true)).toBe('verifying')
    expect(releaseStatusAfterStep('verifying', 'verify', 'succeeded', true)).toBe('installed')
    expect(releaseStatusAfterStep('verifying', 'verify', 'failed', true)).toBe('rolling_back')
  })

  it('checks the site again after a rollback before the release is rolled back', () => {
    expect(releaseStatusAfterStep('verifying', 'rollback', 'started', true)).toBe('rolling_back')
    expect(releaseStatusAfterStep('rolling_back', 'rollback', 'started', true)).toBeNull()
    expect(releaseStatusAfterStep('rolling_back', 'rollback', 'succeeded', true)).toBeNull()
    expect(releaseStatusAfterStep('rolling_back', 'reverify', 'started', true)).toBeNull()
    expect(releaseStatusAfterStep('rolling_back', 'reverify', 'succeeded', true)).toBe(
      'rolled_back',
    )
    expect(releaseStatusAfterStep('rolling_back', 'reverify', 'failed', true)).toBe('unknown')
    expect(releaseStatusAfterStep('rolling_back', 'rollback', 'failed', true)).toBe('unknown')
    // The rollback writes: its unknown end is unknown whatever the attempt wrote before.
    expect(releaseStatusAfterStep('rolling_back', 'rollback', 'unknown', false)).toBe('unknown')
    // An attempt «только возврат» starts from unknown.
    expect(releaseStatusAfterStep('unknown', 'rollback', 'started', false)).toBe('rolling_back')
  })

  it('keys the check after a rollback apart from the first check', () => {
    expect(releaseStepsAllowedIn('rolling_back')).toEqual(['rollback', 'reverify'])
    expect(releaseStepsAllowedIn('deploying')).not.toContain('reverify')
  })

  it('refuses a report the current status does not take', () => {
    // The first check repeated during a rollback, a write after the check, a report of an end.
    expect(
      conflictOf(() => releaseStatusAfterStep('rolling_back', 'verify', 'started', true)),
    ).toBe('CONFLICT')
    expect(conflictOf(() => releaseStatusAfterStep('verifying', 'files', 'started', true))).toBe(
      'CONFLICT',
    )
    expect(
      conflictOf(() => releaseStatusAfterStep('approved', 'conflicts', 'started', false)),
    ).toBe('CONFLICT')
    for (const status of terminalReleaseStatuses)
      for (const step of releaseSteps)
        expect(conflictOf(() => releaseStatusAfterStep(status, step, 'started', true))).toBe(
          'CONFLICT',
        )
  })

  it('never answers a move the statuses do not allow', () => {
    for (const status of releaseStatuses)
      for (const step of releaseStepsAllowedIn(status))
        for (const state of releaseStepStates)
          for (const wrote of [false, true]) {
            const next = (() => {
              try {
                return releaseStatusAfterStep(status, step, state, wrote)
              } catch {
                return null
              }
            })()
            if (next !== null)
              expect(canReleaseTransition(status, next), `${status} → ${next}`).toBe(true)
          }
  })
})

describe('outcome of a release → the dialog', () => {
  it('has an effect for every outcome, each step a transition of spec §7', () => {
    expect(Object.keys(releaseTaskEffects).sort()).toEqual([...releaseOutcomes].sort())
    for (const effect of Object.values(releaseTaskEffects))
      for (const step of effect.steps)
        for (const from of step.from)
          expect(canTransition(from, step.to), `${from} → ${step.to}`).toBe(true)
  })

  it('installed: deploying → verifying → done in two steps, then the charge', () => {
    expect(releaseTaskEffects.installed).toEqual({
      steps: [
        { from: ['deploying'], to: 'verifying' },
        { from: ['verifying'], to: 'done' },
      ],
      credits: 'charge',
      revertMain: false,
      holdForOperator: false,
    })
  })

  it('rolled_back closes the dialog and returns the credits; main goes back', () => {
    expect(releaseTaskEffects.rolled_back).toMatchObject({
      steps: [{ from: ['deploying', 'verifying'], to: 'rolled_back' }],
      credits: 'release',
      revertMain: true,
    })
  })

  it('failed returns the dialog to its candidate and main to the installed tree', () => {
    expect(releaseTaskEffects.failed).toMatchObject({
      steps: [{ from: ['deploying'], to: 'awaiting_approval' }],
      credits: 'keep',
      revertMain: true,
    })
    expect(releaseTaskEffects.refused).toMatchObject({
      steps: [{ from: ['deploying'], to: 'awaiting_approval' }],
      revertMain: false,
    })
  })

  it('unknown holds the site for the operator and moves nothing', () => {
    expect(releaseTaskEffects.unknown).toEqual({
      steps: [],
      credits: 'keep',
      revertMain: false,
      holdForOperator: true,
    })
  })

  it('names the outcome of a status, and the status of the dialog while it goes on', () => {
    expect(releaseStatuses.map((status) => releaseOutcomeOf(status, { mainMoved: true }))).toEqual([
      null,
      null,
      null,
      null,
      null,
      'installed',
      null,
      'rolled_back',
      'failed',
      'unknown',
    ])
    const during: (TaskStatus | null)[] = releaseStatuses.map(taskStatusDuringRelease)
    for (const status of during) if (status !== null) expect(taskStatuses).toContain(status)
    expect(taskStatusDuringRelease('verifying')).toBe('verifying')
    expect(taskStatusDuringRelease('rolling_back')).toBeNull()
  })

  it('tells a failure before main moved from one after it', () => {
    // approved → failed: readiness refused in core, nothing pushed.
    expect(canReleaseTransition('approved', 'failed')).toBe(true)
    expect(releaseOutcomeOf('failed', { mainMoved: false })).toBe('refused')
    // publishing → failed: the CAS push of main refused …
    expect(canReleaseTransition('publishing', 'failed')).toBe(true)
    expect(releaseOutcomeOf('failed', { mainMoved: false })).toBe('refused')
    // … or main pushed and the tag refused.
    expect(releaseOutcomeOf('failed', { mainMoved: true })).toBe('failed')
    // published → failed: the job did not start; main and the tag are there.
    expect(canReleaseTransition('published', 'failed')).toBe(true)
    expect(releaseOutcomeOf('failed', { mainMoved: true })).toBe('failed')
    expect(releaseTaskEffects[releaseOutcomeOf('failed', { mainMoved: false })!].revertMain).toBe(
      false,
    )
    expect(releaseTaskEffects[releaseOutcomeOf('failed', { mainMoved: true })!].revertMain).toBe(
      true,
    )
    // An outcome that is not failed does not depend on it.
    for (const mainMoved of [false, true]) {
      expect(releaseOutcomeOf('installed', { mainMoved })).toBe('installed')
      expect(releaseOutcomeOf('publishing', { mainMoved })).toBeNull()
    }
  })
})
