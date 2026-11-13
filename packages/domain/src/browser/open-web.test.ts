import { describe, expect, it } from 'vitest'

import { browserForeignPageAllowed } from './hosts.ts'
import {
  browserAddressOpens,
  browserPageHost,
  browserPlatformHost,
  OPEN_WEB_OBJECTS,
  OPEN_WEB_POLICY,
} from './open-web.ts'
import { browserSessionLimits } from './session.ts'

const PLATFORM = ['raditi.ru', 'raditi-preview.ru']
const openWeb = {
  openWeb: true,
  allowedHosts: [],
  localSites: [],
  platformHosts: PLATFORM,
  pageDomain: null,
}
const site = {
  openWeb: false,
  allowedHosts: ['news.example.ru:443', 'www.news.example.ru:443'],
  localSites: ['http://wordpress.local:8080'],
  platformHosts: PLATFORM,
  pageDomain: null,
}

describe('browserAddressOpens without a site', () => {
  it('opens any public https site by its address', () => {
    for (const address of [
      'https://example.com/',
      'https://www.example.com/a/b?q=1#x',
      'https://Example.COM/',
      'https://example.com:8443/',
      'https://пример.рф/',
      'https://example.com/путь',
    ])
      expect(browserAddressOpens(address, openWeb), address).toBe(true)
  })

  it('refuses plain http, addresses, other ports, local names and credentials', () => {
    for (const address of [
      'http://example.com/',
      'https://93.184.216.34/',
      'https://[2606:2800:220:1:248:1893:25c8:1946]/',
      'https://0x5db8d822/',
      'https://2130706433/',
      'https://example.com:8080/',
      'https://example.com:444/',
      'https://localhost/',
      'https://app.localhost/',
      'https://host.docker.internal/',
      'https://vault.raditi.internal/',
      'https://intranet/',
      'https://user:secret@example.com/',
      'https://user@example.com/',
      'https://example.com./',
      'ftp://example.com/',
      'file:///etc/passwd',
      'data:text/html,x',
      'javascript:alert(1)',
      'about:blank',
      'chrome://settings',
      'example.com',
      '',
    ])
      expect(browserAddressOpens(address, openWeb), address).toBe(false)
  })

  it('refuses white space, control characters and an address longer than the session carries', () => {
    for (const address of [
      ' https://example.com/',
      'https://example.com/ ',
      'https://exa\nmple.com/',
      'https://example.com/\t',
      'https://example.com/a b',
      'https://example.com/\u0000',
      'https://example.com/\u0085',
    ])
      expect(browserAddressOpens(address, openWeb), JSON.stringify(address)).toBe(false)
    const base = 'https://example.com/'
    const longest = `${base}${'a'.repeat(browserSessionLimits.urlChars - base.length)}`
    expect(browserAddressOpens(longest, openWeb)).toBe(true)
    expect(browserAddressOpens(`${longest}a`, openWeb)).toBe(false)
  })

  it('never opens a name of the platform, nor anything under it', () => {
    for (const address of [
      'https://raditi.ru/',
      'https://RADITI.ru/chats',
      'https://app.raditi.ru/',
      'https://www.raditi.ru/',
      'https://git.raditi.ru:8443/',
      'https://site-a-chat-b.raditi-preview.ru/',
      'https://xn--e1afmkfd.raditi.ru/',
    ])
      expect(browserAddressOpens(address, openWeb), address).toBe(false)
    // A name that only ends the same way is another site.
    expect(browserAddressOpens('https://notraditi.ru/', openWeb)).toBe(true)
    expect(browserAddressOpens('https://raditi.ru.example.com/', openWeb)).toBe(true)
  })

  it('opens a local site of a stand by its exact origin', () => {
    const stand = { ...openWeb, localSites: ['http://wp.raditi.test'] }
    expect(browserAddressOpens('http://wp.raditi.test/wp-admin/', stand)).toBe(true)
    expect(browserAddressOpens('http://wp.raditi.test:8080/', stand)).toBe(false)
    expect(browserAddressOpens('http://other.raditi.test/', stand)).toBe(false)
  })
})

describe('browserAddressOpens with a site', () => {
  it('opens the pages of the site only, as before', () => {
    expect(browserAddressOpens('https://news.example.ru/wp-admin/', site)).toBe(true)
    expect(browserAddressOpens('https://www.news.example.ru/', site)).toBe(true)
    expect(browserAddressOpens('http://wordpress.local:8080/', site)).toBe(true)
    // Another site is reached from a page of the site, never by address (plan 60, Ч2).
    expect(browserAddressOpens('https://example.com/', site)).toBe(false)
    expect(browserForeignPageAllowed('https://example.com/', site.allowedHosts, [])).toBe(true)
  })

  it('closes a name of the platform even when the session lists it', () => {
    const listed = { ...site, allowedHosts: ['raditi.ru:443', 'app.raditi.ru:443'] }
    expect(browserAddressOpens('https://raditi.ru/', listed)).toBe(false)
    expect(browserAddressOpens('https://app.raditi.ru/', listed)).toBe(false)
  })
})

describe('browserPlatformHost', () => {
  it('reads a name in any case, with or without the root’s dot', () => {
    expect(browserPlatformHost('RADITI.RU', PLATFORM)).toBe(true)
    expect(browserPlatformHost('raditi.ru.', PLATFORM)).toBe(true)
    expect(browserPlatformHost('a.b.raditi-preview.ru', PLATFORM)).toBe(true)
    expect(browserPlatformHost('raditi.ru', [])).toBe(false)
    expect(browserPlatformHost('xraditi.ru', PLATFORM)).toBe(false)
  })
})

describe('a chat without a site', () => {
  it('has a policy that closes nothing and starts nowhere of its own', () => {
    expect(OPEN_WEB_POLICY.extraHosts).toEqual([])
    expect(OPEN_WEB_POLICY.pageDenied('/wp-admin/users.php')).toBe(false)
    expect(OPEN_WEB_POLICY.requestDenied({ path: '/', method: 'DELETE', postData: null })).toBe(
      false,
    )
    expect(OPEN_WEB_POLICY.signIn).toBeUndefined()
  })

  it('has no object of the task', () => {
    expect(OPEN_WEB_OBJECTS.browserCheckpointOf('https://example.com/post/12')).toBeNull()
    expect(OPEN_WEB_OBJECTS.browserCommitAction('button', 'Опубликовать')).toBeNull()
    expect(() =>
      OPEN_WEB_OBJECTS.browserVerification({ kind: 'post', objectId: '1', editUrl: 'x' }),
    ).toThrow()
  })
})

describe('a published page of the agent (plan 69, Ст26)', () => {
  const PAGE = 'https://abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/'
  const pages = 'pages.raditi.ru'

  it('is one base32 label of 26 letters right under the domain of the pages', () => {
    expect(browserPageHost('abcdefghijklmnopqrstuvwxyz.pages.raditi.ru', pages)).toBe(true)
    expect(browserPageHost('ABCDEFGHIJKLMNOPQRSTUVWXYZ.Pages.Raditi.Ru', pages)).toBe(true)
    expect(browserPageHost('abcdefghijklmnopqrstuvwxyz.pages.raditi.ru.', pages)).toBe(false)
    for (const host of [
      'pages.raditi.ru',
      'raditi.ru',
      'x.abcdefghijklmnopqrstuvwxyz.pages.raditi.ru',
      'abcdefghijklmnopqrstuvwxy.pages.raditi.ru',
      'abcdefghijklmnopqrstuvwxy1.pages.raditi.ru',
      'abcdefghijklmnopqrstuvwxyz.pages.raditi.ru.evil.ru',
      'abcdefghijklmnopqrstuvwxyz.raditi-preview.ru',
    ])
      expect(browserPageHost(host, pages), host).toBe(false)
    expect(browserPageHost('abcdefghijklmnopqrstuvwxyz.pages.raditi.ru', null)).toBe(false)
  })

  it('opens by its address in either session, though raditi.ru is the platform’s', () => {
    for (const reach of [openWeb, site]) {
      expect(browserAddressOpens(PAGE, { ...reach, pageDomain: pages })).toBe(true)
      expect(browserAddressOpens(`${PAGE}a?b`, { ...reach, pageDomain: pages })).toBe(true)
      // Without the domain of the pages, it is the platform's like the rest.
      expect(browserAddressOpens(PAGE, reach)).toBe(false)
      for (const closed of [
        'https://pages.raditi.ru/',
        'https://pages.raditi.ru/v/token',
        'https://raditi.ru/chats',
        'http://abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/',
        'https://abcdefghijklmnopqrstuvwxyz.pages.raditi.ru:8443/',
        'https://user@abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/',
        'https://x.abcdefghijklmnopqrstuvwxyz.pages.raditi.ru/',
      ])
        expect(browserAddressOpens(closed, { ...reach, pageDomain: pages }), closed).toBe(false)
    }
  })

  it('is still a name of the platform by its host alone: only its whole address opens', () => {
    expect(browserPlatformHost('abcdefghijklmnopqrstuvwxyz.pages.raditi.ru', PLATFORM)).toBe(true)
    expect(browserPlatformHost('pages.raditi.ru', PLATFORM)).toBe(true)
  })
})
