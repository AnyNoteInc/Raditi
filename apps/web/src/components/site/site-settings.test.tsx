// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SiteSettings } from './site-settings'

const site = { name: 'Кофейня «Крошка»' }

describe('site settings', () => {
  const settingsSite = { name: site.name, host: 'kroshka.example', stack: 'wordpress' as const }

  it('shows what is saved about an access and never a value', () => {
    render(
      <SiteSettings
        site={settingsSite}
        accesses={[{ kind: 'wp', version: 2, updatedAt: new Date('2026-10-04T09:40:00Z') }]}
      />,
    )
    expect(screen.getByText('Вход в панель сайта')).toBeTruthy()
    expect(screen.getByText(/^версия 2 · 4\sоктября 2026, 12:40 · значения скрыты$/u)).toBeTruthy()
  })

  it('says so when no access is saved and when the list could not be read', () => {
    const { rerender } = render(<SiteSettings site={settingsSite} accesses={[]} />)
    expect(screen.getByText(/Доступов пока нет/)).toBeTruthy()
    rerender(<SiteSettings site={settingsSite} accesses={null} />)
    expect(screen.getByRole('alert').textContent).toMatch(/Не удалось загрузить список доступов/)
  })
})
