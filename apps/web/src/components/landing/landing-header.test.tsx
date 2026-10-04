// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LandingHeader } from './landing-header'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

describe('landing account navigation', () => {
  it('offers sign-in and mobile registration to a guest', () => {
    render(<LandingHeader viewer={{ status: 'guest', user: null }} />)

    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/sign-in')
    expect(screen.queryByRole('button', { name: 'Меню пользователя' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }))
    const mobile = screen.getByRole('navigation', { name: 'Мобильная навигация' })
    expect(within(mobile).getByRole('link', { name: 'Создать аккаунт' })).toHaveAttribute(
      'href',
      '/sign-up',
    )
  })

  it('keeps only the account avatar in the authenticated header and puts projects in its menu', () => {
    render(
      <LandingHeader
        viewer={{
          status: 'authenticated',
          user: { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru', image: null },
        }}
      />,
    )

    const account = screen.getByRole('button', { name: 'Меню пользователя' })
    expect(within(account).getByText('АИ')).toBeVisible()
    expect(account.querySelector('svg')).toBeNull()
    expect(screen.queryByText('Анна')).not.toBeInTheDocument()
    expect(screen.queryByText('Анна Иванова')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Проекты' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Войти' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }))
    const mobile = screen.getByRole('navigation', { name: 'Мобильная навигация' })
    expect(within(mobile).queryByRole('link', { name: 'Открыть проекты' })).not.toBeInTheDocument()
    expect(within(mobile).getAllByRole('link')).toHaveLength(3)
    expect(within(mobile).queryByRole('link', { name: 'Создать аккаунт' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть меню' }))
    fireEvent.click(screen.getByRole('button', { name: 'Меню пользователя' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Анна Иванова')).toBeVisible()
    expect(within(menu).getByText('anna@example.ru')).toBeVisible()
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Проекты', 'Профиль', 'Настройки', 'Выход'])
    expect(within(menu).getByRole('menuitem', { name: 'Проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Профиль' })).toHaveAttribute(
      'href',
      '/profile',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Настройки' })).toHaveAttribute(
      'href',
      '/settings',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Выход' })).toBeEnabled()
  })

  it('does not present a failed session lookup as a signed-out state', () => {
    render(<LandingHeader viewer={{ status: 'unavailable', user: null }} />)

    expect(screen.queryByRole('link', { name: 'Войти' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Перейти к проектам' })).toHaveAttribute(
      'href',
      '/projects',
    )
    expect(screen.queryByRole('button', { name: 'Меню пользователя' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }))
    const mobile = screen.getByRole('navigation', { name: 'Мобильная навигация' })
    expect(within(mobile).getByRole('link', { name: 'Открыть проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
    expect(within(mobile).queryByRole('link', { name: 'Создать аккаунт' })).not.toBeInTheDocument()
  })
})
