// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ToolTile } from './dialog-tools'
import { declared } from './testing'
import { ToolsMenu } from './tools-menu'

// The menu «+» of a dialog as a browser has it (docs/plan/59-dialog-tools-panel.md, И5, И14):
// the first tile in focus however React mounts the menu, the pressing area of a finger on every
// width (DESIGN.md) — MUI lets a menu item shrink to its content from `sm` up by a media query,
// which a browser applies and jsdom does not: the rules are read as a browser would read them at
// a given width (`declared`) —, and the sheet of a phone named as the menu is.

const tiles: ToolTile[] = [
  {
    tool: 'browser',
    group: 'tools',
    label: 'Браузер',
    icon: 'globe',
    open: false,
    mark: 'пока нет',
  },
  {
    tool: 'artifact:doc-1',
    group: 'made',
    label: 'Тексты для сайта',
    icon: 'document',
    open: true,
    mark: 'Открыто',
  },
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
    const [browser, documents] = within(menu).getAllByRole('menuitem')
    await waitFor(() => expect(document.activeElement).toBe(browser))
    fireEvent.keyDown(browser!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(documents)
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

describe('the sheet of «+»', () => {
  // A temporary drawer of MUI is a modal dialog: a screen reader names it as it comes up.
  it('is a dialog named by its title, «Инструменты», as the menu inside it is', async () => {
    await openTiles(true)
    const sheet = screen.getByRole('dialog', { name: 'Инструменты' })
    expect(sheet.getAttribute('aria-modal')).toBe('true')
    expect(within(sheet).getByRole('menu', { name: 'Инструменты' })).toBeTruthy()
  })
})

describe('the groups of «+» (docs/plan/88-artifacts.md, Ар44)', () => {
  it('names the tools and the artifacts of the chat, and opens the one chosen', async () => {
    const onOpen = vi.fn()
    render(<ToolsMenu tiles={tiles} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Инструменты' }))
    const menu = await screen.findByRole('menu', { name: 'Инструменты' })
    expect(
      within(menu)
        .getAllByRole('separator')
        .map((each) => each.textContent),
    ).toEqual(['Инструменты', 'Сделано в чате'])
    const item = within(menu).getByRole('menuitem', { name: /Тексты для сайта/ })
    expect(item.textContent).toContain('Открыто')
    fireEvent.click(item)
    expect(onOpen).toHaveBeenCalledWith('artifact:doc-1')
  })
})
