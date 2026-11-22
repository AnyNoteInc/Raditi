import { describe, expect, it } from 'vitest'

import { announceCabinetSignOut, cabinetSigningOutHere } from './cabinet-session-signal'

describe('announceCabinetSignOut', () => {
  it('marks this tab as the one signing out, so it ignores its own notice', () => {
    expect(cabinetSigningOutHere()).toBe(false)
    announceCabinetSignOut()
    expect(cabinetSigningOutHere()).toBe(true)
  })
})
