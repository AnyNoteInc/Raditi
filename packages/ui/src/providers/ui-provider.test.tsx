import { useTheme } from '@mui/material/styles'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UiProvider, useThemePreference } from './ui-provider.tsx'

function Probe() {
  const { preference, setPreference } = useThemePreference()
  const theme = useTheme()
  return (
    <button type="button" onClick={() => setPreference('dark')}>
      {preference}/{theme.palette.mode}
    </button>
  )
}

afterEach(() => {
  document.cookie = 'theme=; Path=/; Max-Age=0'
})

describe('UiProvider', () => {
  it('takes the mode from the cookie value it is given', () => {
    render(
      <UiProvider themePreference="dark">
        <Probe />
      </UiProvider>,
    )

    expect(screen.getByRole('button')).toHaveTextContent('dark/dark')
  })

  it('writes the cookie and repaints when the preference changes', async () => {
    const user = userEvent.setup()
    render(
      <UiProvider themePreference="light">
        <Probe />
      </UiProvider>,
    )
    expect(screen.getByRole('button')).toHaveTextContent('light/light')

    await user.click(screen.getByRole('button'))

    expect(document.cookie).toContain('theme=dark')
    expect(screen.getByRole('button')).toHaveTextContent('dark/dark')
  })

  it('keeps the mode out of local storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const user = userEvent.setup()
    render(
      <UiProvider themePreference="system">
        <Probe />
      </UiProvider>,
    )

    await user.click(screen.getByRole('button'))

    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('requires the provider for useThemePreference', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/inside UiProvider/)
    vi.mocked(console.error).mockRestore()
  })
})
