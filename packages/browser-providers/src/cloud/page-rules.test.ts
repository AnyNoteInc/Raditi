import type { BrowserTaskPolicy } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import {
  committedAllowed,
  openAllowed,
  requestVerdict,
  type PagePlace,
  type PageRules,
} from './page-rules.ts'

const policy: BrowserTaskPolicy = {
  startPath: '/wp-admin/',
  extraHosts: [],
  // The client at the controls may delete through the REST API; the agent may not (Б37).
  requestDenied: ({ path, method }, by = 'agent') =>
    path.startsWith('/wp-admin/users.php') ||
    (method === 'DELETE' && path.startsWith('/wp-json/') && by === 'agent'),
  pageDenied: (path, by = 'agent') =>
    path.startsWith('/wp-admin/plugins.php') || (path.includes('action=trash') && by === 'agent'),
}
const rules: PageRules = {
  allowedHosts: ['example.ru:443', 'www.example.ru:443', 's.w.org:443'],
  localSites: ['http://wordpress.local:8080'],
  policy,
}
const ask = (
  url: string,
  more: Partial<Parameters<typeof requestVerdict>[1]> = {},
  place?: PagePlace,
) =>
  requestVerdict(
    rules,
    { url, method: 'GET', postData: null, navigation: false, ...more },
    'agent',
    place,
  )

/** The main frame of a page of the site, and a page already on another site. */
const ON_THE_SITE: PagePlace = { main: true, document: 'https://example.ru/wp-admin/post.php' }
const ELSEWHERE: PagePlace = { main: true, document: 'https://pay.elsewhere.example/checkout' }

describe('the requests of a task browser', () => {
  it('go to the hosts of the session only: https, or exactly a local site', () => {
    expect(ask('https://example.ru/wp-admin/post-new.php')).toBe('continue')
    expect(ask('https://s.w.org/images/core/emoji/15/svg/1f600.svg')).toBe('continue')
    expect(ask('http://wordpress.local:8080/wp-admin/')).toBe('continue')
    for (const away of [
      // A page of the site loads nothing of another site: no picture, script or call.
      'https://pay.elsewhere.example/beacon',
      'http://elsewhere.example/beacon',
      'https://shop.example.ru/',
      'https://localhost/',
      'https://vault.raditi.internal/',
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

  it('are judged for whoever holds the browser: the agent unless told otherwise (Б37)', () => {
    const post = 'https://example.ru/wp-json/wp/v2/posts/7'
    const override = { method: 'POST', headers: { 'X-HTTP-Method-Override': 'DELETE' } }
    expect(ask(post, override)).toBe('accessdenied')
    expect(
      requestVerdict(rules, { url: post, postData: null, navigation: false, ...override }, 'user'),
    ).toBe('continue')
    const trash = 'https://example.ru/wp-admin/post.php?post=7&action=trash'
    expect(ask(trash, { navigation: true })).toBe('accessdenied')
    expect(
      requestVerdict(
        rules,
        { url: trash, method: 'GET', postData: null, navigation: true },
        'user',
      ),
    ).toBe('continue')
    expect(committedAllowed(rules, trash)).toBe(false)
    expect(committedAllowed(rules, trash, 'user')).toBe(true)
    expect(openAllowed(rules, trash)).toBe(false)
    expect(openAllowed(rules, trash, 'user')).toBe(true)
    // What is closed to both stays closed to the client.
    expect(openAllowed(rules, 'https://example.ru/wp-admin/plugins.php', 'user')).toBe(false)
  })

  it('reach another site only by the page going there, or from a page already there (Ч1)', () => {
    const pay = 'https://pay.elsewhere.example/checkout'
    // The main frame of a page of the site goes there: a redirect, a link, a form, a new tab.
    expect(ask(pay, { navigation: true }, ON_THE_SITE)).toBe('continue')
    // A frame inside a page of the site, a request of its page or of no frame (a worker's) does not.
    expect(ask(pay, { navigation: true }, { ...ON_THE_SITE, main: false })).toBe('blockedbyclient')
    expect(ask(pay, {}, ON_THE_SITE)).toBe('blockedbyclient')
    expect(ask(pay, { navigation: true }, { main: false, document: null })).toBe('blockedbyclient')
    // The page of another site loads what it needs, frames of a third site included.
    expect(ask('https://cdn.other.example/app.js', {}, ELSEWHERE)).toBe('continue')
    expect(
      ask('https://3ds.bank.example/', { navigation: true }, { ...ELSEWHERE, main: false }),
    ).toBe('continue')
    // While the saved sign-in is typed, nothing leaves for another site (Ч7).
    const signingIn = { ...ON_THE_SITE, siteOnly: true }
    expect(ask(pay, { navigation: true, method: 'POST' }, signingIn)).toBe('blockedbyclient')
    // Plain http, an address, a host of the site's domain: never another site.
    for (const away of [
      'http://pay.elsewhere.example/',
      'https://93.184.216.34/',
      'https://shop.example.ru/',
    ])
      expect(ask(away, { navigation: true }, ELSEWHERE), away).toBe('blockedbyclient')
  })

  it('of another site are not the policy’s to judge, and write nothing to the site (Ч5, Ч6)', () => {
    for (const path of ['/wp-admin/users.php', '/wp-admin/plugins.php'])
      expect(
        ask(`https://pay.elsewhere.example${path}`, { navigation: true }, ELSEWHERE),
        path,
      ).toBe('continue')
    expect(
      ask('https://pay.elsewhere.example/wp-json/wp/v2/posts/7', { method: 'DELETE' }, ELSEWHERE),
    ).toBe('continue')
    // To the site, a page of another site reads — judged by the policy as ever — and writes
    // nothing: a save from there is no save the task counts.
    expect(ask('https://example.ru/wp-admin/edit.php', { navigation: true }, ELSEWHERE)).toBe(
      'continue',
    )
    expect(ask('https://example.ru/wp-admin/users.php', {}, ELSEWHERE)).toBe('accessdenied')
    for (const write of [
      { method: 'POST', navigation: true },
      { method: 'PUT' },
      { method: 'GET', headers: { 'X-HTTP-Method-Override': 'POST' } },
    ])
      expect(
        ask('https://example.ru/wp-admin/post.php', write, ELSEWHERE),
        JSON.stringify(write),
      ).toBe('accessdenied')
    // The same write from a page of the site is the site's own.
    expect(ask('https://example.ru/wp-admin/post.php', { method: 'POST' }, ON_THE_SITE)).toBe(
      'continue',
    )
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
  })

  it('stays when another public https site served it where it may be reached (Ч1, Ч5)', () => {
    const page = (address: string, place: PagePlace) =>
      committedAllowed(rules, address, 'agent', place)
    for (const away of [
      'https://pay.elsewhere.example/checkout',
      'https://oauth.elsewhere.example:8443/wp-admin/plugins.php',
    ])
      expect(page(away, { main: true, document: away }), away).toBe(true)
    // A frame inside a page of the site keeps none; one inside a page of another site does.
    const pay = 'https://pay.elsewhere.example/checkout'
    expect(page(pay, { ...ON_THE_SITE, main: false })).toBe(false)
    expect(committedAllowed(rules, pay)).toBe(false)
    expect(page('https://3ds.bank.example/', { ...ELSEWHERE, main: false })).toBe(true)
    expect(page(pay, { main: true, document: pay, siteOnly: true })).toBe(false)
    for (const away of [
      'http://elsewhere.example/',
      'https://elsewhere.example:444/',
      'https://93.184.216.34/',
      'https://www.example.ru:8443/wp-admin/plugins.php',
      'https://shop.example.ru/',
      'https://wordpress.local/',
    ])
      expect(page(away, { main: true, document: away }), away).toBe(false)
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
    // Another site is reached from a page of the site, never by its address (Ч2).
    expect(openAllowed(rules, 'https://elsewhere.example/')).toBe(false)
    expect(openAllowed(rules, `https://example.ru/?q=${'a'.repeat(2048)}`)).toBe(false)
    expect(openAllowed(rules, 'https://example.ru/\nwp-admin/')).toBe(false)
  })
})
