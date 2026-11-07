// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AccountShell } from './account-shell'

vi.mock('next/navigation', () => ({ usePathname: () => '/profile' }))
vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))
// The credits of the rail read the server: here they are left out.
vi.mock('@/components/billing/credit-ring', () => ({ CreditRing: () => null }))

const user = { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }

describe('AccountShell', () => {
  it('keeps the rail of the cabinet: the chats and the projects are one step away', () => {
    render(<AccountShell user={user}>Профиль</AccountShell>)

    const rail = screen.getByRole('navigation', { name: 'Основная навигация' })
    expect(within(rail).getByRole('link', { name: 'Чаты' })).toHaveAttribute('href', '/chats')
    expect(within(rail).getByRole('link', { name: 'Проекты' })).toHaveAttribute('href', '/projects')
    expect(screen.getByRole('main')).toHaveTextContent('Профиль')
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', '#account-content')
  })
})
