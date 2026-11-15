// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TelegramSettings, telegramSettingsText } from './telegram-settings'

type Status = {
  available: boolean
  bot: string | null
  linked: { username: string | null; since: Date } | null
  notifications: boolean
}

const calls = vi.hoisted(() => ({
  status: vi.fn<() => Promise<Status>>(),
  link: vi.fn(async () => ({
    url: 'https://t.me/raditi_bot?start=ABCD2345',
    expiresAt: new Date(),
  })),
  unlink: vi.fn(async () => ({ unlinked: true })),
  setNotifications: vi.fn(async (input: { on: boolean }) => input),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    telegram: {
      status: {
        queryOptions: () => ({ queryKey: ['telegram', 'status'], queryFn: calls.status }),
        queryKey: () => ['telegram', 'status'],
      },
      link: { mutationOptions: () => ({ mutationFn: calls.link }) },
      unlink: { mutationOptions: () => ({ mutationFn: calls.unlink }) },
      setNotifications: { mutationOptions: () => ({ mutationFn: calls.setNotifications }) },
    },
  }),
}))

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TelegramSettings />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('TelegramSettings', () => {
  it('shows nothing where the bot is not set up', async () => {
    calls.status.mockResolvedValue({
      available: false,
      bot: null,
      linked: null,
      notifications: true,
    })
    const { container } = show()
    await waitFor(() => expect(calls.status).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toBe(''))
  })

  it('warns that the words pass through Telegram and opens the one-time link', async () => {
    calls.status.mockResolvedValue({
      available: true,
      bot: 'raditi_bot',
      linked: null,
      notifications: true,
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    show()
    expect(await screen.findByText(telegramSettingsText.abroad)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: telegramSettingsText.link }))
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://t.me/raditi_bot?start=ABCD2345',
        '_blank',
        'noopener,noreferrer',
      ),
    )
    expect(screen.getByRole('link', { name: telegramSettingsText.openLink })).toBeTruthy()
    expect(screen.getByText(telegramSettingsText.opened(15))).toBeTruthy()
  })

  it('names the linked account, switches the notifications and unlinks', async () => {
    calls.status.mockResolvedValue({
      available: true,
      bot: 'raditi_bot',
      linked: { username: 'client', since: new Date() },
      notifications: true,
    })
    show()
    expect(await screen.findByText(telegramSettingsText.linked('client'))).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: telegramSettingsText.notify }))
    await waitFor(() => expect(calls.setNotifications.mock.calls[0]?.[0]).toEqual({ on: false }))
    fireEvent.click(screen.getByRole('button', { name: telegramSettingsText.unlink }))
    await waitFor(() => expect(calls.unlink).toHaveBeenCalled())
  })
})
