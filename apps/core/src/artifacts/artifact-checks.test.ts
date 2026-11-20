import { describe, expect, it } from 'vitest'

import { artifactTextRefusal, artifactWriteTexts } from './artifact-checks.ts'

const VALUE = 'synthetic-client-value-0001'
const refuses = (text: string) => (text.includes(VALUE) ? ('client_value' as const) : null)

describe('the texts of an agent’s write in an artifact (88.4)', () => {
  it('reads the content, the strings of a JSON one, the text properties and the intent', () => {
    expect(
      artifactWriteTexts({
        pendingContent: '{"price":"250","note":"\\u0073ecret"}',
        pendingProps: { heading: 'Цены', size: 3, open: true },
        leaseIntent: 'Обновлю цены',
      }),
    ).toEqual([
      '{"price":"250","note":"\\u0073ecret"}',
      'price',
      '250',
      'note',
      'secret',
      'Цены',
      'Обновлю цены',
    ])
    expect(
      artifactWriteTexts({ pendingContent: null, pendingProps: null, leaseIntent: null }),
    ).toEqual([])
  })

  it('refuses a value of the client however a cell spells it', () => {
    const escaped = JSON.stringify({ a: VALUE }).replace('s', '\\u0073')
    expect(escaped.includes(VALUE)).toBe(false)
    expect(
      artifactTextRefusal(
        refuses,
        artifactWriteTexts({ pendingContent: escaped, pendingProps: null, leaseIntent: null }),
      ),
    ).toBe('client_value')
  })

  it('refuses a value in the intent or a heading, and a password form sent elsewhere', () => {
    expect(artifactTextRefusal(refuses, ['Текст', `Намерение ${VALUE}`])).toBe('client_value')
    expect(
      artifactTextRefusal(refuses, [
        '<form action="https://elsewhere.example/x"><input type="password" name="p"></form>',
      ]),
    ).toBe('password_form')
    expect(artifactTextRefusal(refuses, ['Капучино — 250 ₽'])).toBeNull()
    expect(artifactTextRefusal(refuses, [])).toBeNull()
  })

  it('does not refuse a long block for its size: the limits of a block hold it', () => {
    expect(artifactTextRefusal(refuses, ['ё'.repeat(40_000)])).toBeNull()
  })
})
