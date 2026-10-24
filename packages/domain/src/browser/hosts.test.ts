import { describe, expect, it } from 'vitest'

import { browserAllowedHosts, browserLocalSiteOrigin, browserNavigationAllowed } from './hosts.ts'

describe('browserAllowedHosts', () => {
  it('lets the browser reach the site, its www. twin and the hosts of its stack', () => {
    expect(
      browserAllowedHosts('https://News.Example.ru/', ['s.w.org', 'secure.gravatar.com'], []),
    ).toEqual([
      'news.example.ru:443',
      'www.news.example.ru:443',
      's.w.org:443',
      'secure.gravatar.com:443',
    ])
    expect(
      browserAllowedHosts('https://www.example.ru/blog/', [], ['cdn.example.net:8443']),
    ).toEqual(['www.example.ru:443', 'example.ru:443', 'cdn.example.net:8443'])
  })

  it('keeps a port the site names, and lists each host once', () => {
    expect(
      browserAllowedHosts('https://example.ru:8443', ['example.ru:8443', 'S.W.org'], ['s.w.org']),
    ).toEqual(['example.ru:8443', 'www.example.ru:8443', 's.w.org:443'])
  })

  it('adds nothing for a site it may not reach over https by a public name', () => {
    for (const site of [
      'http://example.ru',
      'https://203.0.113.10',
      'https://[2001:db8::1]',
      'https://wordpress.local',
      'https://localhost:8443',
      'https://user:pass@example.ru',
      'ftp://example.ru',
    ])
      expect(browserAllowedHosts(site, [], []), site).toEqual([])
    // The bare host of `www.ru` would be a single label: only the site itself.
    expect(browserAllowedHosts('https://www.ru', [], [])).toEqual(['www.ru:443'])
    expect(() => browserAllowedHosts('not an address', [], [])).toThrow('Invalid site address')
  })

  it('throws on a listed host that is not a public name, or on too many', () => {
    for (const host of [
      '10.0.0.1',
      'localhost',
      'metadata.google.internal',
      '*.example.ru',
      'https://x.ru',
    ])
      expect(() => browserAllowedHosts('https://example.ru', [host], []), host).toThrow(
        'Invalid browser host',
      )
    expect(() => browserAllowedHosts('https://example.ru', [], ['169.254.169.254'])).toThrow(
      'Invalid browser host',
    )
    const many = Array.from({ length: 255 }, (_, index) => `h${index}.example.net`)
    expect(browserAllowedHosts('https://example.ru', [], many.slice(0, 254))).toHaveLength(256)
    expect(() => browserAllowedHosts('https://example.ru', [], many)).toThrow(
      'Too many browser hosts',
    )
  })
})

describe('browserLocalSiteOrigin', () => {
  it('takes an exact origin only', () => {
    expect(browserLocalSiteOrigin('http://wordpress.local:8080')).toBe(
      'http://wordpress.local:8080',
    )
    expect(browserLocalSiteOrigin('http://site')).toBe('http://site')
    for (const text of [
      'http://wordpress.local:8080/',
      'http://wordpress.local/wp-admin',
      'http://WordPress.local',
      'http://wordpress.local:80',
      'http://user@wordpress.local',
      'http://wordpress.local?x=1',
      'ftp://wordpress.local',
      'wordpress.local',
      '',
    ])
      expect(browserLocalSiteOrigin(text), text).toBeNull()
  })
})

describe('browserNavigationAllowed', () => {
  const allowed = browserAllowedHosts('https://news.example.ru', ['s.w.org'], [])
  const local = ['http://wordpress.local:8080']
  const may = (address: string, sites: readonly string[] = []) =>
    browserNavigationAllowed(address, allowed, sites)

  it('opens https pages of the allowed hosts', () => {
    for (const address of [
      'https://news.example.ru/',
      'https://news.example.ru/wp-admin/post-new.php',
      'https://NEWS.example.ru:443/wp-login.php?redirect_to=%2Fwp-admin%2F#top',
      'https://www.news.example.ru/',
      'https://s.w.org/images/core/emoji/15.0.3/svg/1f600.svg',
    ])
      expect(may(address), address).toBe(true)
  })

  it('opens the exact origin of a local site, and nothing else over http', () => {
    expect(may('http://wordpress.local:8080/wp-admin/', local)).toBe(true)
    expect(may('http://wordpress.local:8080/wp-admin/')).toBe(false)
    expect(may('http://wordpress.local/wp-admin/', local)).toBe(false)
    expect(may('http://wordpress.local:8081/', local)).toBe(false)
    expect(may('http://news.example.ru/', local)).toBe(false)
    // An entry that is not an exact origin opens nothing.
    expect(may('http://wordpress.local:8080/', ['http://wordpress.local:8080/'])).toBe(false)
  })

  it('refuses everything else', () => {
    for (const address of [
      'https://evil.example.com/',
      'https://news.example.ru.evil.com/',
      'https://news.example.ru:8443/',
      'https://user:secret@news.example.ru/',
      'https://news.example.ru@evil.example.com/',
      'https://203.0.113.10/',
      'https://[2001:db8::1]/',
      'https://169.254.169.254/latest/meta-data/',
      'https://news.example.ru./',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'about:blank',
      'chrome://settings',
      'blob:https://news.example.ru/1',
      'view-source:https://news.example.ru/',
      '/wp-admin/',
      'news.example.ru',
      'https://news.example.ru/\nhttps://evil.example.com',
      'https://news.example.ru/ wp-admin',
      `https://news.example.ru/${'a'.repeat(2048)}`,
      '',
    ])
      expect(may(address, local), address).toBe(false)
  })
})
