import { describe, expect, it } from 'vitest'

import {
  isSecretParameterName,
  redactBrowserAddress,
  redactLinkAddress,
  redactResultAddresses,
  redactTreeAddresses,
} from './addresses.ts'
import { BROWSER_HIDDEN_VALUE } from './observation.ts'
import { browserSessionLimits } from './session.ts'
import { browserToolResultSchema, type BrowserToolResult } from './tools.ts'

const SITE = 'https://news.example.ru'
const H = BROWSER_HIDDEN_VALUE

describe('isSecretParameterName', () => {
  it('names a secret by a word of it, in any case and inside a longer name', () => {
    for (const name of [
      'key',
      'rp_key',
      'API_KEY',
      'apikey',
      'token',
      'access_token',
      'AccessToken',
      'nonce',
      '_wpnonce',
      'preview_nonce',
      'meta-box-loader-nonce',
      'pass',
      'pass1',
      'user_pass',
      'password',
      'pwd',
      'secret',
      'client_secret',
      'code',
      'hash',
      'auth',
      'reauth',
      'authorization',
      'sig',
      'signature',
      'X-Amz-Signature',
      'reset',
      'session',
      'session_id',
      'PHPSESSID',
      'otp',
      'jwt',
      'ticket',
      'credential',
      '%5Fwpnonce',
      'access%5Ftoken',
    ])
      expect(isSecretParameterName(name), name).toBe(true)
  })

  it('leaves the parameters a page is found by', () => {
    for (const name of [
      'post',
      'p',
      'page',
      'page_id',
      'paged',
      'action',
      'action2',
      'post_type',
      'post_status',
      'taxonomy',
      'tag_ID',
      'cat',
      's',
      'orderby',
      'order',
      'mode',
      'ids',
      'trashed',
      'message',
      'updated',
      'author',
      'author_name',
      'keyword',
      'keywords',
      'preset',
      'login',
      'redirect_to',
      '_wp_http_referer',
      'classic-editor',
      'customize_changeset_uuid',
    ])
      expect(isSecretParameterName(name), name).toBe(false)
  })
})

describe('redactBrowserAddress', () => {
  it('hides the key of a password reset and keeps the rest', () => {
    expect(redactBrowserAddress(`${SITE}/wp-login.php?action=rp&key=AbC123xyz&login=admin`)).toBe(
      `${SITE}/wp-login.php?action=rp&key=${H}&login=admin`,
    )
  })

  it('hides a nonce of an admin page and keeps where the page is', () => {
    expect(
      redactBrowserAddress(`${SITE}/wp-admin/post.php?post=12&action=edit&_wpnonce=0a1b2c3d4e`),
    ).toBe(`${SITE}/wp-admin/post.php?post=12&action=edit&_wpnonce=${H}`)
    expect(redactBrowserAddress('/wp-admin/post.php?post=1&%5Fwpnonce=abc')).toBe(
      `/wp-admin/post.php?post=1&%5Fwpnonce=${H}`,
    )
  })

  it('leaves an address without a secret as it is', () => {
    for (const address of [
      `${SITE}/wp-admin/edit.php?post_type=post&paged=3&taxonomy=category&action=-1&s=%D0%BD%D0%BE%D0%B2%D0%BE%D1%81%D1%82%D1%8C&author=1&orderby=date`,
      `${SITE}/wp-admin/admin.php?page=wpcf7`,
      `${SITE}/wp-admin/post.php?post=12&action=edit&classic-editor`,
      `${SITE}/wp-admin/post-new.php`,
      `${SITE}/?p=12`,
      `${SITE}/news/`,
      `${SITE}/wp-admin/?key=`,
      `${SITE}/page#`,
      'about:blank',
      '',
    ])
      expect(redactBrowserAddress(address), address).toBe(address)
  })

  it('hides every secret parameter, whatever the case or the word inside the name', () => {
    const query = [
      'API_KEY=a1',
      'AccessToken=b2',
      'PHPSESSID=c3',
      'user_pass=d4',
      'pwd=e5',
      'client_secret=f6',
      'code=g7',
      'hash=h8',
      'auth=i9',
      'sig=j0',
      'X-Amz-Signature=k1',
      'reset=l2',
      'session_id=m3',
      'preview_nonce=n4',
      'rp_key=o5',
    ]
    const redacted = redactBrowserAddress(`${SITE}/cb?post=7&${query.join('&')}`)
    expect(redacted).toBe(
      `${SITE}/cb?post=7&${query.map((pair) => `${pair.split('=')[0]}=${H}`).join('&')}`,
    )
  })

  it('hides the fragment whole: a token of a sign-in, the screen of a record', () => {
    expect(redactBrowserAddress(`${SITE}/callback#access_token=abc&state=x`)).toBe(
      `${SITE}/callback#${H}`,
    )
    expect(
      redactBrowserAddress(`${SITE}/wp-admin/admin.php?page=fluentcrm-admin#/subscribers/12`),
    ).toBe(`${SITE}/wp-admin/admin.php?page=fluentcrm-admin#${H}`)
  })

  it('hides a value that is itself an address with a secret, escaped once or twice', () => {
    expect(
      redactBrowserAddress(
        `${SITE}/wp-login.php?redirect_to=${encodeURIComponent(`${SITE}/wp-admin/?_wpnonce=abc`)}&interim-login=1`,
      ),
    ).toBe(`${SITE}/wp-login.php?redirect_to=${H}&interim-login=1`)
    const twice = encodeURIComponent(encodeURIComponent('/a?token=x'))
    expect(redactBrowserAddress(`${SITE}/go?to=${twice}`)).toBe(`${SITE}/go?to=${H}`)
    const harmless = `${SITE}/wp-login.php?redirect_to=${encodeURIComponent(`${SITE}/wp-admin/edit.php?post_type=post`)}`
    expect(redactBrowserAddress(harmless)).toBe(harmless)
  })

  it('keeps the path, even one that looks like a token', () => {
    expect(redactBrowserAddress(`${SITE}/reset/key=abc/`)).toBe(`${SITE}/reset/key=abc/`)
  })

  it('changes nothing when applied again', () => {
    for (const address of [
      `${SITE}/wp-login.php?action=rp&key=AbC123xyz&login=admin#top`,
      `${SITE}/go?to=${encodeURIComponent('/a?token=x')}`,
      `${SITE}/?${'key=a&'.repeat(400)}`,
    ]) {
      const once = redactBrowserAddress(address)
      expect(redactBrowserAddress(once)).toBe(once)
    }
  })

  it('never stretches an address past the bound of a tab: the query then goes whole', () => {
    const base = `${SITE}/wp-admin/admin.php?`
    const address = `${base}${'key=a&'.repeat((browserSessionLimits.urlChars - base.length) / 6)}`
      .slice(0, browserSessionLimits.urlChars)
      .replace(/&?[^&]*$/, '')
    expect(address.length).toBeLessThanOrEqual(browserSessionLimits.urlChars)
    const redacted = redactBrowserAddress(address)
    expect(redacted).toBe(`${SITE}/wp-admin/admin.php?${H}`)
    expect(redacted.length).toBeLessThanOrEqual(browserSessionLimits.urlChars)
  })
})

describe('redactLinkAddress', () => {
  it('hides the secret parameters of a link and keeps its anchor', () => {
    expect(redactLinkAddress('/wp-admin/post.php?post=1&action=trash&_wpnonce=abc#top')).toBe(
      `/wp-admin/post.php?post=1&action=trash&_wpnonce=${H}#top`,
    )
    expect(redactLinkAddress(`${SITE}/cb#access_token=abc&state=x`)).toBe(
      `${SITE}/cb#access_token=${H}&state=x`,
    )
    for (const link of [`${SITE}/about#contacts`, '#comments', '/lost', 'mailto:hi'])
      expect(redactLinkAddress(link), link).toBe(link)
  })
})

describe('redactTreeAddresses', () => {
  const tree = [
    '- generic [ref=e1]:',
    '  - link "Сбросить пароль" [ref=e2] [cursor=pointer]:',
    `    - /url: ${SITE}/wp-login.php?action=rp&key=AbC123&login=admin`,
    '  - link "В корзину" [ref=e3]:',
    '    - /url: post.php?post=12&action=trash&_wpnonce=0a1b2c',
    '  - link "Вход" [ref=e4]:',
    '    - /url: "#access_token=abc"',
    '  - link "Контакты" [ref=e5]:',
    `    - /url: ${SITE}/about#contacts`,
    '  - paragraph [ref=e6]: ссылка ?key=abc остаётся текстом',
    '  - text: "/url: ?token=abc"',
  ].join('\n')

  it('hides the secret parameters of links only, in their quoting', () => {
    expect(redactTreeAddresses(tree).split('\n')).toEqual([
      '- generic [ref=e1]:',
      '  - link "Сбросить пароль" [ref=e2] [cursor=pointer]:',
      `    - /url: ${SITE}/wp-login.php?action=rp&key=${H}&login=admin`,
      '  - link "В корзину" [ref=e3]:',
      `    - /url: post.php?post=12&action=trash&_wpnonce=${H}`,
      '  - link "Вход" [ref=e4]:',
      `    - /url: "#access_token=${H}"`,
      '  - link "Контакты" [ref=e5]:',
      `    - /url: ${SITE}/about#contacts`,
      '  - paragraph [ref=e6]: ссылка ?key=abc остаётся текстом',
      '  - text: "/url: ?token=abc"',
    ])
    expect(redactTreeAddresses(redactTreeAddresses(tree))).toBe(redactTreeAddresses(tree))
  })
})

describe('redactResultAddresses', () => {
  const page = {
    pageId: 1,
    url: `${SITE}/wp-admin/post.php?post=12&action=edit&_wpnonce=abc`,
    title: 'key=title',
  }

  it('redacts the page, the tabs and the links of an observation, on a copy', () => {
    const result: BrowserToolResult = {
      tool: 'web_observe',
      observation: 'o2',
      page,
      tabs: [page, { pageId: 2, url: `${SITE}/cb#access_token=x`, title: 'Вход' }],
      controller: 'agent',
      tree: '- link "x" [ref=e1]:\n  - /url: /a?token=abc',
      truncated: false,
    }
    const before = structuredClone(result)
    const redacted = redactResultAddresses(result)
    expect(result).toEqual(before)
    expect(redacted).toEqual({
      ...result,
      page: { ...page, url: `${SITE}/wp-admin/post.php?post=12&action=edit&_wpnonce=${H}` },
      tabs: [
        { ...page, url: `${SITE}/wp-admin/post.php?post=12&action=edit&_wpnonce=${H}` },
        { pageId: 2, url: `${SITE}/cb#${H}`, title: 'Вход' },
      ],
      tree: `- link "x" [ref=e1]:\n  - /url: /a?token=${H}`,
    })
    expect(browserToolResultSchema.parse(redacted)).toEqual(redacted)
  })

  it('redacts the addresses of the objects of a check and of a closed tab', () => {
    const result: BrowserToolResult = {
      tool: 'web_verify',
      matched: true,
      objects: [
        {
          kind: 'post',
          objectId: '12',
          state: 'verified',
          object: {
            kind: 'post',
            objectId: '12',
            title: 'Открытие',
            status: 'draft',
            url: `${SITE}/?p=12&preview=true&preview_nonce=abc`,
            editUrl: `${SITE}/wp-admin/post.php?post=12&action=edit`,
            images: 1,
            files: 0,
            featuredImage: false,
          },
        },
      ],
    }
    const redacted = redactResultAddresses(result)
    expect(redacted.tool === 'web_verify' && redacted.objects[0]?.object).toMatchObject({
      url: `${SITE}/?p=12&preview=true&preview_nonce=${H}`,
      editUrl: `${SITE}/wp-admin/post.php?post=12&action=edit`,
    })
    expect(browserToolResultSchema.parse(redacted)).toEqual(redacted)
    const closed: BrowserToolResult = { tool: 'web_tab', page: null, tabs: [] }
    expect(redactResultAddresses(closed)).toEqual(closed)
  })
})
