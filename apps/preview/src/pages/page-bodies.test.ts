import { describe, expect, it } from 'vitest'

import {
  compressible,
  negotiateEncoding,
  noneMatchHits,
  PageBodies,
  taggedBases,
  variantTag,
} from './page-bodies.ts'

describe('the coding of a body (plan 96, P34)', () => {
  it('takes brotli before gzip, by the weights the viewer gives', () => {
    expect(negotiateEncoding('gzip, deflate, br, zstd')).toBe('br')
    expect(negotiateEncoding('gzip')).toBe('gzip')
    expect(negotiateEncoding('br;q=0.5, gzip;q=0.8')).toBe('gzip')
    expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip')
    expect(negotiateEncoding('*')).toBe('br')
    expect(negotiateEncoding('*;q=0')).toBe('identity')
    expect(negotiateEncoding('identity')).toBe('identity')
    expect(negotiateEncoding('deflate')).toBe('identity')
    expect(negotiateEncoding(undefined)).toBe('identity')
    expect(negotiateEncoding('br;q=nonsense, gzip')).toBe('gzip')
  })

  it('compresses text, JSON, SVG, scripts and styles of a kilobyte and more', () => {
    expect(compressible('text/html; charset=utf-8', 1024)).toBe(true)
    expect(compressible('text/html; charset=utf-8', 1023)).toBe(false)
    expect(compressible('text/css; charset=utf-8', 5000)).toBe(true)
    expect(compressible('text/javascript; charset=utf-8', 5000)).toBe(true)
    expect(compressible('image/svg+xml', 5000)).toBe(true)
    expect(compressible('application/json', 5000)).toBe(true)
    for (const type of ['image/png', 'font/woff2', 'application/pdf', 'image/jpeg'])
      expect(compressible(type, 5000), type).toBe(false)
  })

  it('names each coding by its own strong ETag and compares strongly', () => {
    expect(variantTag('p.3', 'identity')).toBe('"p.3"')
    expect(variantTag('p.3', 'br')).toBe('"p.3.br"')
    expect(variantTag('p.3', 'gzip')).toBe('"p.3.gz"')
    expect(noneMatchHits('"p.3.br"', '"p.3.br"')).toBe(true)
    expect(noneMatchHits('"x", "p.3.br"', '"p.3.br"')).toBe(true)
    expect(noneMatchHits('W/"p.3.br"', '"p.3.br"')).toBe(false)
    expect(noneMatchHits('"p.3"', '"p.3.br"')).toBe(false)
    expect(noneMatchHits(undefined, '"p.3"')).toBe(false)
    expect(taggedBases('"abc.br", "def", W/"x", "ghi.gz"')).toEqual(['abc', 'def', 'ghi'])
  })
})

describe('the bodies kept in memory (plan 96, P34)', () => {
  it('keeps one tag of a resource and lets the least recently used go over its bound', () => {
    const bodies = new PageBodies(2000)
    bodies.put('a', '1', new Uint8Array(500))
    bodies.put('b', '1', new Uint8Array(500))
    expect(bodies.get('a', '2')).toBeUndefined()
    bodies.put('a', '2', new Uint8Array(500))
    expect(bodies.tagOf('a')).toBe('2')
    expect(bodies.bytes).toBe(1000)
    expect(bodies.get('b', '1')).toBeDefined()
    bodies.put('c', '1', new Uint8Array(500))
    bodies.put('d', '1', new Uint8Array(500))
    expect(bodies.tagOf('a')).toBe('2')
    bodies.put('e', '1', new Uint8Array(500))
    // `a` is the least recently used now.
    expect(bodies.tagOf('a')).toBeUndefined()
    expect(bodies.tagOf('b')).toBe('1')
    expect(bodies.bytes).toBe(2000)
    // A body over a quarter of the bound is sent, not kept.
    const large = bodies.put('f', '1', new Uint8Array(501))
    expect(large.identity.byteLength).toBe(501)
    expect(bodies.tagOf('f')).toBeUndefined()
  })

  it('compresses a body once and counts the compressed bytes', async () => {
    const bodies = new PageBodies()
    const entry = bodies.put('a', '1', new TextEncoder().encode('x'.repeat(10_000)))
    const [one, two] = await Promise.all([bodies.body(entry, 'br'), bodies.body(entry, 'br')])
    expect(one).toBe(two)
    await Promise.resolve()
    expect(bodies.bytes).toBe(10_000 + one.byteLength)
    expect(await bodies.body(entry, 'identity')).toBe(entry.identity)
  })
})
