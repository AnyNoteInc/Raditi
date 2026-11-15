// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { NotificationSettings, notificationText } from './notification-settings'

const calls = vi.hoisted(() => ({
  settings: vi.fn(async () => ({
    push: false,
    email: true,
    browsers: 0,
    publicKey: 'x'.repeat(87),
  })),
  setSettings: vi.fn(async (input: { push?: boolean; email?: boolean }) => ({
    push: input.push ?? false,
    email: input.email ?? true,
  })),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    notification: {
      settings: {
        queryOptions: () => ({ queryKey: ['notification', 'settings'], queryFn: calls.settings }),
        queryKey: () => ['notification', 'settings'],
      },
      setSettings: { mutationOptions: () => ({ mutationFn: calls.setSettings }) },
      subscribe: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
      unsubscribe: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
    },
  }),
}))

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationSettings />
    </QueryClientProvider>,
  )
}

describe('«Уведомления» of the settings (docs/plan/75, ВВ10)', () => {
  it('has letters on and the browser off by default, and turns letters off', async () => {
    show()
    const letters = await screen.findByRole<HTMLInputElement>('switch', {
      name: notificationText.email,
    })
    expect(letters.checked).toBe(true)
    expect(
      screen.getByRole<HTMLInputElement>('switch', { name: notificationText.push }).checked,
    ).toBe(false)
    fireEvent.click(letters)
    await waitFor(() => expect(calls.setSettings).toHaveBeenCalled())
    expect(calls.setSettings.mock.calls[0]![0]).toEqual({ email: false })
  })

  it('says so where the browser shows no notifications of sites', async () => {
    show()
    fireEvent.click(await screen.findByRole('switch', { name: notificationText.push }))
    expect(await screen.findByText(notificationText.pushUnsupported)).toBeTruthy()
  })
})
