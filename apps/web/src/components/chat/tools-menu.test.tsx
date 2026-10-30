// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ToolTile } from './dialog-tools'
import { ToolsMenu } from './tools-menu'

// The menu «+» of a dialog as a browser has it (docs/plan/59-dialog-tools-panel.md, И5, И14):
// the first tile in focus however React mounts the menu, and the pressing area of a finger on
// every width (DESIGN.md). MUI lets a menu item shrink to its content from `sm` up by a media
// query, which a browser applies and jsdom does not: the rules are read here as a browser would
// read them at a given width.

/**
 * The value of `property` that the rules of the page give `element` on a screen `width` px wide:
 * of the rules whose selector matches it — at the top level, or in a media query of a `min-width`
 * the width reaches —, the last one says it, as the cascade decides between rules of one weight.
 */
function declared(element: Element, property: string, width: number): string | null {
  let value: string | null = null
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const least = /^\(min-width:\s*(\d+)px\)$/.exec(rule.media.mediaText.trim())
        if (least !== null && Number(least[1]) <= width) visit(rule.cssRules)
      } else if (rule instanceof CSSStyleRule) {
        const own = rule.style.getPropertyValue(property)
        if (own !== '' && element.matches(rule.selectorText)) value = own
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules)
  return value
}

const tiles: ToolTile[] = [
  { tool: 'files', open: false, mark: 'пока нет' },
  { tool: 'checks', open: false, mark: 'пока нет' },
]

/** «+» pressed: the tiles of its menu, a card from `lg` or a sheet below. */
async function openTiles(sheet: boolean): Promise<HTMLElement[]> {
  render(<ToolsMenu tiles={tiles} onOpen={vi.fn()} sheet={sheet} />)
  fireEvent.click(screen.getByRole('button', { name: 'Инструменты' }))
  const menu = await screen.findByRole('menu', { name: 'Инструменты' })
  return within(menu).getAllByRole('menuitem')
}

describe('the focus in the menu «+»', () => {
  // Strict Mode mounts the menu twice, as `next dev` does: the modal under the menu gives the focus
  // back to «+» on the first unmount and takes it to its card on the second mount, unless the menu
  // keeps it on its first tile.
  it.each([
    ['the card of a desktop', false],
    ['the sheet below `lg`', true],
  ])('goes to the first tile of %s, and the arrows go on from it', async (_where, sheet) => {
    render(
      <StrictMode>
        <ToolsMenu tiles={tiles} onOpen={vi.fn()} sheet={sheet} />
      </StrictMode>,
    )
    const plus = screen.getByRole('button', { name: 'Инструменты' })
    plus.focus()
    fireEvent.click(plus)
    const menu = await screen.findByRole('menu', { name: 'Инструменты' })
    const [files, checks] = within(menu).getAllByRole('menuitem')
    await waitFor(() => expect(document.activeElement).toBe(files))
    fireEvent.keyDown(files!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(checks)
  })
})

describe('the tiles of «+»', () => {
  it('stay 52px high in the card on a desktop, where a menu item of MUI shrinks', async () => {
    const found = await openTiles(false)
    expect(found).toHaveLength(2)
    for (const tile of found)
      for (const width of [1200, 1440, 1920])
        expect(declared(tile, 'min-height', width)).toBe('52px')
  })

  it('stay 92px high in the sheet on a phone and on a tablet', async () => {
    const found = await openTiles(true)
    expect(found).toHaveLength(2)
    for (const tile of found)
      for (const width of [390, 768, 1199]) expect(declared(tile, 'min-height', width)).toBe('92px')
  })
})
