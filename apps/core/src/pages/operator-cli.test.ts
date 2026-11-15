import { describe, expect, it } from 'vitest'

import { addressOf, parsePagesArguments, runPagesCommand } from './operator-cli.ts'

// The operator's commands of pages (docs/plan/73-pages-sites.md, Дер18): an address of a complaint.

const slug = 'a'.repeat(26)

describe('pages:take-down and pages:return', () => {
  it('reads a site by its host and a page by its path', () => {
    expect(addressOf(`https://${slug}.pages.raditi.ru/`)).toEqual({ slug, path: '/' })
    expect(addressOf(`https://${slug}.pages.raditi.ru`)).toEqual({ slug, path: '/' })
    expect(addressOf('https://moya-firma.pages.raditi.ru/ceny')).toEqual({
      slug: 'moya-firma',
      path: '/ceny',
    })
    expect(addressOf(`https://${slug.toUpperCase()}.pages.raditi.ru/uslugi/remont/`)).toEqual({
      slug,
      path: '/uslugi/remont',
    })
  })

  it('refuses an address that is no page', () => {
    for (const address of [
      'pages.raditi.ru',
      `ftp://${slug}.pages.raditi.ru/`,
      `https://user:x@${slug}.pages.raditi.ru/`,
      'https://ab.pages.raditi.ru/',
      `https://${slug}.pages.raditi.ru/../x`,
      `https://${slug}.pages.raditi.ru/index.html`,
    ])
      expect(() => addressOf(address), address).toThrow()
  })

  it('takes the address, a reason and an operator, nothing else', () => {
    expect(
      parsePagesArguments(['--', `https://${slug}.pages.raditi.ru/`, '--reason', 'Жалоба №1']),
    ).toEqual({
      help: false,
      value: { address: `https://${slug}.pages.raditi.ru/`, reason: 'Жалоба №1' },
    })
    expect(parsePagesArguments(['--help'])).toEqual({ help: true })
    for (const args of [
      [],
      [`https://${slug}.pages.raditi.ru/`],
      [`https://${slug}.pages.raditi.ru/`, '--reason'],
      [`https://${slug}.pages.raditi.ru/`, '--reason', 'x', '--force', 'y'],
      ['a', 'b', '--reason', 'x'],
    ])
      expect(() => parsePagesArguments(args), JSON.stringify(args)).toThrow()
  })

  it('says what is wrong in fixed words, before it connects anywhere', async () => {
    await expect(
      runPagesCommand('take-down', [`https://${slug}.pages.raditi.ru/`, '--reason', 'x'], {}),
    ).rejects.toThrow('Задайте APP_ENV')
    await expect(
      runPagesCommand('take-down', ['https://example.com/', '--reason', 'x'], {
        APP_ENV: 'test',
      }),
    ).rejects.toThrow('Адрес страницы не распознан')
  })
})
