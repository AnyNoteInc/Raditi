import { describe, expect, it } from 'vitest'
import { isDomainError } from '../errors.ts'
import {
  assertTransition,
  canTransition,
  nextStatuses,
  taskStatuses,
  terminalTaskStatuses,
} from './task-status.ts'

describe('task status machine', () => {
  it('lists exactly the statuses of spec §7', () => {
    expect(taskStatuses).toEqual([
      'queued',
      'preparing',
      'running',
      'awaiting_user',
      'awaiting_approval',
      'deploying',
      'verifying',
      'done',
      'failed',
      'rolled_back',
      'cancelled',
    ])
  })

  it('follows the happy path of a code change', () => {
    const path = [
      'queued',
      'preparing',
      'running',
      'awaiting_approval',
      'deploying',
      'verifying',
      'done',
    ] as const
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true)
  })

  it('lets content changes finish without approval', () => {
    expect(canTransition('running', 'done')).toBe(true)
  })

  it('returns a task to the queue when the site is busy', () => {
    expect(canTransition('preparing', 'queued')).toBe(true)
    expect(canTransition('running', 'queued')).toBe(false)
  })

  it('asks «Продолжить?» before a turn whose key cannot cover a first call', () => {
    expect(canTransition('preparing', 'awaiting_user')).toBe(true)
    expect(canTransition('preparing', 'awaiting_approval')).toBe(true)
    expect(canTransition('preparing', 'done')).toBe(false)
  })

  it('ends a dialog whose candidate «Обновить» found on main already', () => {
    expect(canTransition('awaiting_approval', 'done')).toBe(true)
    expect(canTransition('awaiting_user', 'done')).toBe(false)
  })

  it('returns a release refused without a write to its candidate', () => {
    expect(canTransition('deploying', 'awaiting_approval')).toBe(true)
    expect(canTransition('verifying', 'awaiting_approval')).toBe(false)
  })

  it('cannot cancel once the deploy started', () => {
    expect(canTransition('deploying', 'cancelled')).toBe(false)
    expect(canTransition('verifying', 'cancelled')).toBe(false)
  })

  it('keeps done, rolled_back and cancelled terminal', () => {
    for (const s of ['done', 'rolled_back', 'cancelled'] as const)
      expect(nextStatuses(s)).toEqual([])
    expect(terminalTaskStatuses).toContain('failed')
  })

  it('throws a conflict DomainError on an invalid transition', () => {
    expect(() => assertTransition('done', 'running')).toThrowError(/done to running/)
    try {
      assertTransition('queued', 'done')
    } catch (e) {
      expect(isDomainError(e) && e.code).toBe('CONFLICT')
    }
  })
})
