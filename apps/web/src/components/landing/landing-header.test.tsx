// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LandingHeader } from './landing-header'
import { guest, member, stubIntersectionObserver, type ObserverStub } from './testing'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

/** Opens the mobile menu with its button and returns the navigation inside it. */
function openMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }))
  return screen.getByRole('navigation', { name: 'Мобильная навигация' })
}

describe('landing account navigation', () => {
  it('offers sign-in and registration to a guest, in the header and in the mobile menu', () => {
    render(<LandingHeader viewer={guest} />)

    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/sign-in')
    // The mobile menu is closed, so this is the button of the header itself.
    expect(screen.getByRole('link', { name: 'Зарегистрироваться' })).toHaveAttribute(
      'href',
      '/sign-up',
    )
    expect(screen.queryByRole('button', { name: 'Меню пользователя' })).not.toBeInTheDocument()
    const mobile = openMenu()
    expect(within(mobile).getByRole('link', { name: 'Зарегистрироваться' })).toHaveAttribute(
      'href',
      '/sign-up',
    )
  })

  it('keeps only the account avatar in the authenticated header and puts projects in its menu', () => {
    render(<LandingHeader viewer={member} />)

    const account = screen.getByRole('button', { name: 'Меню пользователя' })
    expect(within(account).getByText('АИ')).toBeVisible()
    expect(account.querySelector('svg')).toBeNull()
    expect(screen.queryByText('Анна')).not.toBeInTheDocument()
    expect(screen.queryByText('Анна Иванова')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Проекты' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Войти' })).not.toBeInTheDocument()
    const mobile = openMenu()
    expect(within(mobile).queryByRole('link', { name: 'Открыть проекты' })).not.toBeInTheDocument()
    expect(within(mobile).getAllByRole('link')).toHaveLength(4)
    // Neither in the open mobile menu nor in the header itself.
    expect(screen.queryByRole('link', { name: 'Зарегистрироваться' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть меню' }))
    fireEvent.click(screen.getByRole('button', { name: 'Меню пользователя' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Анна Иванова')).toBeVisible()
    expect(within(menu).getByText('anna@example.ru')).toBeVisible()
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Проекты', 'Профиль', 'Настройки', 'Выход'])
    expect(within(menu).getByRole('menuitem', { name: 'Проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Профиль' })).toHaveAttribute(
      'href',
      '/profile',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Настройки' })).toHaveAttribute(
      'href',
      '/settings',
    )
    expect(within(menu).getByRole('menuitem', { name: 'Выход' })).toBeEnabled()
  })

  it('does not present a failed session lookup as a signed-out state', () => {
    render(<LandingHeader viewer={{ status: 'unavailable', user: null }} />)

    expect(screen.queryByRole('link', { name: 'Войти' })).not.toBeInTheDocument()
    // The name is the label on the screen: a voice command says what it sees.
    const projects = screen.getByRole('link', { name: 'Проекты' })
    expect(projects).toHaveAttribute('href', '/projects')
    expect(projects).not.toHaveAttribute('aria-label')
    expect(screen.queryByRole('button', { name: 'Меню пользователя' })).not.toBeInTheDocument()
    const mobile = openMenu()
    expect(within(mobile).getByRole('link', { name: 'Открыть проекты' })).toHaveAttribute(
      'href',
      '/projects',
    )
    // Neither in the open mobile menu nor in the header itself.
    expect(screen.queryByRole('link', { name: 'Зарегистрироваться' })).not.toBeInTheDocument()
  })

  it('leads to the questions from both navigations', () => {
    render(<LandingHeader viewer={guest} />)

    const desktop = screen.getByRole('navigation', { name: 'Основная навигация' })
    expect(
      within(desktop)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Как это работает', '#how'],
      ['Возможности', '#possibilities'],
      ['Тарифы', '#pricing'],
      ['Вопросы', '#faq'],
    ])
    const mobile = openMenu()
    expect(within(mobile).getByRole('link', { name: 'Вопросы' })).toHaveAttribute('href', '#faq')
  })

  it('keeps the links of the closed menu out of reach while it is leaving', () => {
    render(<LandingHeader viewer={guest} />)
    // CSS lets the closed panel fade out, so `hidden` alone would leave its links focusable
    // for that moment: `inert` takes them away at once.
    const menu = () => document.getElementById('landing-navigation')
    expect(menu()).toHaveAttribute('inert')
    expect(menu()).toHaveAttribute('hidden')

    const toggle = screen.getByRole('button', { name: 'Открыть меню' })
    fireEvent.click(toggle)
    expect(menu()).not.toHaveAttribute('inert')
    expect(menu()).not.toHaveAttribute('hidden')
    // The cross of the button is drawn from this state.
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle.querySelectorAll('span')).toHaveLength(2)

    fireEvent.click(toggle)
    expect(menu()).toHaveAttribute('inert')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  describe('with the page scrolled', () => {
    let observers: ObserverStub[] = []
    /** The observer of the header reports a section by its id. */
    const report = (id: string, isIntersecting: boolean) => {
      const target = document.getElementById(id)
      const observer = observers.at(-1)
      if (!target || !observer?.observed.has(target)) throw new Error(`${id} is not observed`)
      observer.report(target, isIntersecting)
    }

    beforeEach(() => {
      for (const id of ['how', 'possibilities', 'safety', 'pricing', 'faq']) {
        const section = document.createElement('section')
        section.id = id
        document.body.append(section)
      }
      observers = stubIntersectionObserver()
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      document.body.replaceChildren()
    })

    const current = () =>
      screen
        .getAllByRole('link', { hidden: true })
        .filter((link) => link.hasAttribute('aria-current'))
        .map((link) => [
          link.closest('nav')?.getAttribute('aria-label'),
          link.textContent,
          link.getAttribute('aria-current'),
        ])

    it('marks the section being read in both navigations and no link between the sections', () => {
      render(<LandingHeader viewer={guest} />)
      // A thin band above the middle of the window.
      expect(observers.at(-1)?.options?.rootMargin).toBe('-45% 0px -50% 0px')
      expect(current()).toEqual([])

      report('pricing', true)
      expect(current()).toEqual([
        ['Основная навигация', 'Тарифы', 'true'],
        ['Мобильная навигация', 'Тарифы', 'true'],
      ])

      // On the way to the next section both cross the band for a moment: the earlier one stays.
      report('faq', true)
      expect(current().map(([, label]) => label)).toEqual(['Тарифы', 'Тарифы'])
      report('pricing', false)
      expect(current().map(([, label]) => label)).toEqual(['Вопросы', 'Вопросы'])

      report('faq', false)
      expect(current()).toEqual([])
    })

    it('watches only the sections of the navigation', () => {
      render(<LandingHeader viewer={guest} />)

      expect(() => report('how', false)).not.toThrow()
      expect(() => report('safety', true)).toThrow('safety is not observed')
      expect(current()).toEqual([])
    })
  })

  it('closes the mobile menu on Escape and returns the focus to its toggle', () => {
    render(<LandingHeader viewer={guest} />)

    expect(openMenu()).toBeVisible()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen.queryByRole('navigation', { name: 'Мобильная навигация' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Открыть меню' })).toHaveFocus()
  })

  it('closes the mobile menu on a press outside the header, not on one inside it', () => {
    render(
      <>
        <LandingHeader viewer={guest} />
        <main>Страница</main>
      </>,
    )
    const menu = openMenu()

    fireEvent.pointerDown(within(menu).getByRole('link', { name: 'Тарифы' }))
    fireEvent.pointerDown(screen.getByRole('link', { name: 'Радити — на главную' }))
    expect(menu).toBeVisible()

    fireEvent.pointerDown(screen.getByText('Страница'))
    expect(
      screen.queryByRole('navigation', { name: 'Мобильная навигация' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Открыть меню' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('closes the mobile menu when the focus goes on past the header, not when it stays in it', () => {
    render(
      <>
        <LandingHeader viewer={guest} />
        <button type="button">Дальше</button>
      </>,
    )
    const menu = openMenu()
    const last = within(menu).getByRole('link', { name: 'Зарегистрироваться' })

    act(() => last.focus())
    act(() => screen.getByRole('button', { name: 'Закрыть меню' }).focus())
    expect(menu).toBeVisible()
    // The focus has left the window, the visitor has not left the menu.
    fireEvent.focusOut(screen.getByRole('button', { name: 'Закрыть меню' }), {
      relatedTarget: null,
    })
    expect(menu).toBeVisible()

    act(() => last.focus())
    const next = screen.getByRole('button', { name: 'Дальше' })
    act(() => next.focus())
    expect(
      screen.queryByRole('navigation', { name: 'Мобильная навигация' }),
    ).not.toBeInTheDocument()
    // The focus stays where the visitor moved it.
    expect(next).toHaveFocus()
  })
})
