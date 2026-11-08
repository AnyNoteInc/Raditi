import { describe, expect, it } from 'vitest'

import {
  CABINET_PANEL_WIDTH_COOKIE,
  clampCabinetPanelWidth,
  parseCabinetPanelWidth,
  serializeCabinetPanelWidthCookie,
  parseCabinetPanelState,
  readCabinetPanelState,
  serializeCabinetPanelCookie,
  CABINET_PANEL_COOKIE,
} from './cabinet-panel'

describe('parseCabinetPanelState', () => {
  it.each(['open', 'closed'] as const)('accepts %s', (value) => {
    expect(parseCabinetPanelState(value)).toBe(value)
  })

  it.each([undefined, null, '', 'Closed', 'hidden', 'true', 1])(
    'falls back to open for %s',
    (value) => {
      expect(parseCabinetPanelState(value)).toBe('open')
    },
  )
})

describe('readCabinetPanelState', () => {
  it.each([
    ['raditi-panel=closed', 'closed'],
    ['theme=dark; raditi-panel=closed', 'closed'],
    ['raditi-panel=closed;theme=dark', 'closed'],
    ['raditi-panel=open; theme=dark', 'open'],
  ] as const)('finds the state in "%s"', (cookies, state) => {
    expect(readCabinetPanelState(cookies)).toBe(state)
  })

  it.each(['', 'theme=dark', 'raditi-panel=', 'raditi-panel=hidden'])(
    'falls back to open for "%s"',
    (cookies) => {
      expect(readCabinetPanelState(cookies)).toBe('open')
    },
  )

  it('is not misled by a cookie whose name only ends the same way', () => {
    expect(readCabinetPanelState('old-raditi-panel=closed')).toBe('open')
  })
})

describe('serializeCabinetPanelCookie', () => {
  it('stores the state for a year on the whole site', () => {
    expect(serializeCabinetPanelCookie('closed', { secure: false })).toBe(
      `${CABINET_PANEL_COOKIE}=closed; Path=/; Max-Age=31536000; SameSite=Lax`,
    )
  })

  it('marks the cookie secure over https', () => {
    expect(serializeCabinetPanelCookie('open', { secure: true })).toMatch(/; Secure$/)
  })

  it('writes what the reader takes back', () => {
    const [pair] = serializeCabinetPanelCookie('closed', { secure: true }).split('; ')

    expect(readCabinetPanelState(`theme=dark; ${pair}`)).toBe('closed')
  })
})

describe('the width of the panel', () => {
  it('reads only a sane width from the cookie', () => {
    expect(parseCabinetPanelWidth('320')).toBe(320)
    expect(parseCabinetPanelWidth('239')).toBeNull()
    expect(parseCabinetPanelWidth('441')).toBeNull()
    expect(parseCabinetPanelWidth('320px')).toBeNull()
    expect(parseCabinetPanelWidth(undefined)).toBeNull()
  })

  it('keeps a dragged width within its bounds and writes it for a year', () => {
    expect(clampCabinetPanelWidth(100)).toBe(240)
    expect(clampCabinetPanelWidth(1000)).toBe(440)
    expect(serializeCabinetPanelWidthCookie(301.6, { secure: false })).toBe(
      `${CABINET_PANEL_WIDTH_COOKIE}=302; Path=/; Max-Age=31536000; SameSite=Lax`,
    )
  })
})
