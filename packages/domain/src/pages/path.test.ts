import { describe, expect, it } from 'vitest'

import { pageLimits } from './limits.ts'
import {
  parentPagePath,
  pagePathOf,
  pagePathSchema,
  pageRequestPath,
  pageSegmentSchema,
} from './path.ts'
import { pageAddressUrl } from './address.ts'
import { pageCustomNamesAllowed, pageSitesLimit } from './sites.ts'

// The path of a page in its site (docs/plan/73-pages-sites.md, Дер15): nothing decoded, normalised
// or guessed; two forms sent on to the canon, everything else 404 without a lookup.

const deep = (levels: number) => `/${Array.from({ length: levels }, () => 'a').join('/')}`
const long = (chars: number) => `/${'a'.repeat(chars - 1)}`

const requests: [string, ReturnType<typeof pageRequestPath>][] = [
  // the canon
  ['/', { kind: 'page', path: '/' }],
  ['/uslugi', { kind: 'page', path: '/uslugi' }],
  ['/uslugi/remont', { kind: 'page', path: '/uslugi/remont' }],
  ['/a', { kind: 'page', path: '/a' }],
  ['/0', { kind: 'page', path: '/0' }],
  ['/2026', { kind: 'page', path: '/2026' }],
  ['/a-b', { kind: 'page', path: '/a-b' }],
  ['/a--b', { kind: 'page', path: '/a--b' }],
  ['/a1-b2-c3', { kind: 'page', path: '/a1-b2-c3' }],
  [`/${'a'.repeat(63)}`, { kind: 'page', path: `/${'a'.repeat(63)}` }],
  [deep(8), { kind: 'page', path: deep(8) }],
  ['/a/b/c', { kind: 'page', path: '/a/b/c' }],
  // sent on to the canon
  ['/uslugi/', { kind: 'redirect', path: '/uslugi' }],
  ['/a/b/', { kind: 'redirect', path: '/a/b' }],
  ['/A', { kind: 'redirect', path: '/a' }],
  ['/A/b', { kind: 'redirect', path: '/a/b' }],
  ['/Uslugi/Remont', { kind: 'redirect', path: '/uslugi/remont' }],
  ['/USLUGI/', { kind: 'redirect', path: '/uslugi' }],
  ['/a-B', { kind: 'redirect', path: '/a-b' }],
  // nothing to look up
  ['', { kind: 'none' }],
  ['uslugi', { kind: 'none' }],
  ['//', { kind: 'none' }],
  ['//a', { kind: 'none' }],
  ['/a//b', { kind: 'none' }],
  ['/a//', { kind: 'none' }],
  ['/./a', { kind: 'none' }],
  ['/.', { kind: 'none' }],
  ['/..', { kind: 'none' }],
  ['/a/..', { kind: 'none' }],
  ['/a/../b', { kind: 'none' }],
  ['/%2e', { kind: 'none' }],
  ['/%2e%2e', { kind: 'none' }],
  ['/%2E%2E/a', { kind: 'none' }],
  ['/a%2fb', { kind: 'none' }],
  ['/a%20b', { kind: 'none' }],
  ['/a b', { kind: 'none' }],
  ['/a;b', { kind: 'none' }],
  ['/a;jsessionid=1', { kind: 'none' }],
  ['/a\\b', { kind: 'none' }],
  ['/\\a', { kind: 'none' }],
  ['/robots.txt', { kind: 'none' }],
  ['/index.html', { kind: 'none' }],
  ['/a.html', { kind: 'none' }],
  ['/-a', { kind: 'none' }],
  ['/a-', { kind: 'none' }],
  ['/-', { kind: 'none' }],
  ['/_a', { kind: 'none' }],
  ['/_files/x', { kind: 'none' }],
  ['/a_b', { kind: 'none' }],
  ['/услуги', { kind: 'none' }],
  ['/%D1%83', { kind: 'none' }],
  ['/ａ', { kind: 'none' }],
  ['/a\u0000', { kind: 'none' }],
  ['/a\n', { kind: 'none' }],
  ['/a?b', { kind: 'none' }],
  ['/a#b', { kind: 'none' }],
  ['/a+b', { kind: 'none' }],
  ['/~a', { kind: 'none' }],
  ['/@a', { kind: 'none' }],
  [`/${'a'.repeat(64)}`, { kind: 'none' }],
  [deep(9), { kind: 'none' }],
  [`${deep(9)}/`, { kind: 'none' }],
  ['http://evil.example/a', { kind: 'none' }],
  ['https://x.pages.raditi.ru/a', { kind: 'none' }],
  ['*', { kind: 'none' }],
  [long(513), { kind: 'none' }],
  [`/A/${'a'.repeat(64)}`, { kind: 'none' }],
  ['/A/./b', { kind: 'none' }],
  ['/A%2e', { kind: 'none' }],
]

describe('the path of a request (Дер15)', () => {
  it('has more than sixty rows', () => {
    expect(requests.length).toBeGreaterThan(60)
  })

  for (const [raw, expected] of requests)
    it(`reads ${JSON.stringify(raw)}`, () => expect(pageRequestPath(raw)).toEqual(expected))

  it('sends on only to a path the schema takes', () => {
    for (const [raw] of requests) {
      const read = pageRequestPath(raw)
      if (read.kind !== 'none') expect(pagePathSchema.safeParse(read.path).success).toBe(true)
    }
  })

  it('keeps a canonical path within its characters', () => {
    const segments = Array.from({ length: pageLimits.pageDepth }, () => 'a'.repeat(63))
    const path = `/${segments.join('/')}`
    expect(path.length).toBeLessThanOrEqual(pageLimits.pagePathChars)
    expect(pageRequestPath(path)).toEqual({ kind: 'page', path })
  })
})

describe('segments and paths', () => {
  it('takes a lower-case label as a segment, nothing else', () => {
    for (const ok of ['a', 'kontakty', 'a-1', '9']) expect(pageSegmentSchema.parse(ok)).toBe(ok)
    for (const bad of ['', 'A', 'a.b', '-a', 'a-', 'а', 'a b', 'a/b', '..'])
      expect(pageSegmentSchema.safeParse(bad).success).toBe(false)
  })

  it('makes the canon of segments, and the path of the parent', () => {
    expect(pagePathOf([])).toBe('/')
    expect(pagePathOf(['uslugi', 'remont'])).toBe('/uslugi/remont')
    expect(() => pagePathOf(['Uslugi'])).toThrow()
    expect(() => pagePathOf(Array.from({ length: 9 }, () => 'a'))).toThrow()
    expect(parentPagePath('/')).toBeNull()
    expect(parentPagePath('/uslugi')).toBe('/')
    expect(parentPagePath('/uslugi/remont')).toBe('/uslugi')
    expect(() => parentPagePath('/uslugi/')).toThrow()
  })

  it('names a page by the host of its site and its path', () => {
    const address = { baseDomain: 'pages.raditi.ru', scheme: 'https' as const }
    const slug = 'a'.repeat(26)
    expect(pageAddressUrl(slug, address)).toBe(`https://${slug}.pages.raditi.ru/`)
    expect(pageAddressUrl(slug, address, '/uslugi/remont')).toBe(
      `https://${slug}.pages.raditi.ru/uslugi/remont`,
    )
    expect(() => pageAddressUrl(slug, address, '/../x')).toThrow()
  })
})

describe('sites of a tariff (Дер32, Дер36)', () => {
  it('reads the limit of the tariff, one site without a tariff', () => {
    expect(pageSitesLimit({ pageSites: 2 })).toBe(2)
    expect(pageSitesLimit({ pageSites: 20 })).toBe(20)
    expect(pageSitesLimit({ pageSites: null })).toBe(1)
    expect(pageSitesLimit(null)).toBe(1)
  })

  it('allows an own name only where the tariff says so', () => {
    expect(pageCustomNamesAllowed({ pageCustomNames: true })).toBe(true)
    expect(pageCustomNamesAllowed({ pageCustomNames: false })).toBe(false)
    expect(pageCustomNamesAllowed(null)).toBe(false)
  })
})
