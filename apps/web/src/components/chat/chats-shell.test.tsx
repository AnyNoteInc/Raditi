// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatsShell } from './chats-shell'
import { paneWidthCss, SITE_PANE_WIDTH_VAR } from './pane-layout'

const mocks = vi.hoisted(() => ({ segment: null as string | null }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/chats',
  useSelectedLayoutSegment: () => mocks.segment,
}))
vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))
vi.mock('@/components/billing/credit-ring', () => ({ CreditRing: () => null }))

const user = { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }

const showShell = (paneWidth?: number | null) =>
  render(
    <ChatsShell user={user} paneWidth={paneWidth}>
      <h1>Содержимое</h1>
    </ChatsShell>,
  )

const shell = () => document.querySelector<HTMLElement>('[data-chat-shell]')!

beforeEach(() => {
  mocks.segment = null
})

describe('the shell of «Чаты»', () => {
  it('holds the rail, the content under no bar of breadcrumbs, and the way to the content', () => {
    showShell()
    expect(screen.getByRole('navigation', { name: 'Основная навигация' })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Хлебные крошки' })).toBeNull()
    expect(screen.getByRole('main').id).toBe('chats-content')
    expect(screen.getByRole('link', { name: 'Перейти к содержимому' }).getAttribute('href')).toBe(
      '#chats-content',
    )
  })

  it('gives the panel beside a chat the width the viewer chose', () => {
    showShell(700)
    expect(shell().style.getPropertyValue(SITE_PANE_WIDTH_VAR)).toBe(paneWidthCss(700))
  })

  it('keeps the default width without a choice', () => {
    showShell(null)
    expect(shell().style.getPropertyValue(SITE_PANE_WIDTH_VAR)).toBe('')
  })
})
