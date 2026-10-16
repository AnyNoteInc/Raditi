import { describe, expect, it } from 'vitest'
import { normalizeSiteHost } from '../policies/site-address.ts'
import { siteHostKey } from './credits.ts'

// One site spends gift credits in one workspace only; this is the key the site is known by.

const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

describe('siteHostKey', () => {
  it.each([
    // the address a site is stored with is an origin
    ['https://example.ru', 'example.ru'],
    ['https://example.ru/', 'example.ru'],
    ['https://shop.example.ru', 'shop.example.ru'],
    // the scheme is not part of the key
    ['http://example.ru', 'example.ru'],
    // one leading www. is not either
    ['https://www.example.ru', 'example.ru'],
    ['http://www.example.ru', 'example.ru'],
    ['https://www.shop.example.ru', 'shop.example.ru'],
    // lower case and punycode, as the platform stores a host
    ['https://Example.RU', 'example.ru'],
    ['https://WWW.Example.RU', 'example.ru'],
    ['https://кофейня.рф', 'xn--e1aiboc0b6e.xn--p1ai'],
    ['https://www.кофейня.рф', 'xn--e1aiboc0b6e.xn--p1ai'],
    ['https://xn--e1aiboc0b6e.xn--p1ai', 'xn--e1aiboc0b6e.xn--p1ai'],
    // no trailing dot
    ['https://example.ru.', 'example.ru'],
    ['https://www.example.ru./', 'example.ru'],
  ])('%s → %s', (origin, key) => {
    expect(siteHostKey(origin)).toBe(key)
  })

  it.each([
    // the port a site is stored with keeps local sites apart
    ['http://localhost:8080', 'localhost:8080'],
    ['http://localhost:8081', 'localhost:8081'],
    ['http://localhost', 'localhost'],
    ['http://www.localhost:8080', 'localhost:8080'],
    ['https://example.ru:8443', 'example.ru:8443'],
    ['http://127.0.0.1:8080', '127.0.0.1:8080'],
    ['http://192.168.1.10', '192.168.1.10'],
    // the port of the scheme is not written in an origin
    ['http://example.ru:80', 'example.ru'],
    ['https://example.ru:443', 'example.ru'],
    // a port that is not the scheme's own is
    ['http://example.ru:443', 'example.ru:443'],
    ['https://example.ru:80', 'example.ru:80'],
  ])('keeps the port of %s: %s', (origin, key) => {
    expect(siteHostKey(origin)).toBe(key)
  })

  it.each([
    ['http://[::1]', '::1'],
    ['http://[::1]:8080', '[::1]:8080'],
    ['http://[0:0:0:0:0:0:0:1]:8080', '[::1]:8080'],
    ['https://[2A02:6B8::2:242]', '2a02:6b8::2:242'],
    ['https://[2a02:6b8::2:242]:8443', '[2a02:6b8::2:242]:8443'],
  ])('reads the IPv6 address of %s as %s', (origin, key) => {
    expect(siteHostKey(origin)).toBe(key)
  })

  it('keeps an IPv6 address with a port apart from the address its digits would spell', () => {
    expect(siteHostKey('http://[::1]:8080')).not.toBe(siteHostKey('http://[::1:8080]'))
    expect(siteHostKey('http://[::1:8080]')).toBe('::1:8080')
  })

  it('gives one key to every spelling of one site', () => {
    const spellings = [
      'https://example.ru',
      'http://example.ru',
      'https://www.example.ru',
      'http://www.example.ru/',
      'https://EXAMPLE.ru.',
      'https://example.ru:443',
      'http://WWW.example.RU:80',
    ]
    expect(new Set(spellings.map(siteHostKey))).toEqual(new Set(['example.ru']))
  })

  it('gives different keys to different sites', () => {
    const sites = [
      'https://example.ru',
      'https://shop.example.ru',
      'https://example.com',
      'https://example.ru:8443',
      'http://localhost:8080',
      'http://localhost:8081',
      'https://ww.example.ru',
      'https://wwwexample.ru',
    ]
    expect(new Set(sites.map(siteHostKey)).size).toBe(sites.length)
  })

  it('removes one www. and only at the front', () => {
    expect(siteHostKey('https://www.www.example.ru')).toBe('www.example.ru')
    expect(siteHostKey('https://shop.www.example.ru')).toBe('shop.www.example.ru')
    expect(siteHostKey('https://www2.example.ru')).toBe('www2.example.ru')
    // a host that is nothing but the label keeps it
    expect(siteHostKey('http://www')).toBe('www')
  })

  it('stands on the host as the platform normalises it', () => {
    for (const host of ['example.ru', 'Shop.Example.RU', 'кофейня.рф', '127.0.0.1', 'localhost']) {
      expect(siteHostKey(`https://${host}`)).toBe(normalizeSiteHost(host))
    }
  })

  it.each<[string, unknown]>([
    ['a bare host', 'example.ru'],
    ['a host with a port and no scheme', 'localhost:8080'],
    ['a page of the site', 'https://example.ru/contacts'],
    ['an address with a query', 'https://example.ru/?utm=1'],
    ['an address with a fragment', 'https://example.ru/#top'],
    ['an address with a login', 'https://user@example.ru'],
    ['an address with a login and a password', 'https://user:secret@example.ru'],
    ['an address with a password alone', 'https://:secret@example.ru'],
    ['another scheme', 'ftp://example.ru'],
    ['a mail address', 'mailto:owner@example.ru'],
    ['a scheme alone', 'https://'],
    ['a space inside', 'https://exa mple.ru'],
    ['a space around', ' https://example.ru'],
    ['a line break', 'https://example.ru\n'],
    ['a tab inside the host', 'https://exa\tmple.ru'],
    ['a backslash', 'https:\\\\example.ru'],
    ['a port that is not one', 'https://example.ru:99999'],
    ['an empty string', ''],
    ['a number', 8080],
    ['a URL object', new URL('https://example.ru')],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, origin) => {
    expect(() => siteHostKey(origin as string)).toThrow(badRequest)
  })
})
