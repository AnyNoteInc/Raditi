import { describe, expect, it, vi } from 'vitest'

import { DomainError } from '../errors.ts'
import {
  estimateLlmInputTokens,
  llmJsonLimits,
  normalizeLlmJson,
  parseLlmJson,
  type JsonObject,
  type JsonObjectPolicy,
} from './json-policy.ts'

const bytes = (text: string) => new TextEncoder().encode(text)
const object = (value: JsonObject) => bytes(JSON.stringify(value))
const policy: JsonObjectPolicy = {
  kind: 'object',
  required: ['model', 'input'],
  strip: ['client_metadata'],
  fields: {
    model: { kind: 'string' },
    input: {
      kind: 'array',
      items: {
        kind: 'object',
        fields: { text: { kind: 'string' }, schema: { kind: 'any' } },
      },
    },
  },
}

describe('bounded LLM JSON', () => {
  it('accepts UTF-8 objects and rejects invalid UTF-8, primitives and non-finite numbers', () => {
    expect(parseLlmJson(object({ message: 'Синтетический запрос 😀' }))).toEqual({
      message: 'Синтетический запрос 😀',
    })
    for (const text of ['[]', 'null', '1', '"text"', '{"n":1e400}']) {
      expect(() => parseLlmJson(bytes(text))).toThrow(DomainError)
    }
    expect(() => parseLlmJson(new Uint8Array([0x7b, 0x22, 0xc0, 0x22, 0x3a, 0x31, 0x7d]))).toThrow(
      DomainError,
    )
  })

  it('limits bytes at the boundary', () => {
    const body = object({ value: 'a'.repeat(llmJsonLimits.bytes - 12) })
    expect(body.byteLength).toBe(llmJsonLimits.bytes)
    expect(parseLlmJson(body).value).toHaveLength(llmJsonLimits.bytes - 12)
    expect(() => parseLlmJson(new Uint8Array(llmJsonLimits.bytes + 1))).toThrow(DomainError)
  })

  it('bounds depth and nodes before recursive processing', () => {
    const nested = (depth: number) => `${'{"a":'.repeat(depth - 1)}0${'}'.repeat(depth - 1)}`
    expect(() => parseLlmJson(bytes(nested(64)))).not.toThrow()
    expect(() => parseLlmJson(bytes(nested(65)))).toThrow(DomainError)
    expect(() =>
      parseLlmJson(object({ values: Array.from({ length: llmJsonLimits.nodes - 2 }, () => null) })),
    ).not.toThrow()
    expect(() =>
      parseLlmJson(object({ values: Array.from({ length: llmJsonLimits.nodes - 1 }, () => null) })),
    ).toThrow(DomainError)
  })

  it('rejects excessive nesting or nodes before the native parser allocates their tree', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const deep = `{"a":${'['.repeat(500_000)}0${']'.repeat(500_000)}}`
      expect(() => parseLlmJson(bytes(deep))).toThrow(DomainError)
      expect(() => parseLlmJson(bytes(`{"a":[${'0,'.repeat(200_000)}0]}`))).toThrow(DomainError)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('counts strings as values and ignores structural characters and escaped quotes inside strings', () => {
    const value = { text: '[]{}:"\\"', values: [true, false, null, -1.5e20, { escaped: '\\"end' }] }
    expect(parseLlmJson(bytes(JSON.stringify(value)))).toEqual(value)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(() => parseLlmJson(bytes(`{"a":[${'"",'.repeat(200_000)}""]}`))).toThrow(DomainError)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects %s at any depth, even within a free-form schema',
    (key) => {
      const raw = `{"model":"m","input":[{"schema":{"${key}":"value"}}]}`
      expect(() => parseLlmJson(bytes(raw))).toThrow(DomainError)
      expect(() => normalizeLlmJson(JSON.parse(raw) as JsonObject, policy)).toThrow(DomainError)
    },
  )

  it('never exposes syntax fragments or attacker-chosen keys in errors', () => {
    const marker = 'synthetic-secret-marker'
    const rejected = [
      () => parseLlmJson(bytes(`{"x":"${marker}`)),
      () => normalizeLlmJson({ model: 'm', input: [{ [marker]: marker }] }, policy),
    ]
    for (const act of rejected) {
      try {
        act()
        expect.fail('expected rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError)
        expect(String(error)).not.toContain(marker)
        expect(JSON.stringify(error)).not.toContain(marker)
      }
    }
  })

  it('rejects cycles and accessor values without running their code', () => {
    const cyclic: JsonObject = {}
    cyclic.self = cyclic
    expect(() => normalizeLlmJson(cyclic, policy)).toThrow(DomainError)
    let reads = 0
    const accessor = Object.defineProperty({}, 'model', {
      enumerable: true,
      get() {
        reads += 1
        return 'm'
      },
    }) as JsonObject
    expect(() => normalizeLlmJson(accessor, policy)).toThrow(DomainError)
    expect(reads).toBe(0)
  })

  it('rejects custom array prototypes and sparse fake indices before traversing items', () => {
    let reads = 0
    const values: string[] = ['text']
    Object.setPrototypeOf(values, {
      get map() {
        reads += 1
        return () => [42]
      },
    })
    const arrays: JsonObjectPolicy = {
      kind: 'object',
      fields: { values: { kind: 'array', items: { kind: 'string' } } },
    }
    expect(() => normalizeLlmJson({ values }, arrays)).toThrow(DomainError)
    expect(reads).toBe(0)
    const sparse: string[] = new Array<string>(1)
    Object.defineProperty(sparse, '4294967295', { value: 'text', enumerable: true })
    expect(() => normalizeLlmJson({ values: sparse }, arrays)).toThrow(DomainError)
  })
})

describe('recursive allowlists', () => {
  it('strips only configured fields, preserves free-form schemas and is immutable/idempotent', () => {
    const original = {
      model: 'm',
      input: [{ text: 'hello', schema: { properties: { amount: { type: 'number' } } } }],
      client_metadata: { private: 'discarded' },
    }
    const once = normalizeLlmJson(original, policy)
    expect(once).toEqual({ model: 'm', input: original.input })
    expect(normalizeLlmJson(once, policy)).toEqual(once)
    expect(original.client_metadata).toEqual({ private: 'discarded' })
    expect(once.input).not.toBe(original.input)
  })

  it('checks required fields and types and reports only allowlisted path components', () => {
    expect(() => normalizeLlmJson({ model: 'm' }, policy)).toThrow(DomainError)
    try {
      normalizeLlmJson({ model: 'm', input: [{ text: 17 }] }, policy)
      expect.fail('expected type rejection')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        httpStatus: 400,
        details: { path: 'input[].text' },
      })
    }
    const longKey = 'known_'.repeat(15)
    try {
      normalizeLlmJson(
        { [longKey]: 1 },
        { kind: 'object', fields: { [longKey]: { kind: 'string' } } },
      )
      expect.fail('expected type rejection')
    } catch (error) {
      expect((error as DomainError).details).toEqual({ reason: 'type', path: longKey.slice(0, 64) })
    }
  })
})

describe('input token estimate', () => {
  it('counts UTF-8 bytes, excludes approved opaque strings and adds 2000 per image', () => {
    const value: JsonObject = {
      input: [
        { encrypted_content: 'x'.repeat(12_000) },
        { image: `data:image/png;base64,${'a'.repeat(20_000)}` },
        { text: 'Текст 😀' },
      ],
    }
    const counted: JsonObject = {
      input: [{ encrypted_content: '' }, { image: '' }, { text: 'Текст 😀' }],
    }
    expect(
      estimateLlmInputTokens(value, {
        encryptedContentPaths: [['input', 0, 'encrypted_content']],
        imagePaths: [['input', 1, 'image']],
      }),
    ).toBe(Math.ceil(object(counted).byteLength / 3) + 2000)
    expect((value.input as JsonObject[])[0]!.encrypted_content).toHaveLength(12_000)
  })

  it('does not exempt arbitrary prompt text by its prefix or key name', () => {
    const value = {
      encrypted_content: 'z'.repeat(900),
      text: `data:image/png;base64,${'a'.repeat(900)}`,
    }
    expect(estimateLlmInputTokens(value)).toBe(Math.ceil(object(value).byteLength / 3))
  })

  it('rejects stale/duplicate/wrong-type exemption paths and remote image URLs', () => {
    expect(() => estimateLlmInputTokens({ input: [] }, { imagePaths: [['input', 0]] })).toThrow(
      DomainError,
    )
    expect(() =>
      estimateLlmInputTokens(
        { encrypted_content: 3 },
        { encryptedContentPaths: [['encrypted_content']] },
      ),
    ).toThrow(DomainError)
    expect(() =>
      estimateLlmInputTokens(
        { image: 'https://example.invalid/image.png' },
        { imagePaths: [['image']] },
      ),
    ).toThrow(DomainError)
    expect(() =>
      estimateLlmInputTokens(
        { image: 'data:image/png;base64,aaaa' },
        { imagePaths: [['image'], ['image']] },
      ),
    ).toThrow(DomainError)
  })
})
