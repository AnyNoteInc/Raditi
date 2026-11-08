// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApplicationRail } from './application-rail'

const mocks = vi.hoisted(() => ({ pathname: '/chats' }))

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))
// The credits read the server: here the ring is a mark of where it stands.
vi.mock('@/components/billing/credit-ring', () => ({
  CreditRing: ({ placement }: { placement: string }) => (
    <span data-testid={`credit-ring-${placement}`} />
  ),
}))

const user = { name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru' }

function links() {
  render(<ApplicationRail user={user} />)
  return within(screen.getByRole('navigation', { name: 'Основная навигация' })).getAllByRole('link')
}

beforeEach(() => {
  mocks.pathname = '/chats'
})

describe('the rail of the cabinet', () => {
  it('stands «Чаты» before «Проекты», and the mark leads to the chats', () => {
    const [chats, projects] = links()
    expect(chats).toHaveAccessibleName('Чаты')
    expect(chats).toHaveAttribute('href', '/chats')
    expect(projects).toHaveAccessibleName('Проекты')
    expect(projects).toHaveAttribute('href', '/projects')
    expect(screen.getByRole('link', { name: 'Радити — главная страница' })).toHaveAttribute(
      'href',
      '/chats',
    )
  })

  it.each([
    ['/chats', 0],
    ['/chats/new', 0],
    ['/chats/0199a3f2-0000-7000-8000-000000000001', 0],
    ['/projects', 1],
    ['/projects/new', 1],
  ])('marks the section of %s, and only it', (pathname, current) => {
    mocks.pathname = pathname
    const all = links()
    expect(all.map((link) => link.getAttribute('aria-current'))).toEqual(
      all.map((_, index) => (index === current ? 'page' : null)),
    )
  })

  it('marks nothing outside its sections, nor on a name that only starts like one', () => {
    mocks.pathname = '/chatsy'
    expect(links().every((link) => link.getAttribute('aria-current') === null)).toBe(true)
  })

  it('stands the credits over the account menu', () => {
    links()
    const aside = screen.getByRole('complementary', { name: 'Боковая панель' })
    const ring = within(aside).getByTestId('credit-ring-sidebar')
    const menu = within(aside).getByRole('button', { name: 'Меню пользователя в боковой панели' })
    expect(ring.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
