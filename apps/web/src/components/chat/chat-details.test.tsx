// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useChatDetails, useChatThinking } from './chat-details'

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

function Thoughts() {
  const { thinking, toggle } = useChatThinking()
  return (
    <button type="button" onClick={toggle}>
      {thinking ? 'мысли видны' : 'мысли скрыты'}
    </button>
  )
}

describe('«Размышления агента»', () => {
  it('starts hidden, and keeps the choice for the next visit', () => {
    const first = render(<Thoughts />)
    expect(screen.getByText('мысли скрыты')).toBeTruthy()
    press()
    expect(screen.getByText('мысли видны')).toBeTruthy()
    first.unmount()
    render(<Thoughts />)
    expect(screen.getByText('мысли видны')).toBeTruthy()
    press()
    expect(screen.getByText('мысли скрыты')).toBeTruthy()
  })

  it('is a choice of its own: neither switch moves the other, each has its key', () => {
    render(
      <>
        <Shown />
        <Thoughts />
      </>,
    )
    fireEvent.click(screen.getByText('мысли скрыты'))
    expect(screen.getByText('закрыто')).toBeTruthy()
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('1')
    expect(window.localStorage.getItem('raditi-chat-details')).toBeNull()
    fireEvent.click(screen.getByText('закрыто'))
    expect(screen.getByText('мысли видны')).toBeTruthy()
    expect(window.localStorage.getItem('raditi-chat-details')).toBe('1')
    fireEvent.click(screen.getByText('мысли видны'))
    expect(screen.getByText('открыто')).toBeTruthy()
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('0')
    expect(window.localStorage.getItem('raditi-chat-details')).toBe('1')
  })

  it('works where the storage throws: hidden at first, the choice held by the page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<Thoughts />)
    expect(screen.getByText('мысли скрыты')).toBeTruthy()
    press()
    expect(screen.getByText('мысли видны')).toBeTruthy()
    press()
    expect(screen.getByText('мысли скрыты')).toBeTruthy()
  })
})
