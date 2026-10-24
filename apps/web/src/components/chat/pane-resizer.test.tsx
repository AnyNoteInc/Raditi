// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { paneWidthCss, SITE_PANE_COOKIE } from '@/components/site/site-nav'

import { PaneResizer, PANE_STEP } from './pane-resizer'

// The edge of the panel beside a dialog (docs/plan/57-browser-tasks.md, Б29): a separator moved
// with the arrows or dragged, writing the width the shell and the panel share, kept in a cookie.

function Stand() {
  const pane = useRef<HTMLElement | null>(null)
  return (
    <div data-site-shell="" data-testid="shell">
      <aside ref={pane} data-testid="pane">
        <PaneResizer pane={pane} />
      </aside>
    </div>
  )
}

const separator = () => screen.getByRole('separator', { name: 'Ширина панели браузера' })
const width = () => screen.getByTestId('shell').style.getPropertyValue('--site-pane-width')

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 840,
    right: 1440,
    width: 600,
    top: 0,
    bottom: 900,
    height: 900,
    x: 840,
    y: 0,
    toJSON: () => ({}),
  })
  document.cookie = `${SITE_PANE_COOKIE}=; max-age=0; path=/`
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the edge of the panel', () => {
  it('is a focusable separator with its bounds', () => {
    render(<Stand />)
    expect(separator().getAttribute('aria-orientation')).toBe('vertical')
    expect(separator().tabIndex).toBe(0)
    expect(separator().getAttribute('aria-valuemin')).toBe('440')
  })

  it('widens the panel to the left with the arrows and keeps the width for the viewer', () => {
    render(<Stand />)
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
    expect(width()).toBe(paneWidthCss(600 + PANE_STEP))
    expect(separator().getAttribute('aria-valuenow')).toBe(String(600 + PANE_STEP))
    expect(document.cookie).toContain(`${SITE_PANE_COOKIE}=${600 + PANE_STEP}`)
    fireEvent.keyDown(separator(), { key: 'ArrowRight', shiftKey: true })
    expect(separator().getAttribute('aria-valuenow')).toBe(String(600 + PANE_STEP - PANE_STEP * 4))
  })

  it('never makes the panel narrower than its minimum nor the dialog than its', () => {
    render(<Stand />)
    fireEvent.keyDown(separator(), { key: 'End' })
    expect(separator().getAttribute('aria-valuenow')).toBe('440')
    // 1440 − 88 (rail) − 64 (paddings) − 360 (the dialog) = 928.
    fireEvent.keyDown(separator(), { key: 'Home' })
    expect(separator().getAttribute('aria-valuenow')).toBe('928')
    expect(separator().getAttribute('aria-valuemax')).toBe('928')
  })

  it('follows a drag and keeps the width where it stops', () => {
    render(<Stand />)
    fireEvent.pointerDown(separator(), { button: 0, pointerId: 3, clientX: 840 })
    fireEvent.pointerMove(separator(), { pointerId: 3, clientX: 740 })
    expect(width()).toBe(paneWidthCss(700))
    expect(document.cookie).not.toContain(`${SITE_PANE_COOKIE}=700`)
    fireEvent.pointerMove(separator(), { pointerId: 3, clientX: 100 })
    expect(separator().getAttribute('aria-valuenow')).toBe('928')
    fireEvent.pointerUp(separator(), { pointerId: 3, clientX: 100 })
    expect(document.cookie).toContain(`${SITE_PANE_COOKIE}=928`)
    // A move after the pointer was let go changes nothing.
    fireEvent.pointerMove(separator(), { pointerId: 3, clientX: 900 })
    expect(separator().getAttribute('aria-valuenow')).toBe('928')
  })
})
