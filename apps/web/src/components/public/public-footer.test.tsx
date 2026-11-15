// @vitest-environment jsdom
import { legalDocuments } from '@repo/domain'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { landingNavigation } from '@/components/landing/landing-navigation'
import { SITE_EMAIL, SITE_OPERATOR, SITE_PHONE } from '@/lib/contacts'

import { PublicFooter } from './public-footer'

const linksOf = (element: HTMLElement) =>
  within(element)
    .getAllByRole('link')
    .map((link) => [link.textContent.trim(), link.getAttribute('href')])

describe('footer of the public pages', () => {
  it('stands in columns as AnyNote has them: the brand, the product, the documents, the contacts', () => {
    render(<PublicFooter />)
    const footer = screen.getByRole('contentinfo')
    const columns = footer.firstElementChild?.children

    expect(columns).toHaveLength(4)
    expect(
      [...(columns ?? [])].slice(1).map((column) => column.firstElementChild?.textContent),
    ).toEqual(['Продукт', 'Документы', 'Контакты'])
  })

  it('keeps nothing in the column of the brand but the name and the way in', () => {
    render(<PublicFooter />)
    const brand = screen.getByRole('contentinfo').firstElementChild?.firstElementChild

    expect(brand).toHaveTextContent(/^РадитиВойти$/)
    expect(
      within(brand as HTMLElement).getByRole('link', { name: 'Радити — на главную' }),
    ).toHaveAttribute('href', '/')
  })

  it('leads to the sections of the landing from any page', () => {
    render(<PublicFooter />)

    expect(linksOf(screen.getByRole('navigation', { name: 'Продукт' }))).toEqual(
      landingNavigation.map(({ href, label }) => [label, `/${href}`]),
    )
  })

  it('lists every legal document', () => {
    render(<PublicFooter />)

    expect(linksOf(screen.getByRole('navigation', { name: 'Документы' }))).toEqual(
      legalDocuments.map((document) => [document.title, `/terms/${document.slug}`]),
    )
  })

  it('names the operator, the mail and the phone, and no messenger', () => {
    render(<PublicFooter />)
    const contacts = screen.getByRole('contentinfo').querySelector('address')

    // Read as it is: the initials keep their non-breaking spaces.
    expect([...(contacts?.children ?? [])].map((line) => line.textContent)).toEqual([
      `${SITE_OPERATOR.name}, ${SITE_OPERATOR.status}`,
      `ИНН ${SITE_OPERATOR.inn}`,
      SITE_EMAIL,
      SITE_PHONE.text,
    ])
    expect(linksOf(contacts as HTMLElement)).toEqual([
      [SITE_EMAIL, `mailto:${SITE_EMAIL}`],
      [SITE_PHONE.text, `tel:${SITE_PHONE.tel}`],
    ])
    expect(screen.getByRole('contentinfo')).not.toHaveTextContent(/telegram|телеграм/i)
  })

  it('ends with the copyright, the map of the site, the cookie settings and the way up', () => {
    render(<PublicFooter />)
    const footer = screen.getByRole('contentinfo')

    expect(footer).toHaveTextContent(`© ${new Date().getFullYear()} Радити. Все права защищены.`)
    expect(within(footer).getByRole('link', { name: 'Карта сайта' })).toHaveAttribute(
      'href',
      '/sitemap.xml',
    )
    expect(within(footer).getByRole('button', { name: 'Настройки cookie' })).toBeInTheDocument()
    expect(within(footer).getByRole('link', { name: 'Вернуться наверх' })).toHaveAttribute(
      'href',
      '#top',
    )
  })

  it('offers the sign-in to a guest and the chats to anybody else', () => {
    const { unmount } = render(<PublicFooter />)
    expect(screen.getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/sign-in')
    unmount()

    render(<PublicFooter isGuest={false} />)
    expect(screen.getByRole('link', { name: 'Открыть чаты' })).toHaveAttribute('href', '/chats')
    expect(screen.queryByRole('link', { name: 'Войти' })).not.toBeInTheDocument()
  })

  it('closes with the word of the brand and its sign, hidden from a screen reader', () => {
    render(<PublicFooter />)
    const word = screen.getByRole('contentinfo').lastElementChild

    expect(word).toHaveAttribute('aria-hidden', 'true')
    expect(word?.firstChild?.textContent).toBe('радити')
    expect(word?.querySelectorAll('svg circle')).toHaveLength(1)
  })
})
