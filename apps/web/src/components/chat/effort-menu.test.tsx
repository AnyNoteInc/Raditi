// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTurnAtWorkShown } from './chat-details'
import { EffortMenu, type EffortMenuHandle } from './effort-menu'

beforeEach(() => window.localStorage.clear())

describe('«Размышление» with the switch of `/thinking` (15.11.2026)', () => {
  it('switches the thoughts of the agent on and off and keeps the menu open', () => {
    const onChange = vi.fn()
    render(<EffortMenu value="high" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Размышление: Высокое' }))
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Показывать размышления/u })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('1')
    expect(
      screen
        .getByRole('menuitemcheckbox', { name: /Показывать размышления/u })
        .getAttribute('aria-checked'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Показывать размышления/u }))
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('0')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('beside a turn at work stands on, and the first press hides its thoughts (19.11.2026)', () => {
    function TurnAtWork() {
      useTurnAtWorkShown(true)
      return null
    }
    render(
      <>
        <TurnAtWork />
        <EffortMenu value="high" onChange={() => {}} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Размышление: Высокое' }))
    const toggle = () => screen.getByRole('menuitemcheckbox', { name: /Показывать размышления/u })
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle())
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('0')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('switches while the level cannot be changed: `/models` opens the menu', () => {
    const handle = createRef<EffortMenuHandle>()
    render(<EffortMenu value="low" onChange={() => {}} disabled handle={handle} />)
    act(() => handle.current?.open())
    expect(
      screen.getByRole('menuitemradio', { name: /Низкое/u }).getAttribute('aria-disabled'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Показывать размышления/u }))
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('1')
  })
})
