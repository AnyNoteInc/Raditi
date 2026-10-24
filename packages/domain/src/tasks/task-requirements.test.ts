import { describe, expect, it } from 'vitest'

import {
  BROWSER_ONLY,
  REPOSITORY_ONLY,
  requirementsOf,
  taskRequirementsSchema,
} from './task-requirements.ts'

describe('task requirements', () => {
  it('accepts every combination with at least one need', () => {
    for (const value of [REPOSITORY_ONLY, BROWSER_ONLY, { repository: true, browser: true }])
      expect(taskRequirementsSchema.parse(value)).toEqual(value)
  })

  it.each([
    ['no need at all', { repository: false, browser: false }],
    ['a missing flag', { repository: true }],
    ['a flag that is not a boolean', { repository: 'yes', browser: false }],
    ['an unknown need', { repository: true, browser: false, database: true }],
  ])('refuses %s', (_label, value) => {
    expect(taskRequirementsSchema.safeParse(value).success).toBe(false)
  })

  it('reads a plan without requirements as a repository task, as before them', () => {
    expect(requirementsOf({})).toEqual({ repository: true, browser: false })
    expect(requirementsOf({ requirements: BROWSER_ONLY })).toBe(BROWSER_ONLY)
    const both = { repository: true, browser: true }
    expect(requirementsOf({ requirements: both })).toBe(both)
  })

  it('keeps the shared constants unchanged', () => {
    expect(Object.isFrozen(REPOSITORY_ONLY)).toBe(true)
    expect(Object.isFrozen(BROWSER_ONLY)).toBe(true)
  })
})
