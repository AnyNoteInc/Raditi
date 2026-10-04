// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPanel } from './settings-panel'

type Consent = {
  slug: string
  title: string
  version: string
  required: boolean
  accepted: boolean
  acceptedVersion: string | null
}

const { listConsents, setMarketing, setThemePreference } = vi.hoisted(() => ({
  listConsents: vi.fn<() => Promise<Consent[]>>(),
  setMarketing: vi.fn<(input: { granted: boolean }) => Promise<{ changed: boolean }>>(),
  setThemePreference: vi.fn(),
}))

vi.mock('@repo/ui/providers', () => ({
  useThemePreference: () => ({ preference: 'system', setPreference: setThemePreference }),
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    consent: {
      list: {
        queryOptions: () => ({ queryKey: ['consent', 'list'], queryFn: listConsents }),
      },
      setMarketing: {
        mutationOptions: (
          options: UseMutationOptions<{ changed: boolean }, Error, { granted: boolean }>,
        ) => ({
          ...options,
          mutationFn: setMarketing,
        }),
      },
    },
  }),
}))

function marketingConsent(accepted: boolean): Consent[] {
  return [
    {
      slug: 'marketing-consent',
      title: 'Согласие на рассылку',
      version: '1',
      required: false,
      accepted,
      acceptedVersion: accepted ? '1' : null,
    },
  ]
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsPanel email="user@example.com" />
    </QueryClientProvider>,
  )
  return queryClient
}

beforeEach(() => {
  vi.clearAllMocks()
  listConsents.mockResolvedValue(marketingConsent(false))
})

describe('SettingsPanel marketing preference', () => {
  it('exposes the current theme and lets the user select a different appearance', () => {
    renderSettings()

    expect(screen.getByRole('radiogroup', { name: 'Тема оформления' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Системная' })).toBeChecked()

    fireEvent.click(screen.getByRole('radio', { name: 'Тёмная' }))

    expect(setThemePreference).toHaveBeenCalledWith('dark')
    expect(setMarketing).not.toHaveBeenCalled()
  })

  it('wraps the theme cards in a narrow column instead of squeezing three into it', () => {
    renderSettings()

    // jsdom lays nothing out, so the rule is pinned: with three fixed columns the settings rail
    // left 55px per card on a 320px phone and «Системная» was cut to «истемна».
    const columns = getComputedStyle(
      screen.getByRole('radiogroup', { name: 'Тема оформления' }),
    ).gridTemplateColumns
    const minimum = /^repeat\(auto-fit, minmax\((\d+)px, 1fr\)\)$/.exec(columns)?.[1]

    expect(columns).toMatch(/^repeat\(auto-fit, /)
    // The label is 70px wide inside a 2px border on each side.
    expect(Number(minimum)).toBeGreaterThanOrEqual(75)
  })

  it('waits for persistence and updates the saved choice and query cache', async () => {
    let finishSave!: (result: { changed: boolean }) => void
    setMarketing.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve
        }),
    )
    const queryClient = renderSettings()
    const toggle = await screen.findByRole('switch', { name: 'Новости и предложения' })

    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(setMarketing).toHaveBeenCalledWith({ granted: true }, expect.anything()),
    )
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('Сохраняем…')

    listConsents.mockResolvedValue(marketingConsent(true))
    await act(async () => finishSave({ changed: true }))

    await waitFor(() => expect(toggle).toBeChecked())
    expect(toggle).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('Рассылка включена.')
    expect(queryClient.getQueryData<Consent[]>(['consent', 'list'])?.[0]?.accepted).toBe(true)
  })

  it('preserves the saved choice when persistence fails and allows retry', async () => {
    setMarketing.mockRejectedValueOnce(new Error('Network unavailable'))
    renderSettings()
    const toggle = await screen.findByRole('switch', { name: 'Новости и предложения' })

    fireEvent.click(toggle)

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить настройку')
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeEnabled()

    setMarketing.mockResolvedValue({ changed: true })
    listConsents.mockResolvedValue(marketingConsent(true))
    fireEvent.click(toggle)

    await waitFor(() => expect(toggle).toBeChecked())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(setMarketing).toHaveBeenCalledTimes(2)
  })

  it('offers a retry instead of an editable setting when the initial query fails', async () => {
    listConsents.mockRejectedValueOnce(new Error('Network unavailable'))
    renderSettings()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить настройку рассылки',
    )
    expect(screen.getByRole('switch', { name: 'Новости и предложения' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Новости и предложения' })).toBeEnabled(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(setMarketing).not.toHaveBeenCalled()
  })
})
