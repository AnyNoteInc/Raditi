// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import type * as MenuListModule from '@mui/material/MenuList'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { EffortMenu } from './effort-menu'

// Where a popover stands is measured in a browser; here the menu says where it hangs.
vi.mock('@mui/material/Menu', async () => {
  const { default: MenuList } =
    await vi.importActual<typeof MenuListModule>('@mui/material/MenuList')
  return {
    default: ({
      open,
      anchorOrigin,
      transformOrigin,
      children,
    }: {
      open: boolean
      anchorOrigin: { vertical: string }
      transformOrigin: { vertical: string }
      children: ReactNode
    }) =>
      open ? (
        <MenuList data-anchor={anchorOrigin.vertical} data-transform={transformOrigin.vertical}>
          {children}
        </MenuList>
      ) : null,
  }
})

function open(placement?: 'up' | 'down') {
  render(<EffortMenu value="high" onChange={vi.fn()} {...(placement ? { placement } : {})} />)
  fireEvent.click(screen.getByRole('button', { name: 'Размышление: Высокое' }))
  return screen.getByRole('menu')
}

describe('«Размышление»', () => {
  it('opens up from the field at the bottom of the chat', () => {
    const menu = open()
    expect(menu.dataset.anchor).toBe('top')
    expect(menu.dataset.transform).toBe('bottom')
  })

  // docs/plan/82-scheduled-tasks.md, Зп7: the window's menu opens down, off the field it is in.
  it('opens down where it is asked to', () => {
    const menu = open('down')
    expect(menu.dataset.anchor).toBe('bottom')
    expect(menu.dataset.transform).toBe('top')
  })
})
