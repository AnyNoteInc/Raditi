// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useChatDetails } from './chat-details'

function Shown() {
  const { details, toggle } = useChatDetails()
  return (
    <button type="button" onClick={toggle}>
      {details ? 'открыто' : 'закрыто'}
    </button>
  )
}

const press = () => fireEvent.click(screen.getByRole('button'))

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('«Подробности работы»', () => {
  it('starts closed, and keeps the choice for the next visit', () => {
    const first = render(<Shown />)
    expect(screen.getByText('закрыто')).toBeTruthy()
    press()
    expect(screen.getByText('открыто')).toBeTruthy()
    first.unmount()
    render(<Shown />)
    expect(screen.getByText('открыто')).toBeTruthy()
    press()
    expect(screen.getByText('закрыто')).toBeTruthy()
  })

  it('works where the storage throws: closed at first, the choice held by the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<Shown />)
    expect(screen.getByText('закрыто')).toBeTruthy()
    press()
    expect(screen.getByText('открыто')).toBeTruthy()
    press()
    expect(screen.getByText('закрыто')).toBeTruthy()
  })
})
