// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  useChatChoiceMadeHere,
  useChatDetails,
  useChatThinking,
  useTurnAtWorkShown,
} from './chat-details'

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

/** A dialog as `dialog-view` holds it: the lines follow the choices made after it was opened. */
function MadeHere() {
  const madeHere = useChatChoiceMadeHere()
  const { toggle } = useChatDetails()
  return (
    <button type="button" onClick={toggle}>
      {madeHere ? 'выбор сделан здесь' : 'выбора здесь нет'}
    </button>
  )
}

function LiveThoughts() {
  useTurnAtWorkShown(true)
  const { live, toggle } = useChatThinking()
  return (
    <button type="button" onClick={toggle}>
      {live ? 'идущий ход: мысли видны' : 'идущий ход: мысли скрыты'}
    </button>
  )
}

/** The switch as `/thinking` and the menu show it, beside a turn at work while `atWork`. */
function Switch({ atWork }: { atWork: boolean }) {
  useTurnAtWorkShown(atWork)
  const { shown, toggle } = useChatThinking()
  return (
    <button type="button" onClick={toggle}>
      {shown ? 'переключатель: видны' : 'переключатель: скрыты'}
    </button>
  )
}

describe('«Размышления агента»', () => {
  it('hides the thoughts of a turn at work at the first press (19.11.2026)', () => {
    render(<LiveThoughts />)
    // Nothing chosen: a turn at work shows what the model thinks (РА7).
    expect(screen.getByText('идущий ход: мысли видны')).toBeTruthy()
    press()
    expect(screen.getByText('идущий ход: мысли скрыты')).toBeTruthy()
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('0')
    press()
    expect(screen.getByText('идущий ход: мысли видны')).toBeTruthy()
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('1')
  })

  it('speaks of the turn at work while one stands on the page, else of finished turns', () => {
    const page = render(<Switch atWork />)
    expect(screen.getByText('переключатель: видны')).toBeTruthy()
    // The turn ends: nothing chosen, finished turns keep their thoughts closed.
    page.rerender(<Switch atWork={false} />)
    expect(screen.getByText('переключатель: скрыты')).toBeTruthy()
    press()
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('1')
    page.rerender(<Switch atWork />)
    expect(screen.getByText('переключатель: видны')).toBeTruthy()
    press()
    expect(window.localStorage.getItem('raditi-chat-thinking')).toBe('0')
    expect(screen.getByText('переключатель: скрыты')).toBeTruthy()
  })

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

describe('the choices made on a dialog that was just opened (21.11.2026)', () => {
  it('counts a choice only once it is made on that dialog, never one kept by the browser', () => {
    // A chat opened with the choice already kept in this browser: its lines stay folded.
    window.localStorage.setItem('raditi-chat-details', '1')
    const first = render(<MadeHere />)
    expect(screen.getByText('выбора здесь нет')).toBeTruthy()
    press()
    expect(screen.getByText('выбор сделан здесь')).toBeTruthy()
    first.unmount()
    // The next chat opens with the choice kept — and its lines stay folded all the same, until
    // a choice is made there too.
    render(<MadeHere />)
    expect(screen.getByText('выбора здесь нет')).toBeTruthy()
    press()
    expect(screen.getByText('выбор сделан здесь')).toBeTruthy()
  })
})
