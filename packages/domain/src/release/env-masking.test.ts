import { describe, expect, it } from 'vitest'

import { isDomainError } from '../errors.ts'
import {
  containsEnvValue,
  egressHostsOf,
  ENV_VALUE_MASK,
  envValueBytes,
  envValueForms,
  envValueInChange,
  envValueInContent,
  isEnvValueRefusal,
  maskEnvValues,
  maskEnvValuesDeep,
} from './env-masking.ts'

describe('the values of client variables in kept text', () => {
  it('replaces every occurrence of every value', () => {
    expect(
      maskEnvValues('key sk-live-0001 and sk-live-0001, pin 12345678', [
        'sk-live-0001',
        '12345678',
      ]),
    ).toBe(`key ${ENV_VALUE_MASK} and ${ENV_VALUE_MASK}, pin ${ENV_VALUE_MASK}`)
  })

  it('masks a longer value whole when a shorter one is a part of it', () => {
    expect(maskEnvValues('token=abcdefgh-ijklmnop', ['abcdefgh', 'abcdefgh-ijklmnop'])).toBe(
      `token=${ENV_VALUE_MASK}`,
    )
  })

  it('keeps text without a value and ignores empty values', () => {
    expect(maskEnvValues('nothing here', ['sk-live-0001', ''])).toBe('nothing here')
    expect(maskEnvValues('nothing here', [])).toBe('nothing here')
  })

  it('neither masks nor finds a value shorter than eight bytes', () => {
    const text = 'pin 1234567, flag 1, ключ'
    expect(maskEnvValues(text, ['1234567', '1'])).toBe(text)
    expect(containsEnvValue(text, ['1234567', '1'])).toBe(false)
    expect(envValueBytes(['1'])).toEqual([])
    const event = { text }
    expect(maskEnvValuesDeep(event, ['1'])).toBe(event)
    // Four Cyrillic letters are eight bytes: masked.
    expect(maskEnvValues(text, ['ключ'])).toBe(`pin 1234567, flag 1, ${ENV_VALUE_MASK}`)
  })

  it('masks values with new lines and quotes as they are', () => {
    const pem = '-----BEGIN KEY-----\nAAAA"BBBB\n-----END KEY-----'
    expect(maskEnvValues(`cat: ${pem}!`, [pem])).toBe(`cat: ${ENV_VALUE_MASK}!`)
  })

  it('masks the strings of events and leaves the rest', () => {
    const events = [
      { type: 'message', text: 'используйте sk-live-0001' },
      { type: 'command', command: 'curl -H "x: sk-live-0001"', exitCode: 0 },
      { type: 'usage', usage: { output: 12 } },
      { type: 'question', text: 'q', options: ['sk-live-0001', 'нет'] },
    ]
    expect(maskEnvValuesDeep(events, ['sk-live-0001'])).toEqual([
      { type: 'message', text: `используйте ${ENV_VALUE_MASK}` },
      { type: 'command', command: `curl -H "x: ${ENV_VALUE_MASK}"`, exitCode: 0 },
      { type: 'usage', usage: { output: 12 } },
      { type: 'question', text: 'q', options: [ENV_VALUE_MASK, 'нет'] },
    ])
    expect(maskEnvValuesDeep(events, [])).toBe(events)
    expect(maskEnvValuesDeep({ 'sk-live-0001': 1 }, ['sk-live-0001'])).toEqual({
      [ENV_VALUE_MASK]: 1,
    })
  })

  it('finds a value verbatim', () => {
    expect(containsEnvValue('a sk-live-0001 b', ['zzzzzzzz', 'sk-live-0001'])).toBe(true)
    expect(containsEnvValue('a sk-live-000 b', ['sk-live-0001', ''])).toBe(false)
  })

  it('masks and finds a value inside JSON text, escaped once and twice', () => {
    const value = 'pa"ss\\wo\nrd'
    const row = JSON.stringify({ output: JSON.stringify({ token: value }) })
    expect(row).not.toContain(value)
    expect(containsEnvValue(row, [value])).toBe(true)
    const masked = maskEnvValues(row, [value])
    expect(masked).not.toContain('pa\\"ss')
    // The masked row is still the JSON it was: the mask has nothing JSON escapes.
    expect(JSON.parse(JSON.parse(masked).output)).toEqual({ token: ENV_VALUE_MASK })
    expect(maskEnvValuesDeep({ text: `got ${value}` }, [value])).toEqual({
      text: `got ${ENV_VALUE_MASK}`,
    })
  })

  it('spells a plain value once, an escaped one three ways, longest first', () => {
    expect(envValueForms(['sk-live-0001', 'sk-live-0001', ''])).toEqual(['sk-live-0001'])
    expect(envValueForms(['a"bcdefgh'])).toEqual(['a\\\\\\"bcdefgh', 'a\\"bcdefgh', 'a"bcdefgh'])
    // As `$'…'` of the shell script holds it: the backslash and the quote escaped, nothing else.
    expect(envValueForms(["it's-a-key"])).toEqual(["it\\'s-a-key", "it's-a-key"])
    expect(maskEnvValues("export K=$'it\\'s-a-key'", ["it's-a-key"])).toBe(
      `export K=$'${ENV_VALUE_MASK}'`,
    )
    expect(envValueForms(['a\\b-key-0001'])).toContain('a\\\\b-key-0001')
    expect(envValueBytes(['ключ-0001'])).toEqual([new TextEncoder().encode('ключ-0001')])
  })

  it('refuses a value in a change and in content with a reason, never the value', () => {
    const change = envValueInChange()
    expect(isDomainError(change)).toBe(true)
    expect(change.code).toBe('PUBLICATION_SECRET')
    expect(change.details).toEqual({ reason: 'client_variable' })
    const content = envValueInContent()
    expect(content.code).toBe('CONTENT_CREDENTIAL_REFUSED')
    expect(content.httpStatus).toBe(400)
    expect(isEnvValueRefusal(change) && isEnvValueRefusal(content)).toBe(true)
    expect(isEnvValueRefusal(new Error('x'))).toBe(false)
  })
})

describe('the egress of a set of variables', () => {
  it('is every host once, sorted', () => {
    expect(
      egressHostsOf([
        { hosts: ['b.example.ru:443', 'a.example.ru:443'] },
        { hosts: ['a.example.ru:443', 'a.example.ru:8443'] },
        { hosts: [] },
      ]),
    ).toEqual(['a.example.ru:443', 'a.example.ru:8443', 'b.example.ru:443'])
    expect(egressHostsOf([])).toEqual([])
  })
})
