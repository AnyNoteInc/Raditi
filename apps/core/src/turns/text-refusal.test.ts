import { describe, expect, it } from 'vitest'

import { textRefusal } from './text-refusal.ts'

describe('the check of text of documents at the end of a turn (plan 69, Ст19)', () => {
  const key = `sk-rdt-${'k'.repeat(43)}`
  const value = 'synthetic-client-value-0001'
  const refuses = textRefusal(['', key], [value, 'short'])

  it('finds a key of the turn and a value of the client', () => {
    expect(refuses(`ключ ${key}`)).toBe('turn_key')
    expect(refuses(`значение ${value}`)).toBe('client_value')
  })

  it('finds a value as a JSON string and as the shell quotes it', () => {
    expect(refuses(JSON.stringify({ v: value }))).toBe('client_value')
    expect(textRefusal([], ["it's-a-long-value"])(String.raw`x it\'s-a-long-value`)).toBe(
      'client_value',
    )
  })

  it('refuses nothing for an empty key, a value too short to mask, and plain text', () => {
    expect(refuses('Обычный текст раздела')).toBeNull()
    expect(refuses('short')).toBeNull()
  })
})
