// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import NotFound from './not-found'

vi.mock('next/navigation', () => ({
  usePathname: () =>
    '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/chat/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b18',
}))

describe('the page of a dialog the server does not find', () => {
  it('says the dialog is gone, not the project, and leads to the list of dialogs', () => {
    render(<NotFound />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Такого диалога нет')
    expect(screen.getByRole('link', { name: 'К диалогам' }).getAttribute('href')).toBe(
      '/projects/0199a3f2-5d1c-7b3e-9c41-2f6a8d0e4b17/chat',
    )
  })
})
