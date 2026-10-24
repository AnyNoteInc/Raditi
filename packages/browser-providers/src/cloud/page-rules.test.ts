import type { BrowserTaskPolicy } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { committedAllowed, openAllowed, requestVerdict, type PageRules } from './page-rules.ts'

const policy: BrowserTaskPolicy = {
  startPath: '/wp-admin/',
  extraHosts: [],
  requestDenied: ({ path, method }) =>
    path.startsWith('/wp-admin/users.php') || (method === 'DELETE' && path.startsWith('/wp-json/')),
  pageDenied: (path) => path.startsWith('/wp-admin/plugins.php'),
}
const rules: PageRules = {
  allowedHosts: ['example.ru:443', 'www.example.ru:443', 's.w.org:443'],
  localSites: ['http://wordpress.local:8080'],
  policy,
}
const ask = (url: string, more: Partial<Parameters<typeof requestVerdict>[1]> = {}) =>
  requestVerdict(rules, { url, method: 'GET', postData: null, navigation: false, ...more })

describe('the requests of a task browser', () => {
  it('go to the hosts of the session only: https, or exactly a local site', () => {
    expect(ask('https://example.ru/wp-admin/post-new.php')).toBe('continue')
    expect(ask('https://s.w.org/images/core/emoji/15/svg/1f600.svg')).toBe('continue')
    expect(ask('http://wordpress.local:8080/wp-admin/')).toBe('continue')
    for (const away of [
      'https://elsewhere.example/beacon',
      'http://example.ru/wp-admin/',
      'https://example.ru:8443/',
      'https://user:secret@example.ru/',
      'https://93.184.216.34/',
      'http://wordpress.local:8081/',
      'http://127.0.0.1:8080/',
      'ftp://example.ru/',
      'not an address',
    ])
      expect(ask(away), away).toBe('blockedbyclient')
  })

  it('are judged by their origin: a long address of the admin is no reason to refuse', () => {
    const load = `https://example.ru/wp-admin/load-scripts.php?c=0&load%5Bchunk_0%5D=${'jquery-core,'.repeat(400)}`
    expect(load.length).toBeGreaterThan(2048)
    expect(ask(load)).toBe('continue')
  })

  it('never send what the stack denies; a page the policy closes is no navigation', () => {
    expect(ask('https://example.ru/wp-admin/users.php')).toBe('accessdenied')
    expect(ask('https://example.ru/wp-json/wp/v2/posts/7', { method: 'DELETE' })).toBe(
      'accessdenied',
    )
    expect(ask('https://example.ru/wp-admin/plugins.php')).toBe('continue')
    expect(ask('https://example.ru/wp-admin/plugins.php', { navigation: true })).toBe(
      'accessdenied',
    )
  })

  it('are judged by the method a header asks the server to run them as', () => {
    const post = 'https://example.ru/wp-json/wp/v2/posts/7'
    expect(ask(post, { method: 'POST' })).toBe('continue')
    for (const name of ['X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override'])
      expect(ask(post, { method: 'POST', headers: { [name]: 'delete' } }), name).toBe(
        'accessdenied',
      )
    expect(ask(post, { method: 'POST', headers: { 'x-http-method-override': 'PUT' } })).toBe(
      'continue',
    )
    expect(ask(post, { method: 'POST', headers: { 'content-type': 'DELETE' } })).toBe('continue')
  })

  it('are denied when the policy cannot read them', () => {
    const broken: PageRules = {
      ...rules,
      policy: {
        ...policy,
        requestDenied: () => {
          throw new Error('unreadable')
        },
      },
    }
    expect(
      requestVerdict(broken, {
        url: 'https://example.ru/',
        method: 'GET',
        postData: null,
        navigation: false,
      }),
    ).toBe('accessdenied')
  })
})

describe('what a frame committed', () => {
  it('stays when a host of the session served it and the policy lets the page be', () => {
    expect(committedAllowed(rules, 'https://example.ru/wp-admin/post.php?post=12')).toBe(true)
    expect(committedAllowed(rules, 'https://example.ru/wp-admin/plugins.php')).toBe(false)
    expect(committedAllowed(rules, 'https://elsewhere.example/')).toBe(false)
  })

  it('stays when no site served it: an empty page, Chromium’s error page, a document of its own', () => {
    for (const local of ['about:blank', 'about:srcdoc', 'chrome-error://chromewebdata/'])
      expect(committedAllowed(rules, local), local).toBe(true)
    for (const other of ['file:///etc/passwd', 'chrome://settings/', 'javascript:alert(1)'])
      expect(committedAllowed(rules, other), other).toBe(false)
  })
})

describe('an address the agent or the client opens', () => {
  it('is a whole address of the session the policy does not close', () => {
    expect(openAllowed(rules, 'https://example.ru/wp-admin/post-new.php')).toBe(true)
    expect(openAllowed(rules, 'https://example.ru/wp-admin/plugins.php')).toBe(false)
    expect(openAllowed(rules, 'https://elsewhere.example/')).toBe(false)
    expect(openAllowed(rules, `https://example.ru/?q=${'a'.repeat(2048)}`)).toBe(false)
    expect(openAllowed(rules, 'https://example.ru/\nwp-admin/')).toBe(false)
  })
})
