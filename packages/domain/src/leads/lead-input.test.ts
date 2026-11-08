import { describe, expect, it } from 'vitest'

import {
  leadFieldErrors,
  leadFieldIssues,
  leadInputSchema,
  normalizeLeadPhone,
  normalizeLeadSite,
} from './lead-input.ts'

const valid = {
  name: ' Анна ',
  phone: '8 (900) 000-00-00',
  email: 'Anna@Example.ru',
  site: 'https://www.Kofeinya.ru/menu',
  about: 'Обновлять цены в меню и новости',
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
      name: 'Анна',
      phone: '+79000000000',
      email: 'anna@example.ru',
      site: 'www.kofeinya.ru',
      about: 'Обновлять цены в меню и новости',
      consent: true,
    })
  })

  it('names every invalid field with the words of the form', () => {
    const result = leadInputSchema.safeParse({
      name: '',
      phone: '1',
      email: 'nope',
      site: 'nope',
      about: 'коротко',
      consent: false,
    })
    expect(result.success).toBe(false)
    expect(leadFieldIssues(result.error!)).toEqual(leadFieldErrors)
  })

  it('keeps the trap field for the server to judge', () => {
    expect(leadInputSchema.parse({ ...valid, check: 'Bots Ltd' }).check).toBe('Bots Ltd')
  })

  it('counts the description in characters, as the database does', () => {
    expect(leadInputSchema.safeParse({ ...valid, about: '🙂'.repeat(9) }).success).toBe(false)
    expect(leadInputSchema.safeParse({ ...valid, about: '🙂'.repeat(10) }).success).toBe(true)
    expect(leadInputSchema.safeParse({ ...valid, about: '🙂'.repeat(2000) }).success).toBe(true)
  })
})
