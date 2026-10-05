import { describe, expect, it } from 'vitest'

import {
  parseSettingsSidebarState,
  readSettingsSidebarState,
  serializeSettingsSidebarCookie,
  SETTINGS_SIDEBAR_COOKIE,
} from './settings-sidebar'

describe('parseSettingsSidebarState', () => {
  it.each(['expanded', 'collapsed'] as const)('accepts %s', (value) => {
    expect(parseSettingsSidebarState(value)).toBe(value)
  })

  it.each([undefined, null, '', 'Collapsed', 'rail', 'true', 1])(
    'falls back to expanded for %s',
    (value) => {
      expect(parseSettingsSidebarState(value)).toBe('expanded')
    },
  )
})

describe('readSettingsSidebarState', () => {
  it.each([
    ['settings-sidebar=collapsed', 'collapsed'],
    ['theme=dark; settings-sidebar=collapsed', 'collapsed'],
    ['settings-sidebar=collapsed;theme=dark', 'collapsed'],
    ['settings-sidebar=expanded; theme=dark', 'expanded'],
  ] as const)('finds the state in "%s"', (cookies, state) => {
    expect(readSettingsSidebarState(cookies)).toBe(state)
  })

  it.each(['', 'theme=dark', 'settings-sidebar=', 'settings-sidebar=rail'])(
    'falls back to expanded for "%s"',
    (cookies) => {
      expect(readSettingsSidebarState(cookies)).toBe('expanded')
    },
  )

  it('is not misled by a cookie whose name only ends the same way', () => {
    expect(readSettingsSidebarState('old-settings-sidebar=collapsed')).toBe('expanded')
  })
})

describe('serializeSettingsSidebarCookie', () => {
  it('stores the state for a year on the whole site', () => {
    expect(serializeSettingsSidebarCookie('collapsed', { secure: false })).toBe(
      `${SETTINGS_SIDEBAR_COOKIE}=collapsed; Path=/; Max-Age=31536000; SameSite=Lax`,
    )
  })

  it('marks the cookie secure over https', () => {
    expect(serializeSettingsSidebarCookie('expanded', { secure: true })).toMatch(/; Secure$/)
  })

  it('writes what the reader takes back', () => {
    const [pair] = serializeSettingsSidebarCookie('collapsed', { secure: true }).split('; ')

    expect(readSettingsSidebarState(`theme=dark; ${pair}`)).toBe('collapsed')
  })
})
