import { describe, expect, it } from 'vitest'

import { THEME_COOKIE, parseThemePreference, serializeThemeCookie } from './theme-preference.ts'

describe('parseThemePreference', () => {
  it.each(['light', 'dark', 'system'] as const)('accepts %s', (value) => {
    expect(parseThemePreference(value)).toBe(value)
  })

  it.each([undefined, '', 'Dark', 'auto', 42])('falls back to system for %s', (value) => {
    expect(parseThemePreference(value)).toBe('system')
  })
})

describe('serializeThemeCookie', () => {
  it('stores the preference for a year on the whole site', () => {
    expect(serializeThemeCookie('dark', { secure: false })).toBe(
      `${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax`,
    )
  })

  it('marks the cookie secure over https', () => {
    expect(serializeThemeCookie('light', { secure: true })).toMatch(/; Secure$/)
  })
})
