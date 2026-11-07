// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CABINET_PANEL_WIDTH_COOKIE } from '@/lib/cabinet-panel'

import { PANEL_STEP, PanelResizer } from './panel-resizer'

// The right edge of the panel beside the rail (docs/plan/64-cabinet-navigation.md): moved with the
// arrows or dragged, it writes the width the shell and the panel share and keeps it in a cookie.

function Stand() {
  return (
    <div data-cabinet-shell="" data-testid="shell">
      <aside data-testid="panel">
        <PanelResizer />
      </aside>
    </div>
  )
}

const edge = () => screen.getByRole('separator', { name: 'Ширина левой панели' })
const width = () => screen.getByTestId('shell').style.getPropertyValue('--cabinet-panel-width')

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 72,
    right: 356,
    width: 284,
    top: 10,
    bottom: 890,
    height: 880,
    x: 72,
    y: 10,
    toJSON: () => ({}),
  })
  document.cookie = `${CABINET_PANEL_WIDTH_COOKIE}=; max-age=0; path=/`
})

afterEach(() => vi.restoreAllMocks())

describe('the edge of the panel beside the rail', () => {
  it('widens and narrows the panel with the arrows, within its bounds, and keeps the width', () => {
    render(<Stand />)
    fireEvent.keyDown(edge(), { key: 'ArrowRight' })
    expect(width()).toBe(`${284 + PANEL_STEP}px`)
    expect(document.cookie).toContain(`${CABINET_PANEL_WIDTH_COOKIE}=${284 + PANEL_STEP}`)
    fireEvent.keyDown(edge(), { key: 'Home' })
    expect(width()).toBe('240px')
    fireEvent.keyDown(edge(), { key: 'ArrowLeft', shiftKey: true })
    expect(width()).toBe('240px')
    fireEvent.keyDown(edge(), { key: 'End' })
    expect(width()).toBe('440px')
    expect(edge()).toHaveAttribute('aria-valuenow', '440')
  })

  it('follows a drag from the left edge of the panel and keeps the width where it stops', () => {
    render(<Stand />)
    fireEvent.pointerDown(edge(), { button: 0, pointerId: 1, clientX: 356 })
    fireEvent.pointerMove(edge(), { pointerId: 1, clientX: 400 })
    expect(width()).toBe('328px')
    expect(document.cookie).not.toContain(`${CABINET_PANEL_WIDTH_COOKIE}=328`)
    fireEvent.pointerUp(edge(), { pointerId: 1, clientX: 400 })
    expect(document.cookie).toContain(`${CABINET_PANEL_WIDTH_COOKIE}=328`)
  })
})
