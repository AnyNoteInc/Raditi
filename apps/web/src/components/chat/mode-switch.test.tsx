// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { askedMode, ModeLinks } from './mode-switch'

const described = (element: HTMLElement) =>
  document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? ''

describe('the mode of a dialog that goes on', () => {
  it('marks its own mode and leads to a new dialog in the other one', () => {
    render(<ModeLinks value="work" newDialogHref="/projects/s/chat/new" />)
    const modes = within(screen.getByRole('navigation', { name: 'Режим диалога' }))
    expect(modes.getByText('Работа').getAttribute('aria-current')).toBe('true')
    const chat = modes.getByRole('link', { name: 'Чат' })
    expect(chat.getAttribute('href')).toBe('/projects/s/chat/new?mode=chat')
    expect(described(chat)).toBe(
      'Откроет новый диалог в режиме «Чат»: режим начатого диалога не меняется.',
    )
  })

  it('does not lead to a mode the site does not offer, and says why', () => {
    const why = 'Режим «Чат» для этого сайта сейчас недоступен: облачный браузер не подключён.'
    render(<ModeLinks value="work" newDialogHref="/projects/s/chat/new" closed={{ chat: why }} />)
    const modes = within(screen.getByRole('navigation', { name: 'Режим диалога' }))
    expect(modes.queryByRole('link')).toBeNull()
    const chat = modes.getByText('Чат')
    expect(chat.getAttribute('aria-disabled')).toBe('true')
    expect(described(chat)).toBe(why)
  })
})

describe('askedMode', () => {
  it('takes only the two modes', () => {
    expect(askedMode('chat')).toBe('chat')
    expect(askedMode('work')).toBe('work')
    expect(askedMode('admin')).toBeNull()
    expect(askedMode(null)).toBeNull()
  })
})
