// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useClientCommands } from './client-commands'

const { push, setPreference } = vi.hoisted(() => ({ push: vi.fn(), setPreference: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@repo/ui/providers', () => ({
  useThemePreference: () => ({ preference: 'dark', setPreference }),
}))

function Place({ projectId = null }: { projectId?: string | null }) {
  const anchor = useRef<HTMLDivElement>(null)
  const { run, menu } = useClientCommands({ projectId, anchor })
  return (
    <div ref={anchor}>
      <button type="button" onClick={() => run('themes')}>
        Оформление
      </button>
      {menu}
    </div>
  )
}

afterEach(() => vi.clearAllMocks())

describe('the commands of the page', () => {
  it('`/themes` offers the three, marks the one in use and repaints by the choice', () => {
    render(<Place />)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Оформление' }))
    const menu = within(screen.getByRole('menu', { name: 'Оформление' }))
    const items = menu.getAllByRole('menuitemradio')
    expect(items.map((item) => item.textContent)).toEqual(['Светлая', 'Тёмная', 'Как в системе'])
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ])
    fireEvent.click(items[0]!)
    expect(setPreference).toHaveBeenCalledWith('light')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
