import { describe, expect, it } from 'vitest'

import { clampPaneWidth, paneWidthCss, parsePaneWidth, SITE_PANE_MIN } from './pane-layout'

describe('the width of the panel beside a chat', () => {
  it('reads a width from the cookie only when it is a sane number of pixels', () => {
    expect(parsePaneWidth('720')).toBe(720)
    expect(parsePaneWidth('439')).toBeNull()
    expect(parsePaneWidth('99999')).toBeNull()
    expect(parsePaneWidth('720px')).toBeNull()
    expect(parsePaneWidth(undefined)).toBeNull()
  })

  it('keeps the panel and the chat beside it within their minimums', () => {
    // 72 (rail) + 30 (three gaps) + 64 (paddings) + 360 (the chat) = 526 px are left to the rest.
    expect(clampPaneWidth(2000, 1440)).toBe(914)
    expect(clampPaneWidth(100, 1440)).toBe(SITE_PANE_MIN)
    expect(clampPaneWidth(700, 900)).toBe(SITE_PANE_MIN)
    expect(paneWidthCss(700)).toBe('clamp(440px, 700px, max(440px, calc(100vw - 526px)))')
  })
})
