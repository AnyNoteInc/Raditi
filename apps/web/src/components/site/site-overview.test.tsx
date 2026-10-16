// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SiteOverview } from './site-overview'

describe('site overview', () => {
  it.each([
    ['onboarding', 'Ожидает подключения', /ещё не подключён/],
    ['paused', 'На паузе', /^Работа с сайтом приостановлена/],
    ['disconnected', 'Нет подключения', /потеряли связь/],
    ['archived', 'В архиве', /^Сайт в архиве/],
  ] as const)('names the %s status and why the site is in it', (status, label, reason) => {
    render(<SiteOverview site={{ status, state: 'free' }} />)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText(reason)).toBeTruthy()
  })

  it.each([
    ['paused', 'Пока работа приостановлена, остальные разделы сайта недоступны.'],
    ['disconnected', 'Пока связи с сайтом нет, остальные разделы сайта недоступны.'],
    ['archived', 'Пока сайт в архиве, остальные разделы сайта недоступны.'],
  ] as const)('tells the owner of a %s site that its other sections are closed', (status, note) => {
    const { container } = render(<SiteOverview site={{ status, state: 'free' }} />)
    expect(screen.getByText(note)).toBeTruthy()
    // No action is promised: the page has none to offer.
    expect(container.querySelector('a, button')).toBeNull()
  })

  it.each(['onboarding', 'active'] as const)(
    'says nothing about closed sections of a %s site',
    (status) => {
      const { container } = render(<SiteOverview site={{ status, state: 'free' }} />)
      expect(container.textContent).not.toMatch(/недоступны/)
    },
  )

  it('gives a connected site no reason and does not send the owner to settings they cannot change', () => {
    const { container } = render(<SiteOverview site={{ status: 'active', state: 'free' }} />)
    expect(screen.getByText('Подключён')).toBeTruthy()
    expect(container.textContent).not.toMatch(/Настройк/)
  })

  it.each([
    ['free', /ничего не выполняется/],
    ['busy', /идёт работа/],
    ['held', /временно закрыт для новых правок/],
  ] as const)('tells a %s site apart', (state, phrase) => {
    render(<SiteOverview site={{ status: 'active', state }} />)
    expect(screen.getByText(phrase)).toBeTruthy()
  })
})
