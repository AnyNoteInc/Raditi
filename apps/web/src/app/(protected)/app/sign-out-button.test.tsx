// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SignOutButton } from './sign-out-button'

const { signOut, hardNavigate } = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<void>>(),
  hardNavigate: vi.fn<(path: string) => void>(),
}))

vi.mock('./actions', () => ({ signOut }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SignOutButton', () => {
  it('signs out, then loads the sign-in page with a full page load', async () => {
    signOut.mockResolvedValue(undefined)
    render(<SignOutButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/sign-in'))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(
      hardNavigate.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('leaves the cabinet even when the sign-out call fails', async () => {
    signOut.mockRejectedValue(new Error('fetch failed'))
    render(<SignOutButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/sign-in'))
  })
})
