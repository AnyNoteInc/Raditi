import { describe, expect, it } from 'vitest'

import { aliasLimits, isAlias } from './alias.ts'
import {
  isPreviewBaseDomain,
  isPreviewPath,
  parsePreviewHostname,
  PREVIEW_SESSION_COOKIE,
  previewEnterUrl,
  previewGatewayPaths,
  previewHostname,
  previewOpenUrl,
  previewOrigin,
} from './hostname.ts'

/** A seeded generator: the same cases on every run. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const randomAlias = (next: () => number) =>
  Array.from(
    { length: aliasLimits.min + Math.floor(next() * (aliasLimits.max - aliasLimits.min + 1)) },
    () => ALPHABET[Math.floor(next() * ALPHABET.length)],
  ).join('')

describe('aliases', () => {
  it('takes 4 to 12 lower-case letters and digits', () => {
    for (const alias of ['abcd', '0f3a9c1b', 'a1b2c3', 'z'.repeat(12)])
      expect(isAlias(alias)).toBe(true)
    for (const alias of ['abc', 'a'.repeat(13), 'ABCD', 'ab-cd', 'ab_cd', 'абвг', '', 'ab cd'])
      expect(isAlias(alias)).toBe(false)
    expect(isAlias(42)).toBe(false)
  })
})

describe('preview hostnames', () => {
  it('spells site-<site>-chat-<task>.<base>', () => {
    expect(previewHostname({ siteAlias: '0f3a9c1b', taskAlias: 'a1b2c3' }, 'localhost')).toBe(
      'site-0f3a9c1b-chat-a1b2c3.localhost',
    )
    expect(previewHostname({ siteAlias: 'abcd', taskAlias: 'efgh' }, 'preview.raditi.ru')).toBe(
      'site-abcd-chat-efgh.preview.raditi.ru',
    )
  })

  it('reads back every address it writes (seeded property)', () => {
    const next = random(17)
    for (const base of ['localhost', 'preview.raditi.ru', 'p.example.test', 'a-b.c9.ru'])
      for (let i = 0; i < 500; i++) {
        const parts = { siteAlias: randomAlias(next), taskAlias: randomAlias(next) }
        const host = previewHostname(parts, base)
        expect(host.length).toBeLessThanOrEqual(253)
        expect(parsePreviewHostname(host, base)).toEqual(parts)
      }
  })

  it('refuses whatever is not exactly a preview host of this base', () => {
    const base = 'preview.raditi.ru'
    for (const host of [
      'site-abcd-chat-efgh.preview.raditi.ru.',
      'site-abcd-chat-efgh.preview.raditi.ru:443',
      'x.site-abcd-chat-efgh.preview.raditi.ru',
      'site-abcd-chat-efgh.other.raditi.ru',
      'site-abcd-chat-efgh.raditi.ru',
      'Site-abcd-chat-efgh.preview.raditi.ru',
      'site-ABCD-chat-efgh.preview.raditi.ru',
      'site-abc-chat-efgh.preview.raditi.ru',
      'site-abcd-chat-.preview.raditi.ru',
      'site--chat-efgh.preview.raditi.ru',
      'site-abcd-chat-efgh-chat-ijkl.preview.raditi.ru',
      'site-abcd-efgh.preview.raditi.ru',
      'chat-efgh-site-abcd.preview.raditi.ru',
      'preview.raditi.ru',
      'site-abcd-chat-efghpreview.raditi.ru',
      'site-abcd-chat-ef.gh.preview.raditi.ru',
      '',
    ])
      expect(parsePreviewHostname(host, base), host).toBeNull()
    expect(parsePreviewHostname('site-abcd-chat-efgh.localhost', 'LOCALHOST')).toBeNull()
  })

  it('refuses to write an address it could not read', () => {
    for (const [parts, base] of [
      [{ siteAlias: 'ab', taskAlias: 'efgh' }, 'localhost'],
      [{ siteAlias: 'abcd', taskAlias: 'ef-gh' }, 'localhost'],
      [{ siteAlias: 'abcd', taskAlias: 'efgh' }, 'localhost:8090'],
      [{ siteAlias: 'abcd', taskAlias: 'efgh' }, '127.0.0.1'],
      [{ siteAlias: 'abcd', taskAlias: 'efgh' }, 'Preview.ru'],
      [{ siteAlias: 'abcd', taskAlias: 'efgh' }, 'preview.ru.'],
      [{ siteAlias: 'abcd', taskAlias: 'efgh' }, ''],
    ] as const)
      expect(() => previewHostname(parts, base)).toThrow('Invalid preview address')
  })

  it('takes a domain name as the base, never an address or a port', () => {
    for (const base of ['localhost', 'preview.raditi.ru', 'xn--80aswg.xn--p1ai'])
      expect(isPreviewBaseDomain(base)).toBe(true)
    for (const base of [
      '1.2.3.4',
      'a..b',
      '-a.ru',
      'a.ru:80',
      'a/b',
      'a.ru.',
      `${'a'.repeat(64)}.ru`,
    ])
      expect(isPreviewBaseDomain(base), base).toBe(false)
    // 253 for the whole name less the longest preview label (35) and its dot.
    expect(
      isPreviewBaseDomain(
        `${'a'.repeat(61)}.${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(31)}`,
      ),
    ).toBe(true)
    expect(
      isPreviewBaseDomain(
        `${'a'.repeat(61)}.${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(32)}`,
      ),
    ).toBe(false)
  })

  it('writes the port of an origin only when it is not the scheme’s own', () => {
    const host = 'site-abcd-chat-efgh.localhost'
    expect(previewOrigin(host, { scheme: 'http', publicPort: 8090 })).toBe(
      'http://site-abcd-chat-efgh.localhost:8090',
    )
    expect(previewOrigin(host, { scheme: 'http', publicPort: 80 })).toBe(`http://${host}`)
    expect(previewOrigin(host, { scheme: 'https', publicPort: null })).toBe(`https://${host}`)
    expect(previewOrigin(host, { scheme: 'https', publicPort: 443 })).toBe(`https://${host}`)
    expect(previewOrigin(host, { scheme: 'https', publicPort: 8443 })).toBe(`https://${host}:8443`)
  })
})

describe('the way in', () => {
  const ticket = 'A'.repeat(43)

  it('names the paths of the gateway under its own prefix and a host-only cookie', () => {
    for (const path of Object.values(previewGatewayPaths)) expect(path).toMatch(/^\/__raditi\//)
    expect(PREVIEW_SESSION_COOKIE).toMatch(/^__Host-/)
  })

  it('takes a path of the same host with exactly one leading slash', () => {
    for (const path of ['/', '/about/', '/?p=42', '/shop/cart?x=1&y=2', '/%D0%B0'])
      expect(isPreviewPath(path), path).toBe(true)
    for (const path of [
      '',
      'about',
      '//evil.example',
      '/\\evil.example',
      '/a b',
      '/a#b',
      'https://evil.example/',
      '/\u0000',
      `/${'a'.repeat(2048)}`,
    ])
      expect(isPreviewPath(path), path).toBe(false)
  })

  it('builds the entry URL from an origin, a ticket and a path', () => {
    expect(previewEnterUrl('http://site-abcd-chat-efgh.localhost:8090', ticket, '/?p=1')).toBe(
      `http://site-abcd-chat-efgh.localhost:8090/__raditi/enter?t=${ticket}&to=%2F%3Fp%3D1`,
    )
    expect(() => previewEnterUrl('http://x', 'short', '/')).toThrow('Invalid preview entry')
    expect(() => previewEnterUrl('http://x', ticket, '//evil')).toThrow('Invalid preview entry')
  })

  it('opens a preview from the cabinet by host and path', () => {
    const host = 'site-abcd-chat-efgh.localhost'
    expect(previewOpenUrl('http://localhost:3000/', host, '/shop/?a=1')).toBe(
      'http://localhost:3000/preview/open?host=site-abcd-chat-efgh.localhost&path=%2Fshop%2F%3Fa%3D1',
    )
    // A path the gateway would not take becomes the home page.
    for (const path of ['//evil', '/\\evil', 'http://evil', '/#x'])
      expect(previewOpenUrl('https://raditi.ru', host, path), path).toBe(
        'https://raditi.ru/preview/open?host=site-abcd-chat-efgh.localhost&path=%2F',
      )
  })
})
