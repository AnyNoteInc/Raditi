import { randomUUID } from 'node:crypto'

import { conflict, type KvSecret } from '@repo/domain'
import { createVaultSecretStore } from '@repo/vault'
import { describe, expect, it, vi } from 'vitest'

import { contentMaskPath, ContentPrivacy } from './content-privacy.ts'

const scope = { siteId: randomUUID(), taskId: randomUUID() }
function fixture() {
  const records = new Map<string, KvSecret>()
  const secrets = {
    kvRead: vi.fn(async (path: string) => records.get(path) ?? null),
    kvWrite: vi.fn(
      async (path: string, data: Record<string, string>, options?: { cas?: number }) => {
        const version = records.get(path)?.version ?? 0
        if (options?.cas !== version) throw conflict('Synthetic CAS mismatch')
        records.set(path, { data: { ...data }, version: version + 1 })
        return { version: version + 1 }
      },
    ),
  }
  return { records, secrets, privacy: new ContentPrivacy(secrets) }
}

/** The real KV adapter over an in-memory KV v2: its own size and CAS rules stay in force. */
function vaultFixture() {
  const stored = new Map<string, { data: Record<string, string>; version: number }>()
  const sent = { largestBytes: 0 }
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname
    const current = stored.get(path)
    if (init?.method === 'POST') {
      sent.largestBytes = Math.max(sent.largestBytes, Buffer.byteLength(String(init.body)))
      const body = JSON.parse(String(init.body)) as {
        data: Record<string, string>
        options?: { cas?: number }
      }
      if (body.options?.cas !== (current?.version ?? 0)) return new Response(null, { status: 400 })
      const version = (current?.version ?? 0) + 1
      stored.set(path, { data: body.data, version })
      return Response.json({ data: { version } })
    }
    if (!current) return new Response(null, { status: 404 })
    const metadata = { version: current.version, deletion_time: '', destroyed: false }
    return Response.json({ data: { data: current.data, metadata } })
  })
  const secrets = createVaultSecretStore({
    addr: 'http://vault.test:8200',
    token: 'synthetic-token',
    fetch,
  })
  const requests = (method: string) =>
    fetch.mock.calls.filter(([, init]) => init?.method === method).length
  return { stored, sent, requests, privacy: new ContentPrivacy(secrets) }
}

const fields = (content: string) => ({ title: '', content, excerpt: '' })
const short = (text: string) => text.replace(/\[\[raditi:(email|phone):[a-f0-9-]{36}\]\]/g, '<$1>')
/** What the agent sees, markers shortened. Every case also proves the exact bytes come back. */
async function seen(content: string) {
  const { privacy, secrets } = fixture()
  const masked = await privacy.mask(scope, fields(content))
  expect((await privacy.rehydrate(scope, masked)).content).toBe(content)
  return { text: short(masked.content), writes: secrets.kvWrite.mock.calls.length }
}

const NBSP = ' '
const NARROW = ' '
const THIN = ' '

describe('where the map of a task lives', () => {
  it('has its own prefix, outside the access secrets of the site', async () => {
    // kv/sites/<siteId>/ is what web writes and a deploy token reads (spec §15).
    expect(contentMaskPath(scope)).toBe(`kv/content-masks/${scope.siteId}/${scope.taskId}`)
    const { privacy, records, secrets } = fixture()
    const masked = await privacy.mask(scope, fields('contact@example.test'))
    expect([...records.keys()]).toEqual([`kv/content-masks/${scope.siteId}/${scope.taskId}`])
    await privacy.rehydrate(scope, masked)
    for (const [path] of [...secrets.kvRead.mock.calls, ...secrets.kvWrite.mock.calls])
      expect(path).toBe(contentMaskPath(scope))
  })

  it.each([
    { siteId: 'sites', taskId: randomUUID() },
    { siteId: randomUUID(), taskId: '../sites' },
    { siteId: `${randomUUID()}/wp`, taskId: randomUUID() },
  ])('is never built from anything but two identifiers: %j', async (foreign) => {
    expect(() => contentMaskPath(foreign)).toThrow('Invalid content privacy scope')
    const { privacy, secrets } = fixture()
    await expect(privacy.mask(foreign, fields('contact@example.test'))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(secrets.kvRead).not.toHaveBeenCalled()
  })
})

describe('published content privacy', () => {
  it('masks ordinary and encoded emails and phones, preserving their original bytes on input', async () => {
    const { privacy, secrets } = fixture()
    const original = {
      title: 'Напишите test@example.test',
      content:
        '<a href="mailto:test@example.test">test&#64;example&#46;test</a> +7 (999) 123-45-67',
      excerpt: 'Звоните +7 (999) 123-45-67',
    }
    const masked = await privacy.mask(scope, original)
    expect(JSON.stringify(masked)).not.toMatch(/test@example|test&#64;|123-45-67/)
    expect(masked.content).toMatch(/\[\[raditi:email:[a-f0-9-]{36}\]\]/)
    expect(masked.content).toMatch(/\[\[raditi:phone:[a-f0-9-]{36}\]\]/)
    expect(await privacy.rehydrate(scope, masked)).toEqual(original)
    expect(await privacy.mask(scope, original)).toEqual(masked)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  })

  it('persists a map before returning markers and reuses it after process replacement', async () => {
    const { privacy, secrets } = fixture()
    const original = fields('contact@example.test')
    const masked = await privacy.mask(scope, original)
    expect(await new ContentPrivacy(secrets).rehydrate(scope, masked)).toEqual(original)
  })

  it('does not expose an unacknowledged marker or replay a write no other writer explains', async () => {
    const { privacy, secrets } = fixture()
    secrets.kvWrite.mockRejectedValue(new Error('private Vault detail'))
    await expect(privacy.mask(scope, fields('contact@example.test'))).rejects.toMatchObject({
      code: 'CONTENT_PRIVACY_UNAVAILABLE',
    })
    // The map did not move, so this was not a lost CAS race: a second attempt cannot differ.
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  })

  it('adopts its own write after a lost acknowledgement', async () => {
    const { privacy, secrets } = fixture()
    const write = secrets.kvWrite.getMockImplementation()!
    secrets.kvWrite.mockImplementationOnce(async (...args) => {
      await write(...args)
      throw new Error('lost acknowledgement')
    })
    const original = fields('contact@example.test +7 (999) 123-45-67')
    const masked = await privacy.mask(scope, original)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
    expect(await privacy.rehydrate(scope, masked)).toEqual(original)
  })

  it('reconciles simultaneous masks with CAS instead of losing a contact', async () => {
    const { privacy } = fixture()
    const values = await Promise.all(
      ['a@example.test', 'b@example.test'].map((content) => privacy.mask(scope, fields(content))),
    )
    expect((await privacy.rehydrate(scope, values[0]!)).content).toBe('a@example.test')
    expect((await privacy.rehydrate(scope, values[1]!)).content).toBe('b@example.test')
  })

  it('refuses unknown, malformed and foreign-task markers', async () => {
    const { privacy } = fixture()
    const masked = await privacy.mask(scope, fields('a@example.test'))
    await expect(
      privacy.rehydrate({ ...scope, taskId: randomUUID() }, masked),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      privacy.rehydrate(scope, { content: '[[raditi:phone:broken]]' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      privacy.rehydrate(scope, { content: `[[raditi:email:${randomUUID()}]]` }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('refuses reserved source markers and a page with more contacts than a map holds', async () => {
    const { privacy, secrets } = fixture()
    await expect(
      privacy.mask(scope, { title: '[[raditi:forged]]', content: '', excerpt: '' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      privacy.mask(
        scope,
        fields(Array.from({ length: 513 }, (_, index) => `c${index}@example.test`).join(' ')),
      ),
    ).rejects.toMatchObject({ code: 'CONTENT_PRIVACY_LIMIT', httpStatus: 413 })
    expect(secrets.kvWrite).not.toHaveBeenCalled()
  })
})

const phoneCases: Array<[string, string]> = [
  // Russian numbers with a country or trunk prefix
  ['+7 (999) 123-45-67', '<phone>'],
  ['+7 999 123 45 67', '<phone>'],
  ['+79991234567', '<phone>'],
  ['+7(999)1234567', '<phone>'],
  ['+7-999-123-45-67', '<phone>'],
  ['8 (999) 123-45-67', '<phone>'],
  ['8 999 123 45 67', '<phone>'],
  ['8-999-123-45-67', '<phone>'],
  ['89991234567', '<phone>'],
  ['8(999)123-45-67', '<phone>'],
  ['8 800 555-35-35', '<phone>'],
  ['8 800 555-3-555', '<phone>'],
  ['88005553535', '<phone>'],
  ['8 9991234567', '<phone>'],
  ['7 999 123 45 67', '<phone>'],
  ['Звоните: 79991234567', 'Звоните: <phone>'],
  ['+7 (4852) 12-34-56', '<phone>'],
  ['8 (48535) 2-12-34', '<phone>'],
  ['8 (800) 2000-600', '<phone>'],
  ['80291234567', '<phone>'],
  ['8.800.555.35.35', '<phone>'],
  ['+7.999.123.45.67', '<phone>'],
  ['8 (999) 123.45.67', '<phone>'],
  ['(8 495) 123-45-67', '<phone>'],
  ['(+7 999 123-45-67)', '(<phone>)'],
  ['+7 999 123 45678', '<phone>'],
  // Without a prefix
  ['(495) 123-45-67', '<phone>'],
  ['(4852) 12-34-56', '<phone>'],
  ['495 123-45-67', '<phone>'],
  ['999 123 45 67', '<phone>'],
  ['999 123 4567', '<phone>'],
  ['4852 12 34 56', '<phone>'],
  ['812 123-4567', '<phone>'],
  ['212-555-1234', '<phone>'],
  ['123-45-67', '<phone>'],
  ['Приёмная: 255 35 35', 'Приёмная: <phone>'],
  // The subscriber part is hidden even where the code stands apart
  ['375 29 123 45 67', '375 29 <phone>'],
  ['29-123-45-67', '29-<phone>'],
  ['+7 <span>(999)</span> 123-45-67', '+7 <span>(999)</span> <phone>'],
  ['<b>+7 999</b> 123 45 67', '<b>+7 999</b> <phone>'],
  // Spaces and dashes that are not ASCII
  [`+7${NBSP}999${NBSP}123${NBSP}45${NBSP}67`, '<phone>'],
  [`8${NARROW}999${NARROW}123${NARROW}45${NARROW}67`, '<phone>'],
  [`+7${THIN}(999)${THIN}123-45-67`, '<phone>'],
  ['+7 (999) 123–45–67', '<phone>'],
  ['8 999 123—45—67', '<phone>'],
  ['8‑999‑123‑45‑67', '<phone>'],
  ['+7 999 123−45−67', '<phone>'],
  ['+7 (999) 123 - 45 - 67', '<phone>'],
  ['+7 (999) 123 – 45 – 67', '<phone>'],
  // HTML entities and percent escapes
  ['+7&nbsp;999&nbsp;123&nbsp;45&nbsp;67', '<phone>'],
  ['+7&#160;(999)&#160;123-45-67', '<phone>'],
  ['8&#xA0;999&#xa0;123&#XA0;45&#xA0;67', '<phone>'],
  ['8&#8239;999&#8239;123&#8239;45&#8239;67', '<phone>'],
  ['+7 (999) 123&ndash;45&ndash;67', '<phone>'],
  ['+7 (999) 123&#8211;45&#8211;67', '<phone>'],
  ['8 999 123&mdash;45&mdash;67', '<phone>'],
  ['&#43;7 (999) 123-45-67', '<phone>'],
  ['&plus;7 999 123 45 67', '<phone>'],
  ['8 &#40;999&#41; 123-45-67', '<phone>'],
  ['+7&thinsp;999&thinsp;123&#x2011;45&#x2011;67', '<phone>'],
  // Tabs and invisible characters, such as those put in against automatic phone links
  ['8\t999\t123\t45\t67', '<phone>'],
  ['+7&#8203;999&#8203;1234567', '<phone>'],
  ['+7​999​123​45​67', '<phone>'],
  ['8⁠999⁠123﻿45﻿67', '<phone>'],
  ['8&shy;999&shy;123&shy;45&shy;67', '<phone>'],
  ['8­999­1234567', '<phone>'],
  ['<a href="tel:%2B79991234567">звонок</a>', '<a href="tel:<phone>">звонок</a>'],
  ['<a href="tel:+7%20999%20123%2045%2067">', '<a href="tel:<phone>">'],
  ['viber://chat?number=%2B79991234567', 'viber://chat?number=<phone>'],
  ['https://wa.me/79991234567', 'https://wa.me/<phone>'],
  ['https://wa.me/375291234567', 'https://wa.me/<phone>'],
  [
    'https://api.whatsapp.com/send?phone=79991234567&text=1',
    'https://api.whatsapp.com/send?phone=<phone>&text=1',
  ],
  ['<a href="tel:+79991234567">8 800 555-35-35</a>', '<a href="tel:<phone>"><phone></a>'],
  // Glued to a letter
  ['т89991234567', 'т<phone>'],
  ['тел.:8(999)1234567, т89991234567', 'тел.:<phone>, т<phone>'],
  // Other countries
  ['+375 29 123-45-67', '<phone>'],
  ['+380 (67) 123-45-67', '<phone>'],
  ['+1 (555) 123-4567', '<phone>'],
  ['+44 20 7946 0958', '<phone>'],
  ['+998 90 123 45 67', '<phone>'],
  ['+86 138 0013 8000', '<phone>'],
  ['+49 30 12345678', '<phone>'],
  ['+90 (312) 123 45 67', '<phone>'],
  ['+375 29 123.45.67', '<phone>'],
  ['+375.29.123.45.67', '<phone>'],
  // A neighbour made of digits: each number on its own, the rest untouched
  ['Телефоны: 8 999 123 45 67 8 495 765 43 21', 'Телефоны: <phone> <phone>'],
  ['8 (999) 123-45-67 8 (495) 765-43-21', '<phone> <phone>'],
  ['Отзыв Ивана: 8 999 123-45-67 01.10.2026', 'Отзыв Ивана: <phone> 01.10.2026'],
  ['Звоните +7 999 123-45-67 10.00-19.00', 'Звоните <phone> 10.00-19.00'],
  ['+7 (999) 123-45-67 - 1 500 руб.', '<phone> - 1 500 руб.'],
  ['+375 29 123-45-67 01.10.2026', '<phone> 01.10.2026'],
  ['+375 29 123-45-67 8 029 765-43-21', '<phone> <phone>'],
  ['+7 999 123-45-67, +7 999 765-43-21', '<phone>, <phone>'],
  ['+44 20 7946 0958 +44 20 7946 0959', '<phone> <phone>'],
  ['+7 999 123-45-67 2026', '<phone> 2026'],
  ['8 (495) 123-45-67 доб. 123', '<phone> доб. 123'],
  ['8 (495) 123-45-67 (123) 456', '<phone> (123) 456'],
  ['255 35 35 01.10.2026', '<phone> 01.10.2026'],
  ['8 999 123-45-67, 01.10.2026', '<phone>, 01.10.2026'],
  ['8 999 123-45-67,8 999 765-43-21', '<phone>,<phone>'],
  ['+375 29 123-45-67,8 029 765-43-21', '<phone>,<phone>'],
  ['8 999 123 45 67\n8 999 765 43 21', '<phone>\n<phone>'],
  ['8 (495) 123-45-67, 765-43-21', '<phone>, <phone>'],
  // A neighbour that shares the head of a number goes under the same marker, never the tail alone
  ['№ 87765 386 664 69 26', '№ <phone>'],
  [`Заказ № 73650 899${NBSP}009${NBSP}72${NBSP}67`, 'Заказ № <phone>'],
  ['№ 78945 — 434 124 57 13', '№ <phone>'],
  ['+44 47 9757 4526 — 451 493 93 94', '<phone> <phone>'],
  ['+44 76 2648 4324 - 804 842 88 85', '<phone> <phone>'],
  // ...but not a price after it
  ['+7 955 424 7043 - 213 000 руб.', '<phone> - 213 000 руб.'],
  ['8 836 3119-766 286 000 руб.', '<phone> 286 000 руб.'],
  // Short or bare numbers are phones only where the text says so
  ['тел. 2-12-34', 'тел. <phone>'],
  ['Телефон: 1234567', 'Телефон: <phone>'],
  ['<b>Тел.:</b> 2553535', '<b>Тел.:</b> <phone>'],
  ['<a href="tel:1234567">', '<a href="tel:<phone>">'],
  ['Факс: 12-34-56', 'Факс: <phone>'],
  ['Телефоны: 2-12-34, 2-15-67', 'Телефоны: <phone>, <phone>'],
  ['{"phone":"9991234567"}', '{"phone":"<phone>"}'],
  ['WhatsApp: 9991234567', 'WhatsApp: <phone>'],
  ['<td>Телефон</td><td>55-33-11</td>', '<td>Телефон</td><td><phone></td>'],
  ['тел. 123.45.67', 'тел. <phone>'],
  ['тел. 2-12-34 10:00-18:00', 'тел. <phone> 10:00-18:00'],
  ['Звоните 25-35-35', 'Звоните <phone>'],
  ['Позвоните: 2-12-34', 'Позвоните: <phone>'],
  ['т. 25-35-35', 'т. <phone>'],
  ['т/ф 25-35-35', 'т/ф <phone>'],
  ['тлф: 2-12-34', 'тлф: <phone>'],
  ['<!-- wp:button {"url":"tel:+79991234567"} -->', '<!-- wp:button {"url":"tel:<phone>"} -->'],
]

describe('phone numbers never pass through unmasked', () => {
  it.each(phoneCases)('%j', async (content, expected) => {
    expect((await seen(content)).text).toBe(expected)
  })
})

describe('numbers that are not phones stay readable and take no map entry', () => {
  it.each<string>([
    // Dates and hours
    'Акция до 31.12.2026',
    'с 01.10.2026 - 15.10.2026',
    '2026-10-01',
    '2026-10-01 12:30',
    'до 2026-10-01 12 мест',
    '01/10/2026',
    'Работаем 10.00-19.00',
    'Работаем 10:00–19:00',
    'Скидка 20% до 15.11',
    // Prices and amounts
    'Цена 1 500 000 ₽',
    '12 990 руб.',
    '1 234 567,89',
    '8 500 000 ₽',
    '7 900 000 000 ₽',
    '89 991 234 567 ₽',
    '2 500 000 000 ₽',
    '+1 500 000 ₽',
    'от 300 000 – 450 000 ₽',
    'от 4500 - 150 000 руб.',
    'Ремонт: 3500 – 120 000 ₽',
    'Тираж 120 000 экз., 2-е изд.',
    'Тираж 495 123 01.10.2026',
    '950 000 2021',
    'Toyota Camry 2021 950 000',
    '8 999 123.45 \u20bd',
    '8.500.000 \u20bd',
    '+10 000 000 \u20bd',
    'Цена телефона: 12 999 руб.',
    // Years
    'Работаем 2019-2026',
    '1998–2026 гг.',
    // Company details
    'ИНН 7707083893',
    'ИНН 770708389312',
    'ИНН/КПП 7707083893/770701001',
    'КПП 770701001',
    'ОГРН 1027700132195',
    'ОГРНИП 304770000012345',
    'БИК 044525225',
    'р/с 40702810900000012345',
    'ОКТМО 78701000001',
    '<td>ОКТМО</td><td>78701000001</td>',
    'СНИЛС 123-456-789 01',
    'ОКПО 00032537',
    'к/с 301 01 810 4 0000 0000225',
    'КБК 182 1 01 02010 01 1000 110',
    // Orders, articles and documents
    'Заказ № 1234567',
    'Заказ №20261001-15',
    '№ 2026-000123',
    'Артикул 100200300',
    '100-200-300',
    'ГОСТ 12345-67',
    'Лицензия № 77-01-001234',
    '№ 152-ФЗ от 27.07.2006',
    'ISBN 978-5-699-12014-7',
    // Markup and technical numbers
    '<!-- wp:image {"id":1234567} -->',
    '<img class="wp-image-1234567" src="/u/photo-20261001.jpg?ver=1696000000">',
    '<svg viewBox="0 0 800 600" width="1200" height="630">',
    'color: rgba(255, 255, 255, 0.5)',
    '192.168.45.67',
    '10.168.45.67',
    'https://ozon.ru/product/1234567890/',
    'pi = 3.14159265358979',
    '55.755826, 37.617300',
    'версия 10.15.7, сборка 1.2.3.4',
    '1696000000 и 1696000000000',
    '4276 3800 1234 5678',
    'Размеры: 8 10 12 14 16 18',
    '3500 200 150',
    '8 100 200 300 400',
    '7 14 21 28 35 42',
    '101000, Москва, ул. Ленина, д. 15-20',
    'Контакты: 101000, Москва',
    'Звонок 2 500 руб., т. е. 12 000 руб. за 5 т. 15000 руб.',
    'Звоните с 9:00 до 18:00, т. д. 12345',
    'Таблица:\t2026\t150\t000',
    // Not e-mail addresses
    '<img src="https://site.ru/wp-content/uploads/2026/10/logo@2x.png">',
    'npm i lodash@4.17.21',
    '@media (min-width: 768px) { .a { margin: 0 } }',
    'Пишите в Telegram @ivan_petrov',
    'user@localhost',
  ])('%j', async (content) => {
    expect(await seen(content)).toEqual({ text: content, writes: 0 })
  })

  it('reads a catalogue of prices and dates without filling the map', async () => {
    const { privacy, secrets } = fixture()
    for (let page = 0; page < 30; page++) {
      const content = Array.from(
        { length: 20 },
        (_, item) => `Товар ${page}-${item}: ${1_000_000 + page * 100 + item} руб. до 31.12.2026`,
      ).join('\n')
      expect((await privacy.mask(scope, fields(content))).content).toBe(content)
    }
    expect(secrets.kvWrite).not.toHaveBeenCalled()
  })
})

describe('e-mail addresses', () => {
  it.each<[string, string]>([
    ['ivan.petrov@mail.ru', '<email>'],
    ['IVAN@MAIL.RU', '<email>'],
    ['ivan+tag@sub.example.co.uk', '<email>'],
    ['почта@пример.рф', '<email>'],
    ['info@xn--e1afmkfd.xn--p1ai', '<email>'],
    ['Напишите ivan@mail.ru.', 'Напишите <email>.'],
    ['a@b.ru, c@d.ru', '<email>, <email>'],
    [
      '<a href="mailto:test@example.test">test&#64;example&#46;test</a>',
      '<a href="mailto:<email>"><email></a>',
    ],
    ['ivan&#x40;mail.ru', '<email>'],
    ['ivan&commat;mail&period;ru', '<email>'],
    ['&#105;van&#64;mail&#46;ru', '<email>'],
    ['<a href="mailto:ivan%40mail.ru">', '<a href="mailto:<email>">'],
    ['https://site.ru/?email=ivan@mail.ru&x=1', 'https://site.ru/?email=<email>&x=1'],
    ['avatar-ivan@mail.ru.png', '<email>.png'],
    // One contact, one marker: a number inside or glued to an address is not a second entry.
    ['89991234567@mail.ru', '<email>'],
    ['8 999 123 45 67ivan@mail.ru', '<email>'],
  ])('%j', async (content, expected) => {
    expect((await seen(content)).text).toBe(expected)
  })

  it('keeps a contact of the greatest length when every character of it is an entity', async () => {
    const entities = (text: string) =>
      [...text].map((char) => `&#x${char.charCodeAt(0).toString(16).padStart(6, '0')};`).join('')
    // A number glued to an address of 64 + 1 + 255 characters: one marker, 3 330 source characters.
    const contact = `8 999 123 45 67${'a'.repeat(62)}@${['b', 'c', 'd', 'e'].map((label) => label.repeat(63)).join('.')}`
    expect(contact).toHaveLength(13 + 320)
    expect(await seen(`<p>${entities(contact)}</p>`)).toEqual({ text: '<p><email></p>', writes: 1 })
  })

  const size = 2 * 1024 * 1024
  it.each<[string, string]>([
    ['local-part characters without an at sign', 'a'.repeat(size)],
    ['an inline base64 image', `<img src="data:image/png;base64,${'A/+9'.repeat(size / 4)}">`],
    ['at signs with nothing to find', 'a@'.repeat(size / 2)],
    ['dotted labels before one at sign', `${'a.'.repeat(size / 2)}@`],
    ['one digit after another', '1 '.repeat(size / 2)],
    ['a single run of digits', '9'.repeat(size)],
    ['unfinished entities', '&#'.repeat(size / 2)],
    ['percent signs', '%2'.repeat(size / 2)],
    ['unclosed tags before digits', '>1 '.repeat(size / 3)],
    ['brackets and signs', '+(8 '.repeat(size / 4)],
  ])(
    'scans a 2 MiB line in linear time: %s',
    async (_label, content) => {
      const { privacy } = fixture()
      const startedAt = performance.now()
      const masked = await privacy.mask(scope, fields(content))
      const elapsed = performance.now() - startedAt
      expect(masked.content === content).toBe(true)
      // The quadratic scan needed 1.7 s for 32 KiB, that is hours for this line.
      expect(elapsed).toBeLessThan(10_000)
    },
    60_000,
  )

  it('scans a 2 MiB line of numbers that share digits with their neighbours', async () => {
    const { privacy, secrets } = fixture()
    const unit = '№ 87765 386 664 69 26; 4526 — 451 493 93 94; '
    const content = unit.repeat(Math.ceil(size / unit.length))
    const startedAt = performance.now()
    const masked = await privacy.mask(scope, fields(content))
    expect(performance.now() - startedAt).toBeLessThan(10_000)
    expect(short(masked.content)).toBe('№ <phone>; <phone>; '.repeat(Math.ceil(size / unit.length)))
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  }, 60_000)
})

const anyMarker = /\[\[raditi:(?:email|phone):[a-f0-9-]{36}\]\]/g
const digitsOf = (text: string) => text.replace(/\D/g, '')
/** What a model would read: the text without its markers. */
const visible = (text: string) => text.replace(anyMarker, ' ')

describe('a contact the task already knows is masked wherever it stands', () => {
  it.each<[string, string]>([
    [
      '<p>Телефон: 25-35-35</p><p>Бухгалтерия — 25-35-35, доб. 2</p>',
      '<p>Телефон: <phone></p><p>Бухгалтерия — <phone>, доб. 2</p>',
    ],
    [
      '<p>Бухгалтерия — 25-35-35, доб. 2</p><p>Телефон: 25-35-35</p>',
      '<p>Бухгалтерия — <phone>, доб. 2</p><p>Телефон: <phone></p>',
    ],
    [
      '<p>Тел. 2-12-34</p><table><tr><td>Иванова А. П.</td><td>2-12-34</td></tr></table>',
      '<p>Тел. <phone></p><table><tr><td>Иванова А. П.</td><td><phone></td></tr></table>',
    ],
    ['<p>Моб.: 89991234567</p><p>ИНН 89991234567</p>', '<p>Моб.: <phone></p><p>ИНН <phone></p>'],
    // The same number in another spelling, where its shape alone is not a phone.
    ['<p>Телефон: 25-35-35</p><p>Склад 253535</p>', '<p>Телефон: <phone></p><p>Склад <phone></p>'],
    ['<p>8 (999) 123-45-67</p><p>ИНН 89991234567</p>', '<p><phone></p><p>ИНН <phone></p>'],
    [
      '<p>8 (999) 123-45-67</p><p>ИНН 8&nbsp;999&nbsp;123.45.67</p>',
      '<p><phone></p><p>ИНН <phone></p>',
    ],
    // +7, 8 and no prefix at all are one Russian number.
    ['<p>+7 (999) 123-45-67</p><p>ИНН 89991234567</p>', '<p><phone></p><p>ИНН <phone></p>'],
    ['<p>8 (495) 123-45-67</p><p>Код 4951234567</p>', '<p><phone></p><p>Код <phone></p>'],
    ['<p>(495) 123-45-67</p><p>ИНН 84951234567</p>', '<p><phone></p><p>ИНН <phone></p>'],
    ['<p>(495) 123-45-67</p><p>ИНН 74951234567</p>', '<p><phone></p><p>ИНН <phone></p>'],
  ])('on the same page: %j', async (content, expected) => {
    const { privacy, secrets } = fixture()
    const masked = await privacy.mask(scope, fields(content))
    expect(short(masked.content)).toBe(expected)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
    expect((await privacy.rehydrate(scope, masked)).content).toBe(content)
    // A second read of the same page is the same text and learns nothing new.
    expect(await privacy.mask(scope, fields(content))).toEqual(masked)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  })

  it('uses one marker for one spelling, in every field and on a later page', async () => {
    const { privacy, secrets } = fixture()
    const first = await privacy.mask(scope, {
      title: 'Бухгалтерия 25-35-35',
      content: '<p>Телефон: 25-35-35</p>',
      excerpt: '',
    })
    const [marker] = first.content.match(anyMarker)!
    expect(first.title).toBe(`Бухгалтерия ${marker}`)
    const later = await privacy.mask(
      scope,
      fields('<table><tr><td>Бухгалтерия</td><td>25-35-35</td></tr></table>'),
    )
    expect(later.content).toBe(`<table><tr><td>Бухгалтерия</td><td>${marker}</td></tr></table>`)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  })

  it('does not take the digits of a known short number out of a longer one', async () => {
    const { privacy, secrets } = fixture()
    await privacy.mask(scope, fields('тел. 2-12-34'))
    const catalogue = 'Артикул 9921234, код 212345, цена 121 234 ₽, 2021 234 шт.'
    expect((await privacy.mask(scope, fields(catalogue))).content).toBe(catalogue)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  })

  it('puts a known contact that overlaps a found one under a single marker', async () => {
    const { privacy } = fixture()
    await privacy.mask(scope, fields('Склад: 25-35-35'))
    // «8 495 225-35-35» is a number by its shape; the known one is its tail.
    const content = 'Офис 8 495 225-35-35'
    const masked = await privacy.mask(scope, fields(content))
    expect(short(masked.content)).toBe('Офис <phone>')
    expect((await privacy.rehydrate(scope, masked)).content).toBe(content)
  })
})

describe('a marker the agent moves never brings its contact back in plain text', () => {
  // Every spelling the detector hides with one marker, and the exact characters it hides.
  const hidden = phoneCases
    .filter(([, expected]) => expected.split('<phone>').length === 2)
    .map(([page, expected]) => {
      const [before, after] = expected.split('<phone>') as [string, string]
      return { page, phone: page.slice(before.length, page.length - after.length) }
    })
  const contexts: Array<[string, (marker: string) => string, boolean]> = [
    ['a table cell', (m) => `<table><tr><td>Бухгалтерия</td><td>${m}</td></tr></table>`, true],
    ['a list item', (m) => `<ul><li>Иван</li><li>${m}</li></ul>`, true],
    ['a sentence', (m) => `Звоните нам: ${m}, ежедневно`, true],
    ['a requisite word', (m) => `ИНН ${m}`, false],
    ['digits right after it', (m) => `${m}00000`, false],
    ['digits right before it', (m) => `00000${m}`, false],
    ['a decimal tail', (m) => `${m}.5`, false],
    ['a time tail', (m) => `${m}:00`, false],
    ['a dotted head', (m) => `1.${m}`, false],
    ['a percent sign', (m) => `%${m}`, false],
    ['a numeric entity', (m) => `&#${m};`, false],
    ['a file name', (m) => `photo-${m}.png`, false],
  ]

  it('covers every way to write a number', () => {
    expect(hidden.length).toBeGreaterThan(100)
    expect(hidden.map(({ phone }) => phone)).toEqual(
      expect.arrayContaining(['2-12-34', '25-35-35', '89991234567', '+7 (999) 123-45-67']),
    )
  })

  it.each(contexts)('a phone in %s', async (_label, wrap, allowed) => {
    for (const { page, phone } of hidden) {
      const { privacy } = fixture()
      const first = await privacy.mask(scope, fields(page))
      const [marker, ...others] = first.content.match(anyMarker)!
      expect(others, page).toEqual([])
      expect((await privacy.rehydrate(scope, { content: marker! })).content, page).toBe(phone)
      // wp_rest POST: the gateway puts the number back where the agent put the marker.
      const written = await privacy
        .rehydrate(scope, { excerpt: wrap(marker!) })
        .catch((error: { code?: string }) => {
          expect(error.code, page).toBe('CONTENT_PRIVACY_CONTEXT')
          return null
        })
      if (allowed) expect(written?.excerpt, page).toBe(wrap(phone))
      if (!written) continue
      // wp_rest GET of what the site now stores.
      const second = await privacy.mask(scope, { ...fields(page), excerpt: written.excerpt! })
      expect(visible(second.excerpt), page).not.toContain(phone)
      expect(digitsOf(visible(second.excerpt)), page).not.toContain(digitsOf(phone))
      expect((await privacy.rehydrate(scope, second)).excerpt, page).toBe(written.excerpt)
    }
  })

  it('returns the same marker when digits are written right after it', async () => {
    const { privacy, secrets } = fixture()
    const first = await privacy.mask(scope, fields('<p>Иван, 8 (999) 123-45-67</p>'))
    const [marker] = first.content.match(anyMarker)!
    const written = await privacy.rehydrate(scope, { excerpt: `${marker}00000` })
    expect(written.excerpt).toBe('8 (999) 123-45-6700000')
    const second = await privacy.mask(scope, { title: '', content: '', excerpt: written.excerpt! })
    expect(second.excerpt).toBe(`${marker}00000`)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  })

  it.each([
    'ivan.petrov@mail.ru',
    'test&#64;example&#46;test',
    'ivan%40mail.ru',
    'почта@пример.рф',
    '89991234567@mail.ru',
  ])('an address in every context: %s', async (address) => {
    for (const [, wrap] of [
      ...contexts,
      ['letters before', (m: string) => `x${m}`],
      ['letters after', (m: string) => `${m}x`],
      ['a domain tail', (m: string) => `${m}.png`],
    ] as const) {
      const { privacy } = fixture()
      const first = await privacy.mask(scope, fields(`<p>Иван, ${address}</p>`))
      expect(short(first.content)).toBe('<p>Иван, <email></p>')
      const [marker] = first.content.match(anyMarker)!
      const written = await privacy.rehydrate(scope, { excerpt: wrap(marker!) })
      expect(written.excerpt).toBe(wrap(address))
      const second = await privacy.mask(scope, { ...fields(''), excerpt: written.excerpt! })
      expect(visible(second.excerpt), wrap('M')).not.toContain(address)
      expect((await privacy.rehydrate(scope, second)).excerpt).toBe(written.excerpt)
    }
  })

  it('refuses a write whose contact the next read would leave in plain text', async () => {
    const { privacy, secrets } = fixture()
    const first = await privacy.mask(scope, fields('<p>Иван, 8 (999) 123-45-67</p>'))
    const [marker] = first.content.match(anyMarker)!
    // A detector that no longer hides this placement: the write must stop, not the next read.
    vi.resetModules()
    vi.doMock('./content-contacts.ts', () => ({ findContacts: () => [] }))
    try {
      const blind = await import('./content-privacy.ts')
      const refused = new blind.ContentPrivacy(secrets).rehydrate(scope, {
        excerpt: `ИНН ${marker}`,
      })
      await expect(refused).rejects.toMatchObject({
        code: 'CONTENT_PRIVACY_CONTEXT',
        httpStatus: 400,
      })
      await expect(refused).rejects.not.toThrow(/999|123-45-67/)
    } finally {
      vi.doUnmock('./content-contacts.ts')
      vi.resetModules()
    }
  })

  it('shows nothing of a page whose repeats never settle', async () => {
    const { secrets } = fixture()
    vi.resetModules()
    // Every pass finds one more value: there is no state in which all of them are hidden.
    vi.doMock('./content-contacts.ts', () => ({
      findContacts: (text: string, known: unknown[]) => [
        { kind: 'phone', start: 0, end: Math.min(text.length, known.length + 1) },
      ],
    }))
    try {
      const restless = await import('./content-privacy.ts')
      await expect(
        new restless.ContentPrivacy(secrets).mask(scope, fields('8'.repeat(64))),
      ).rejects.toMatchObject({ code: 'CONTENT_PRIVACY_LIMIT' })
      expect(secrets.kvWrite).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('./content-contacts.ts')
      vi.resetModules()
    }
  })

  it('masks a 32 KiB field against a full map in linear time', async () => {
    const { privacy, secrets } = fixture()
    const pair = (value: number) => String(value % 100).padStart(2, '0')
    const numbers = Array.from(
      { length: 350 },
      (_, index) => `8 (9${10 + (index % 80)}) ${100 + index}-${pair(index)}-${pair(index * 37)}`,
    )
    expect(new Set(numbers).size).toBe(350)
    await privacy.mask(scope, fields(numbers.join('<br>')))
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
    // Every known number again, each where its shape alone is not a phone.
    const row = (count: number) =>
      Array.from({ length: count }, (_, index) => `<td>ИНН ${numbers[index % 350]}0</td>`).join('')
    const timed = async (content: string) => {
      const startedAt = performance.now()
      const masked = await privacy.mask(scope, fields(content))
      const elapsed = performance.now() - startedAt
      for (const number of numbers.slice(0, 5))
        expect(visible(masked.content)).not.toContain(number)
      return elapsed
    }
    const field = row(1050)
    expect(field.length).toBeGreaterThan(30_000)
    expect(field.length).toBeLessThanOrEqual(32_768)
    expect(await timed(field)).toBeLessThan(2000)
    // Sixty-four times the text against the same map: a quadratic scan would need minutes.
    expect(await timed(row(1050 * 64))).toBeLessThan(20_000)
    expect(secrets.kvWrite).toHaveBeenCalledOnce()
  }, 60_000)
})

describe('the map inside the Vault KV limits', () => {
  const contacts = (from: number, count: number) =>
    fields(
      Array.from(
        { length: count },
        (_, index) => `user${String(from + index).padStart(4, '0')}@example.com`,
      ).join(' '),
    )

  it('reports a full map as a permanent limit instead of retrying a write Vault refuses', async () => {
    const { privacy, requests } = vaultFixture()
    const first = await privacy.mask(scope, contacts(0, 300))
    expect(requests('POST')).toBe(1)
    const reads = requests('GET')
    // 365 entries are 33 581 characters: more than one KV value takes.
    await expect(privacy.mask(scope, contacts(300, 65))).rejects.toMatchObject({
      code: 'CONTENT_PRIVACY_LIMIT',
      httpStatus: 413,
    })
    expect(requests('POST')).toBe(1)
    expect(requests('GET')).toBe(reads + 1)
    // The task keeps the contacts it already knows.
    expect(await privacy.mask(scope, contacts(0, 300))).toEqual(first)
    expect(await privacy.rehydrate(scope, first)).toEqual(contacts(0, 300))
  })

  it('fills one KV value to its limit and never sends a larger one', async () => {
    const { privacy, requests, stored } = vaultFixture()
    let known = 0
    for (;;) {
      const outcome = await privacy.mask(scope, contacts(known, 10)).then(
        () => 'stored',
        (error: { code?: string }) => error.code,
      )
      if (outcome !== 'stored') {
        expect(outcome).toBe('CONTENT_PRIVACY_LIMIT')
        break
      }
      known += 10
      expect(requests('POST')).toBe(known / 10)
    }
    const [map] = [...stored.values()]
    expect(Object.keys(map!.data)).toEqual(['entries'])
    expect(map!.data.entries!.length).toBeLessThanOrEqual(32_768)
    expect(map!.data.entries!.length).toBeGreaterThan(32_768 - 10 * 100)
    expect(known).toBeGreaterThanOrEqual(350)
    expect(await privacy.rehydrate(scope, await privacy.mask(scope, contacts(0, known)))).toEqual(
      contacts(0, known),
    )
  })

  it('counts the request in bytes when addresses are not ASCII', async () => {
    const { privacy, requests, sent, stored } = vaultFixture()
    // 128 characters and 372 bytes each: the 64 KiB request fills before the 32 768 characters.
    const wide = (from: number, count: number) =>
      fields(
        Array.from(
          { length: count },
          (_, index) =>
            `${'字'.repeat(60)}${String(from + index).padStart(4, '0')}@${'例'.repeat(60)}.网址`,
        ).join(' '),
      )
    let known = 0
    for (;;) {
      const outcome = await privacy.mask(scope, wide(known, 5)).then(
        () => 'stored',
        (error: { code?: string }) => error.code,
      )
      if (outcome !== 'stored') {
        expect(outcome).toBe('CONTENT_PRIVACY_LIMIT')
        break
      }
      known += 5
      expect(requests('POST')).toBe(known / 5)
    }
    expect(known).toBeGreaterThanOrEqual(140)
    expect([...stored.values()][0]!.data.entries!.length).toBeLessThan(32_768 - 2000)
    expect(sent.largestBytes).toBeLessThanOrEqual(64 * 1024)
    expect(sent.largestBytes).toBeGreaterThan(64 * 1024 - 5 * 500)
    expect(await privacy.rehydrate(scope, await privacy.mask(scope, wide(0, known)))).toEqual(
      wide(0, known),
    )
  })
})
