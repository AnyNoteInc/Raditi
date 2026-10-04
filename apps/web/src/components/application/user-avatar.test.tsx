// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { applicationUserName, UserAvatar, type ApplicationUser } from './user-avatar'

describe('account name and avatar', () => {
  it.each([
    { name: ' Анна  ', lastName: ' Иванова ', expectedName: 'Анна Иванова', initials: 'АИ' },
    {
      name: 'Анна Петровна',
      lastName: 'Иванова',
      expectedName: 'Анна Петровна Иванова',
      initials: 'АИ',
    },
    { name: 'Анна Иванова', lastName: 'Иванова', expectedName: 'Анна Иванова', initials: 'АИ' },
    { name: ' Анна  Иванова ', lastName: undefined, expectedName: 'Анна Иванова', initials: 'АИ' },
    { name: 'Анна Иванова', lastName: null, expectedName: 'Анна Иванова', initials: 'АИ' },
    { name: '', lastName: 'Иванова', expectedName: 'Иванова', initials: 'И' },
    { name: ' ', lastName: null, expectedName: '', initials: 'A' },
  ])('uses the account name and surname for "$expectedName"', (example) => {
    const user: ApplicationUser = {
      name: example.name,
      lastName: example.lastName,
      email: 'anna@example.ru',
    }

    expect(applicationUserName(user)).toBe(example.expectedName)
    render(<UserAvatar user={user} />)
    expect(screen.getByText(example.initials)).toBeVisible()
  })

  it('keeps an uploaded image and gives it the complete account name', () => {
    const image =
      '/api/profile/avatar/019f1a21-1800-7f00-8abc-111111111111/2b0f6c1e-4d1a-4c47-9a7e-5f2d9a3b8c11.webp'
    render(
      <UserAvatar user={{ name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru', image }} />,
    )

    expect(screen.getByRole('img', { name: 'Анна Иванова' })).toHaveAttribute('src', image)
  })

  it('shows the local preview of a chosen photo', () => {
    render(
      <UserAvatar
        user={{ name: 'Анна', email: 'anna@example.ru', image: 'blob:https://raditi.ru/2b0f6c1e' }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Анна' })).toHaveAttribute(
      'src',
      'blob:https://raditi.ru/2b0f6c1e',
    )
  })

  it.each([
    'https://tracker.example/pixel.gif?u=1',
    '//tracker.example/pixel.gif',
    '/api/profile/avatar/../../evil.webp',
    '/api/profile/avatar/019f1a21-1800-7f00-8abc-111111111111/photo.png',
    'data:image/svg+xml,<svg/>',
  ])('shows initials instead of an image that is not an uploaded avatar: %s', (image) => {
    render(
      <UserAvatar user={{ name: 'Анна', lastName: 'Иванова', email: 'anna@example.ru', image }} />,
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('АИ')).toBeVisible()
  })
})
