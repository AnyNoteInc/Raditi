import { describe, expect, it } from 'vitest'

import { recoveredTextRefusal, textRefusal } from './text-refusal.ts'

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

describe('the check of a turn whose end recovery reached (plan 84, §10)', () => {
  const value = 'synthetic-client-value-0001'
  const refuses = recoveredTextRefusal([value])

  it('refuses any text in the form of a turn key, of the gateway or of MCP, and a value', () => {
    expect(refuses(`ключ sk-rdt-${'Z'.repeat(43)}`)).toBe('turn_key')
    expect(refuses(`токен mcp_${'a'.repeat(64)}`)).toBe('turn_key')
    expect(refuses(`значение ${value}`)).toBe('client_value')
  })

  it('refuses nothing else', () => {
    expect(refuses('Цены — только из прайса')).toBeNull()
    expect(refuses('sk-rdt-short mcp_123')).toBeNull()
  })
})
