// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { NewDialog } from './new-dialog'

const described = (element: HTMLElement) =>
  document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent

describe('new dialog', () => {
  it('heads the screen and labels the message field', () => {
    render(<NewDialog />)
    expect(screen.getByRole('heading', { level: 1, name: 'Новый диалог' })).toBeTruthy()
    const field = screen.getByRole('textbox', { name: 'Сообщение' })
    expect(field.tagName).toBe('TEXTAREA')
    expect(field.getAttribute('placeholder')).toBe('Что поменять на сайте?')
  })

  it('says why sending is off on the field itself, the first stop of the keyboard', () => {
    render(<NewDialog />)
    expect(described(screen.getByRole('textbox', { name: 'Сообщение' }))).toBe(
      'Задания из кабинета мы пока не принимаем — этот раздел ещё в работе.',
    )
  })

  it('takes the level below beside a list that heads the page', () => {
    render(<NewDialog heading="h2" />)
    expect(screen.getByRole('heading', { level: 2, name: 'Новый диалог' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('offers two modes in two words, «Работа» chosen', () => {
    render(<NewDialog />)
    const modes = within(screen.getByRole('radiogroup', { name: 'Режим диалога' }))
    expect(modes.getAllByRole('radio').map((mode) => mode.closest('label')?.textContent)).toEqual([
      'Чат',
      'Работа',
    ])
    expect(modes.getByRole<HTMLInputElement>('radio', { name: 'Работа' }).checked).toBe(true)
  })

  it('shows «Чат» as a mode that cannot be chosen and says so in words', () => {
    render(<NewDialog />)
    const chat = screen.getByRole<HTMLInputElement>('radio', { name: 'Чат' })
    expect(chat.disabled).toBe(true)
    expect(chat.checked).toBe(false)
    expect(described(chat)).toBe('Режим «Чат» появится позже.')
    // Not by colour alone: the word carries a mark of its own.
    expect(chat.closest('label')?.querySelector('svg')).toBeTruthy()
    expect(
      screen.getByRole('radio', { name: 'Работа' }).closest('label')?.querySelector('svg'),
    ).toBeNull()
  })

  it('keeps sending off and tells why next to the button', () => {
    render(<NewDialog />)
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Отправить' })
    expect(send.disabled).toBe(true)
    expect(described(send)).toBe(
      'Задания из кабинета мы пока не принимаем — этот раздел ещё в работе.',
    )
  })

  it('pretends nothing else: no attachments, and the reminder about mistakes', () => {
    render(<NewDialog />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('ИИ может допускать ошибки. Проверяйте важное.')).toBeTruthy()
  })
})
