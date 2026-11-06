// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AccountShell } from './account-shell'

vi.mock('next/navigation', () => ({ usePathname: () => '/profile' }))
vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

const user = { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }

describe('AccountShell', () => {
  it('leads back to the chats, under the same name on the screen and for a voice', () => {
    render(<AccountShell user={user}>Профиль</AccountShell>)

    const back = screen.getByRole('link', { name: 'К чатам' })
    expect(back).toHaveAttribute('href', '/chats')
    expect(back).toHaveTextContent(/^К чатам$/)
  })
})
