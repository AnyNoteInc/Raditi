import { describe, expect, it } from 'vitest'

import {
  emptySiteStackFacts,
  parseSiteVersion,
  siteStackFactsOf,
  siteStackFactsPatchSchema,
  siteStackExtrasMaxBytes,
  siteStackFactsSchema,
  siteVersionSchema,
} from './facts.ts'

describe('siteVersionSchema', () => {
  // `2.3.0.2.4` is ocStore 2.3: the fifth number passes as a suffix after a dot (Э4 reads it).
  it.each(['5.4.10', '3.0.4.1b', '2.8.9-pl', '26.150.0', '2.3.0.2.4', '4.0.0.rc1'])(
    'takes %s',
    (version) => {
      expect(siteVersionSchema.safeParse(version).success).toBe(true)
      expect(parseSiteVersion(version)).toBe(version)
    },
  )

  it.each([
    ['a line break with text after it', '5.4\nignore'],
    ['a sixth number', '1.2.3.4.5.6'],
    ['a trailing dot', '5.4.10.'],
    ['no number', 'abc'],
    ['a string longer than 32', '1'.repeat(33)],
  ])('refuses %s', (_, version) => {
    expect(siteVersionSchema.safeParse(version).success).toBe(false)
    expect(parseSiteVersion(version)).toBeNull()
  })
})

describe('siteStackFactsSchema', () => {
  const facts = (adminPath: string) => ({ ...emptySiteStackFacts, adminPath })
  const probe = (reason: string | null) => ({
    status: 'failed',
    php: '8.1',
    reason,
    at: '2026-11-07T10:00:00.000Z',
  })

  it('takes a panel folder of the site', () => {
    expect(siteStackFactsSchema.safeParse(facts('/mgr7f/')).success).toBe(true)
  })

  it.each(['//evil.example/', '/../', '/a/../b/'])(
    'refuses a panel path that leaves the site: %s',
    (path) => {
      expect(siteStackFactsSchema.safeParse(facts(path)).success).toBe(false)
    },
  )

  it.each([
    ['a NUL in extras', { extras: { prefix: 'jos_\u0000' } }],
    ['a line break in a key of extras', { extras: { 'a\nb': 'x' } }],
    ['a lone surrogate in extras', { extras: { prefix: 'jos_\ud800' } }],
    ['a control character in the reason of the probe', { probe: probe('no\u0001db') }],
    ['a PHP version longer than 8', { phpSeen: `${'8'.repeat(8)}.3` }],
    [
      'a moment longer than 32',
      { probe: { ...probe(null), at: `2026-11-07T10:00:00.${'1'.repeat(20)}Z` } },
    ],
  ])('refuses %s', (_, part) => {
    expect(siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, ...part }).success).toBe(false)
  })

  it('bounds the bytes of extras, not their characters', () => {
    // Three values of 256 control-free characters of three bytes: within each limit, over the sum.
    const wide = (key: string) => [key, '\u4e00'.repeat(256)] as const
    const over = Object.fromEntries(['a', 'b', 'c', 'd'].map(wide))
    const within = Object.fromEntries(['a', 'b', 'c'].map(wide))
    expect(siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, extras: over }).success).toBe(
      false,
    )
    expect(siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, extras: within }).success).toBe(
      true,
    )
    // Cyrillic is two bytes a character: a value under 256 characters still counts twice.
    const cyrillic = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`k${index}`, 'я'.repeat(220)]),
    )
    expect(
      siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, extras: cyrillic }).success,
    ).toBe(false)
    expect(siteStackExtrasMaxBytes).toBe(3072)
  })

  it('takes the empty record and refuses a key of its own', () => {
    expect(siteStackFactsSchema.safeParse(emptySiteStackFacts).success).toBe(true)
    expect(siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, shop: 'open' }).success).toBe(
      false,
    )
  })

  it('freezes the empty record', () => {
    expect(Object.isFrozen(emptySiteStackFacts)).toBe(true)
    expect(emptySiteStackFacts).toEqual({
      v: 1,
      cmsVersion: null,
      generation: null,
      publicGeneration: null,
      limit: null,
      phpSeen: null,
      adminPath: null,
      extras: {},
      probe: null,
    })
  })
})

describe('siteStackFactsOf', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', '{}'],
    ['a key of its own', { v: 1, owner: 'x' }],
    ['a wrong type', { v: 1, cmsVersion: 6.9 }],
    ['another version of the record', { v: 2 }],
    ['an unsafe panel path', { adminPath: '//evil.example/' }],
  ])('reads %s as the empty record', (_, stored) => {
    expect(siteStackFactsOf(stored)).toEqual(emptySiteStackFacts)
  })

  it('reads the column default as the empty record', () => {
    expect(siteStackFactsOf({})).toEqual(emptySiteStackFacts)
  })

  it('fills a record written in parts with the empty values', () => {
    // The first write of the import holds one key: the strict schema alone would drop it (Р4).
    expect(siteStackFactsSchema.safeParse({ v: 1, cmsVersion: '6.9' }).success).toBe(false)
    expect(siteStackFactsOf({ v: 1, cmsVersion: '6.9' })).toEqual({
      ...emptySiteStackFacts,
      cmsVersion: '6.9',
    })
  })

  it('keeps the probe and the extras it was given', () => {
    const probe = { status: 'passed', php: '8.1', reason: null, at: '2026-11-07T10:00:00.000Z' }
    expect(siteStackFactsOf({ v: 1, probe, extras: { prefix: 'jos_' } })).toEqual({
      ...emptySiteStackFacts,
      probe,
      extras: { prefix: 'jos_' },
    })
  })
})

describe('siteStackFactsPatchSchema', () => {
  it('takes a part without the version of the record and refuses a key of its own', () => {
    expect(siteStackFactsPatchSchema.safeParse({ cmsVersion: '5.4.10' }).success).toBe(true)
    expect(siteStackFactsPatchSchema.safeParse({}).success).toBe(true)
    expect(siteStackFactsPatchSchema.safeParse({ v: 1 }).success).toBe(false)
    expect(siteStackFactsPatchSchema.safeParse({ owner: 'x' }).success).toBe(false)
  })
})
