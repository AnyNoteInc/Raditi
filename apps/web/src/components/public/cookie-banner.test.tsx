// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { COOKIE_CONSENT_CHANGE_EVENT, COOKIE_SETTINGS_OPEN_EVENT } from '@/lib/cookie-consent'

import { CookieBanner, CookieSettingsButton } from './cookie-banner'

afterEach(() => {
  document.cookie = 'raditi_cookie_consent=; Path=/; Max-Age=0'
})

describe('CookieBanner', () => {
  it('shows nothing to a visitor who has chosen', () => {
    render(<CookieBanner initiallyOpen={false} />)

    expect(screen.queryByRole('region', { name: 'Файлы cookie' })).toBeNull()
  })

  it('writes the choice, tells the page and closes', () => {
    const changed = vi.fn()
    window.addEventListener(COOKIE_CONSENT_CHANGE_EVENT, changed)
    render(<CookieBanner initiallyOpen />)

    expect(
      screen.getByRole('link', { name: 'Политике обработки персональных данных' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Только необходимые' }))

    expect(document.cookie).toContain('raditi_cookie_consent=v1.necessary.')
    expect((changed.mock.calls[0]?.[0] as CustomEvent).detail.analyticsAllowed).toBe(false)
    expect(screen.queryByRole('region', { name: 'Файлы cookie' })).toBeNull()
    window.removeEventListener(COOKIE_CONSENT_CHANGE_EVENT, changed)
  })

  it('opens again from «Настройки cookie» and takes «Принять все»', () => {
    render(
      <>
        <CookieBanner initiallyOpen={false} />
        <CookieSettingsButton />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Настройки cookie' }))
    fireEvent.click(screen.getByRole('button', { name: 'Принять все' }))

    expect(document.cookie).toContain('raditi_cookie_consent=v1.all.')
    act(() => void window.dispatchEvent(new Event(COOKIE_SETTINGS_OPEN_EVENT)))
    expect(screen.getByRole('region', { name: 'Файлы cookie' })).toBeVisible()
  })
})
