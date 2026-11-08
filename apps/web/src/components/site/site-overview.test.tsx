// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SiteOverview } from './site-overview'

/** The dot of the connection, by the status in its name. */
const dot = (status: string) => screen.getByRole('button', { name: `Подключение: ${status}` })

/** The tooltip of the dot, as a pointer over it brings it up. */
async function tooltipOf(status: string) {
  fireEvent.mouseOver(dot(status))
  return screen.findByRole('tooltip')
}

/** What the server says of a chat of a project whose files the agent cannot change. */
const browserChat = { requirements: { repository: false, browser: true } }

describe('site overview', () => {
  it.each([
    ['onboarding', 'Ожидает подключения', /ещё не подключён/],
    ['paused', 'На паузе', /^Работа с сайтом приостановлена/],
    ['disconnected', 'Нет подключения', /потеряли связь/],
    ['archived', 'В архиве', /^Сайт в архиве/],
  ] as const)('names the %s status and why the site is in it', async (status, label, reason) => {
    render(<SiteOverview site={{ status, state: 'free' }} />)
    const tooltip = await tooltipOf(label)
    expect(tooltip).toHaveTextContent(label)
    expect(within(tooltip).getByText(reason)).toBeTruthy()
  })

  it('shows the connection as a dot, not as a section of the page', () => {
    render(<SiteOverview site={{ status: 'active', state: 'free' }} />)
    expect(screen.queryByRole('heading', { name: 'Подключение' })).toBeNull()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(dot('Подключён')).toBeTruthy()
  })

  it.each([
    ['active', 'Подключён', 'ok'],
    ['onboarding', 'Ожидает подключения', 'waiting'],
    ['paused', 'На паузе', 'waiting'],
    ['disconnected', 'Нет подключения', 'broken'],
    ['archived', 'В архиве', 'off'],
  ] as const)('colours the dot of a %s site', (status, label, tone) => {
    render(<SiteOverview site={{ status, state: 'free' }} />)
    expect(dot(label).querySelector('[data-tone]')).toHaveAttribute('data-tone', tone)
  })

  it('opens and closes the tooltip by a click, which is what a tap comes as', async () => {
    render(<SiteOverview site={{ status: 'paused', state: 'free' }} />)
    fireEvent.click(dot('На паузе'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/приостановлена/)
    fireEvent.click(dot('На паузе'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
  })

  it('names what the platform knows of a connected site', async () => {
    render(
      <SiteOverview
        site={{
          status: 'active',
          state: 'free',
          host: 'example.ru',
          stack: 'wordpress',
          capabilities: { repository: 'ready', browser: 'insecure' },
        }}
      />,
    )
    const tooltip = await tooltipOf('Подключён')
    expect(tooltip).toHaveTextContent('Адрес:example.ru')
    expect(tooltip).toHaveTextContent('Платформа:WordPress')
    expect(tooltip).toHaveTextContent('Файлы сайта:агент правит их в предпросмотре')
    expect(tooltip).toHaveTextContent('Работа через браузер:сайт должен открываться по https://')
  })

  it('says when the platform of the site has no work through the browser', async () => {
    render(
      <SiteOverview
        site={{
          status: 'active',
          state: 'free',
          capabilities: { repository: 'ready', browser: 'unsupported' },
        }}
      />,
    )
    expect(await tooltipOf('Подключён')).toHaveTextContent(
      'Работа через браузер:для этой платформы пока недоступна',
    )
  })

  it.each([
    ['paused', 'Пока работа приостановлена, остальные разделы сайта недоступны.'],
    ['disconnected', 'Пока связи с сайтом нет, остальные разделы сайта недоступны.'],
    ['archived', 'Пока сайт в архиве, остальные разделы сайта недоступны.'],
  ] as const)(
    'tells the owner of a %s site that its other sections are closed',
    async (status, note) => {
      const { container } = render(<SiteOverview site={{ status, state: 'free' }} />)
      const [button, ...others] = container.querySelectorAll('button')
      fireEvent.mouseOver(button!)
      expect(within(await screen.findByRole('tooltip')).getByText(note)).toBeTruthy()
      // No action is promised: the page has none to offer, the dot only tells.
      expect(others).toEqual([])
      expect(container.querySelector('a')).toBeNull()
    },
  )

  it.each([
    ['onboarding', 'Ожидает подключения'],
    ['active', 'Подключён'],
  ] as const)('says nothing about closed sections of a %s site', async (status, label) => {
    render(<SiteOverview site={{ status, state: 'free' }} />)
    expect((await tooltipOf(label)).textContent).not.toMatch(/недоступны/)
  })

  it('gives a connected site no reason and does not send the owner to settings they cannot change', async () => {
    render(<SiteOverview site={{ status: 'active', state: 'free' }} />)
    const tooltip = await tooltipOf('Подключён')
    expect(tooltip.textContent).toBe('Подключён')
    expect(tooltip.textContent).not.toMatch(/Настройк/)
  })

  it('leads a site added without access to its files to a new chat of this project', async () => {
    const id = '019f1a21-1800-8f00-8abc-111111111111'
    const { container } = render(
      <SiteOverview
        site={{
          id,
          status: 'onboarding',
          state: 'free',
          capabilities: { repository: 'absent', browser: 'ready' },
          chat: browserChat,
        }}
      />,
    )
    expect(screen.getByRole('link', { name: 'Новый чат' }).getAttribute('href')).toBe(
      `/chats/new?project=${id}`,
    )
    const tooltip = await tooltipOf('Ожидает подключения')
    expect(
      within(tooltip).getByText(
        'Сайт добавлен без доступа к файлам. Выберите этот проект в новом чате.',
      ),
    ).toBeTruthy()
    expect(within(tooltip).queryByText(/ещё не подключён/)).toBeNull()
    // The owner's words of 31.10.2026: nothing says how the agent works on such a site.
    expect(container.textContent).not.toMatch(/админк|сразу|без выпуска|разделе «Чат»/)
    expect(tooltip.textContent).not.toMatch(/админк|сразу|без выпуска|разделе «Чат»/)
  })

  describe('a site that the wizard imported and that is not connected yet', () => {
    const id = '019f1a21-1800-8f00-8abc-111111111111'
    const imported = { id, status: 'onboarding', state: 'free', setup: 'done' } as const
    /** No word of the tooltip says how the agent works on the live site (31.10.2026). */
    const unsaid = /админк|сразу|без выпуска|разделе «Чат»/

    it('leads it to a new chat in the browser when the server takes one', async () => {
      const { container } = render(
        <SiteOverview
          site={{
            ...imported,
            capabilities: { repository: 'inactive', browser: 'ready' },
            chat: browserChat,
          }}
        />,
      )
      expect(screen.getByRole('link', { name: 'Новый чат' }).getAttribute('href')).toBe(
        `/chats/new?project=${id}`,
      )
      const tooltip = await tooltipOf('Ожидает подключения')
      expect(
        within(tooltip).getByText(
          'Файлы сайта сохранены, но менять их агент пока не может: остальную часть подключения мы ещё делаем. В браузере, на живом сайте, агент может работать уже сейчас — выберите этот проект в новом чате.',
        ),
      ).toBeTruthy()
      expect(container.textContent).not.toMatch(unsaid)
      expect(tooltip.textContent).not.toMatch(unsaid)
    })

    it('offers no new chat and says the agent cannot change the site when the server takes none', async () => {
      render(
        <SiteOverview
          site={{
            ...imported,
            capabilities: { repository: 'inactive', browser: 'not_configured' },
            chat: { requirements: null },
          }}
        />,
      )
      expect(screen.queryByRole('link', { name: 'Новый чат' })).toBeNull()
      const tooltip = await tooltipOf('Ожидает подключения')
      expect(
        within(tooltip).getByText(
          'Файлы сайта сохранены, но агент пока не может менять сайт: остальную часть подключения мы ещё делаем.',
        ),
      ).toBeTruthy()
      expect(tooltip.textContent).not.toMatch(unsaid)
    })

    it('takes the chat from the server, not from what the site can be worked on with', () => {
      render(
        <SiteOverview
          site={{ ...imported, capabilities: { repository: 'inactive', browser: 'ready' } }}
        />,
      )
      expect(screen.queryByRole('link', { name: 'Новый чат' })).toBeNull()
    })
  })

  it('leads a connected site to a new chat of this project', () => {
    render(
      <SiteOverview
        site={{
          id: '019f1a21-1800-8f00-8abc-111111111111',
          status: 'active',
          state: 'free',
          chat: { requirements: { repository: true, browser: true } },
        }}
      />,
    )
    expect(screen.getByRole('link', { name: 'Новый чат' })).toBeTruthy()
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

    it('says the files are saved but the agent cannot change the site yet', async () => {
      render(
        <SiteOverview
          site={{ status: 'onboarding', state: 'free', setup: 'done', initialVersion: version }}
        />,
      )
      const tooltip = await tooltipOf('Ожидает подключения')
      expect(
        within(tooltip).getByText(
          'Файлы сайта сохранены, но агент пока не может менять сайт: остальную часть подключения мы ещё делаем.',
        ),
      ).toBeTruthy()
      expect(within(tooltip).queryByText(/Подключение из кабинета мы ещё делаем/)).toBeNull()
    })

    it('shows the card for a done setup even before its version is read', () => {
      render(<SiteOverview site={{ status: 'onboarding', state: 'free', setup: 'done' }} />)
      expect(screen.getByText('Первоначальная версия сайта сохранена')).toBeTruthy()
      expect(screen.getByText('Файлы сайта скопированы.')).toBeTruthy()
    })

    it('shows nothing of an import for a site from before the wizard', async () => {
      const { container } = render(
        <SiteOverview site={{ status: 'onboarding', state: 'free', setup: null }} />,
      )
      expect(container.textContent).not.toMatch(/Первоначальная версия/)
      const tooltip = await tooltipOf('Ожидает подключения')
      expect(within(tooltip).getByText(/Подключение из кабинета мы ещё делаем/)).toBeTruthy()
    })
  })
})
