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

  it('says a site added without access to its files works through the browser', () => {
    render(
      <SiteOverview
        site={{
          status: 'onboarding',
          state: 'free',
          capabilities: { repository: 'absent', browser: 'ready' },
        }}
      />,
    )
    expect(screen.getByText(/Сайт добавлен без доступа к файлам/)).toBeTruthy()
    expect(screen.queryByText(/ещё не подключён/)).toBeNull()
  })

  it.each([
    ['free', /ничего не выполняется/],
    ['busy', /идёт работа/],
    ['held', /временно закрыт для новых правок/],
  ] as const)('tells a %s site apart', (state, phrase) => {
    render(<SiteOverview site={{ status: 'active', state }} />)
    expect(screen.getByText(phrase)).toBeTruthy()
  })

  describe('a site whose files were imported', () => {
    const version = {
      tag: 'v0.0.0',
      commitSha: 'a'.repeat(40),
      importedAt: new Date('2026-10-17T09:40:00Z'),
    }

    it('shows the saved first version with its tag and the Moscow time', () => {
      render(
        <SiteOverview
          site={{ status: 'onboarding', state: 'free', setup: 'done', initialVersion: version }}
        />,
      )
      const card = screen
        .getByRole('heading', { name: 'Первоначальная версия сайта сохранена' })
        .closest('section')!
      expect(card).toHaveTextContent('v0.0.0')
      expect(card).toHaveTextContent('17 октября 2026, 12:40')
      expect(card.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-17T09:40:00.000Z')
    })

    it('says the files are saved but the agent cannot change the site yet', () => {
      render(
        <SiteOverview
          site={{ status: 'onboarding', state: 'free', setup: 'done', initialVersion: version }}
        />,
      )
      expect(
        screen.getByText(
          'Файлы сайта сохранены, но агент пока не может менять сайт: остальную часть подключения мы ещё делаем.',
        ),
      ).toBeTruthy()
      expect(screen.queryByText(/Подключение из кабинета мы ещё делаем/)).toBeNull()
    })

    it('shows the card for a done setup even before its version is read', () => {
      render(<SiteOverview site={{ status: 'onboarding', state: 'free', setup: 'done' }} />)
      expect(screen.getByText('Первоначальная версия сайта сохранена')).toBeTruthy()
      expect(screen.getByText('Файлы сайта скопированы.')).toBeTruthy()
    })

    it('shows nothing of an import for a site from before the wizard', () => {
      const { container } = render(
        <SiteOverview site={{ status: 'onboarding', state: 'free', setup: null }} />,
      )
      expect(container.textContent).not.toMatch(/Первоначальная версия/)
      expect(screen.getByText(/Подключение из кабинета мы ещё делаем/)).toBeTruthy()
    })
  })
})
