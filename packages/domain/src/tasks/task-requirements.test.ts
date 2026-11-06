import { describe, expect, it } from 'vitest'

import {
  BROWSER_ONLY,
  PLAIN_CHAT,
  REPOSITORY_ONLY,
  requirementsOf,
  siteTaskRequirementsSchema,
  taskRequirementsSchema,
} from './task-requirements.ts'

describe('task requirements', () => {
  it('accepts every combination, a chat that needs nothing included', () => {
    for (const value of [
      REPOSITORY_ONLY,
      BROWSER_ONLY,
      PLAIN_CHAT,
      { repository: true, browser: true },
    ])
      expect(taskRequirementsSchema.parse(value)).toEqual(value)
    expect(PLAIN_CHAT).toEqual({ repository: false, browser: false })
  })

  it.each([
    ['a missing flag', { repository: true }],
    ['a flag that is not a boolean', { repository: 'yes', browser: false }],
    ['an unknown need', { repository: true, browser: false, database: true }],
  ])('refuses %s', (_label, value) => {
    expect(taskRequirementsSchema.safeParse(value).success).toBe(false)
  })

  it('takes every combination of a task with a site but the one that needs nothing', () => {
    for (const value of [REPOSITORY_ONLY, BROWSER_ONLY, { repository: true, browser: true }])
      expect(siteTaskRequirementsSchema.parse(value)).toEqual(value)
    expect(siteTaskRequirementsSchema.safeParse(PLAIN_CHAT).success).toBe(false)
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
    expect(Object.isFrozen(PLAIN_CHAT)).toBe(true)
  })
})
