import { describe, expect, it } from 'vitest'

import { checkPageFile, pageFileHeaders, pageFilePathSchema, pageFileTypeOf } from './files.ts'
import { pageLimits } from './limits.ts'

// The shared files of a site (docs/plan/73-pages-sites.md, Дер34): types of the list, by their
// bytes too; no HTML; their own headers.

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const text = (value: string) => new TextEncoder().encode(value)

describe('the paths of shared files', () => {
  it('takes a file of the list under /_files/, nothing else', () => {
    for (const ok of ['/_files/style.css', '/_files/img/logo.png', '/_files/a/b/c/d/e.woff2'])
      expect(pageFilePathSchema.safeParse(ok).success, ok).toBe(true)
    for (const bad of [
      '/style.css',
      '/_files/index.html',
      '/_files/page.htm',
      '/_files/a.php',
      '/_files/../x.css',
      '/_files/a..b.css',
      '/_files/A.css',
      '/_files/.hidden.css',
      '/_files/a/b/c/d/e/f.css',
      '/_files/style',
      '/_files//x.css',
    ])
      expect(pageFilePathSchema.safeParse(bad).success, bad).toBe(false)
    expect(pageFileTypeOf('/_files/x.svg')).toBe('image/svg+xml')
    expect(pageFileTypeOf('/_files/x.html')).toBeNull()
  })
})

describe('checkPageFile', () => {
  it('takes text of UTF-8 and a picture that begins as its type does', () => {
    expect(checkPageFile('/_files/s.css', text('a{color:red}'))).toEqual({
      ok: true,
      type: 'text/css; charset=utf-8',
    })
    expect(checkPageFile('/_files/logo.png', png)).toEqual({ ok: true, type: 'image/png' })
  })

  it('refuses a picture that is something else, text that is not UTF-8, and too much', () => {
    expect(checkPageFile('/_files/logo.png', text('<script>'))).toEqual({
      ok: false,
      reason: 'signature',
    })
    expect(checkPageFile('/_files/s.css', new Uint8Array([0xff, 0xfe]))).toEqual({
      ok: false,
      reason: 'not_utf8',
    })
    expect(
      checkPageFile('/_files/big.png', new Uint8Array(pageLimits.fileBytes + 1).fill(0x89)),
    ).toEqual({ ok: false, reason: 'too_large' })
    expect(checkPageFile('/_files/x.html', text('<p>'))).toEqual({ ok: false, reason: 'type' })
  })
})

describe('the headers of a shared file', () => {
  it('names its type, lets any page load it, and runs nothing opened alone', () => {
    const css = pageFileHeaders('text/css; charset=utf-8')
    expect(css).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    })
    expect(pageFileHeaders('image/svg+xml')['Content-Security-Policy']).toContain('sandbox')
    expect(pageFileHeaders('application/pdf')['Content-Disposition']).toBe('attachment')
  })
})
