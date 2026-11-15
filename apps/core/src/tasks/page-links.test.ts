import { describe, expect, it } from 'vitest'

import { pageLinkWarnings } from './page-links.ts'

// The links of a page to its site (docs/plan/73-pages-sites.md, Дер20).

const site = new Set(['/', '/uslugi', '/uslugi/remont'])

describe('pageLinkWarnings', () => {
  it('passes links from the root to pages of the site, and what is no link of it', () => {
    const html = `<a href="/">Главная</a><a href='/uslugi'>Услуги</a><a href=/uslugi/remont?x=1#top>Ремонт</a>
      <a href="https://example.com/a">наружу</a><a href="//cdn.example.com/x">cdn</a><a href="#top">вверх</a>
      <a href="mailto:a@example.test">почта</a><a href="tel:+79190000000">звонок</a><img src="/net">`
    expect(pageLinkWarnings(html, site)).toEqual([])
  })

  it('tells a path no page has and a relative link, each once', () => {
    const html = `<a href="/kontakty">К</a><a href="/kontakty">К</a><a href="ceny.html">Ц</a><a href="/Uslugi">У</a>`
    expect(pageLinkWarnings(html, site)).toEqual([
      { href: '/kontakty', problem: 'missing' },
      { href: 'ceny.html', problem: 'relative' },
      { href: '/Uslugi', problem: 'missing' },
    ])
  })

  it('tells no text of a link outside the letters of a path, and stops at twenty', () => {
    expect(pageLinkWarnings('<a href="/a b">x</a>', site)).toEqual([
      { href: '…', problem: 'missing' },
    ])
    const many = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">x</a>`).join('')
    expect(pageLinkWarnings(many, site)).toHaveLength(20)
  })

  it('leaves the shared files of a site to their own check', () => {
    expect(pageLinkWarnings('<link href="/_files/style.css">', site)).toEqual([])
  })
})
