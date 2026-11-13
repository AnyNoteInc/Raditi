import { describe, expect, it } from 'vitest'

import {
  leadFieldErrors,
  leadFieldIssues,
  leadInputSchema,
  normalizeLeadContact,
  normalizeLeadPhone,
  normalizeLeadSite,
} from './lead-input.ts'

const valid = {
  site: 'https://www.Kofeinya.ru/menu',
  phone: '8 (900) 000-00-00',
  consent: true,
}

describe('normalizeLeadPhone', () => {
  it.each([
    ['+7 900 000-00-00', '+79000000000'],
    ['8 (900) 000-00-00', '+79000000000'],
    ['9000000000', '+79000000000'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('reads %s', (input, phone) => {
    expect(normalizeLeadPhone(input)).toBe(phone)
  })

  it.each(['', '12345', 'call me', '+7 900 000-00-00 доб. 5', '+1234567890123456'])(
    'refuses %j',
    (input) => {
      expect(normalizeLeadPhone(input)).toBeNull()
    },
  )
})

describe('normalizeLeadContact', () => {
  it.each([
    ['8 (900) 000-00-00', '+79000000000'],
    ['+44 20 7946 0958', '+442079460958'],
    ['@Anna_Kofe', '@anna_kofe'],
    [' @anna1 ', '@anna1'],
    ['t.me/Anna_Kofe', '@anna_kofe'],
    ['https://t.me/anna_kofe/', '@anna_kofe'],
    ['http://T.me/anna_kofe', '@anna_kofe'],
    ['telegram.me/anna_kofe', '@anna_kofe'],
    ['HTTPS://Telegram.me/Anna_Kofe/', '@anna_kofe'],
    [`@a${'b'.repeat(31)}`, `@a${'b'.repeat(31)}`],
  ])('reads %s', (input, contact) => {
    expect(normalizeLeadContact(input)).toBe(contact)
  })

  it.each([
    '',
    'anna_kofe',
    'Анна',
    '@anna',
    `@a${'b'.repeat(32)}`,
    '@1anna',
    '@_anna',
    '@anna-kofe',
    '@анна_кофе',
    '@anna kofe',
    '@@anna_kofe',
    '@anna_kofe/',
    't.me/',
    't.me/anna',
    't.me/@anna_kofe',
    't.me/anna_kofe/5',
    'https://t.me/+AbCdEfGhIjK',
    'ftp://t.me/anna_kofe',
    'example.me/anna_kofe',
    'xt.me/anna_kofe',
    'anna@example.ru',
    '12345',
  ])('refuses %j', (input) => {
    expect(normalizeLeadContact(input)).toBeNull()
  })

  it('writes only what the column of the lead accepts', () => {
    const column = /^(\+[0-9]{10,15}|@[a-z][a-z0-9_]{4,31})$/
    for (const input of ['9000000000', '+1 234 567 890 123 45', '@Anna_Kofe', 't.me/A2345']) {
      expect(normalizeLeadContact(input)).toMatch(column)
    }
  })
})

describe('normalizeLeadSite', () => {
  it.each([
    ['kofeinya.ru', 'kofeinya.ru'],
    ['https://www.Kofeinya.ru/menu?x=1', 'www.kofeinya.ru'],
    ['http://кофейня.рф:8080/', 'кофейня.рф'],
    ['shop.example.com.', 'shop.example.com'],
  ])('reads %s', (input, host) => {
    expect(normalizeLeadSite(input)).toBe(host)
  })

  it.each(['', 'localhost', 'my site.ru', 'user@site.ru', '10.0.0.1', '-bad.ru', 'ftp://site.ru'])(
    'refuses %j',
    (input) => {
      expect(normalizeLeadSite(input)).toBeNull()
    },
  )
})

describe('leadInputSchema', () => {
  it('normalizes a valid lead', () => {
    expect(leadInputSchema.parse(valid)).toEqual({
      site: 'www.kofeinya.ru',
      phone: '+79000000000',
      consent: true,
    })
  })

  it('takes a Telegram username as the contact', () => {
    expect(leadInputSchema.parse({ ...valid, phone: 'https://t.me/Anna_Kofe' }).phone).toBe(
      '@anna_kofe',
    )
  })

  it('names every invalid field with the words of the form', () => {
    const result = leadInputSchema.safeParse({ site: 'nope', phone: 'anna', consent: false })
    expect(result.success).toBe(false)
    expect(leadFieldIssues(result.error!)).toEqual(leadFieldErrors)
    expect(leadFieldErrors.phone).toBe('Нужен номер телефона или ник в Telegram')
  })

  it('asks for both fields', () => {
    const result = leadInputSchema.safeParse({ consent: true })
    expect(result.success).toBe(false)
    expect(Object.keys(leadFieldIssues(result.error!)).sort()).toEqual(['phone', 'site'])
  })

  it('drops the fields the form no longer has', () => {
    const parsed = leadInputSchema.parse({ ...valid, name: 'Анна', email: 'a@b.ru', about: 'x' })
    expect(Object.keys(parsed).sort()).toEqual(['consent', 'phone', 'site'])
  })

  it('keeps the trap field for the server to judge', () => {
    expect(leadInputSchema.parse({ ...valid, check: 'Bots Ltd' }).check).toBe('Bots Ltd')
  })
})
