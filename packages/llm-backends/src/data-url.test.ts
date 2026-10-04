import { describe, expect, it } from 'vitest'

import { isInlineImageDataUrl } from './data-url.ts'

const prefix = 'data:image/png;base64,'

describe('inline image data URL check', () => {
  it.each(['png', 'jpeg', 'webp', 'gif'])('accepts canonical base64 for image/%s', (type) => {
    for (const body of ['YWFh', 'YWE=', 'YQ==', 'YWFhYQ==', '+/+/', 'AAAA'.repeat(64)])
      expect(isInlineImageDataUrl(`data:image/${type};base64,${body}`)).toBe(true)
  })

  it.each([
    '',
    'YQ==',
    'https://remote.invalid/a.png',
    'file:///etc/passwd',
    'data:text/html;base64,YQ==',
    'data:image/svg+xml;base64,YQ==',
    'data:image/PNG;base64,YQ==',
    'data:image/png;charset=utf-8;base64,YQ==',
    ' data:image/png;base64,YQ==',
    prefix,
    `${prefix}%%%`,
    `${prefix}YQ`,
    `${prefix}YQ=`,
    `${prefix}YWFhY`,
    `${prefix}Y===`,
    `${prefix}====`,
    `${prefix}=`,
    `${prefix}YQ==YQ==`,
    `${prefix}YW=h`,
    `${prefix}YQ== `,
    `${prefix}YQ==\n`,
    `${prefix}YW\nFh`,
    `${prefix}YW-_`,
    `${prefix}YWFh,YWFh`,
    `${prefix}YWFā`,
  ])('rejects a non-inline or non-canonical value %j', (value) => {
    expect(isInlineImageDataUrl(value)).toBe(false)
  })

  it('checks a 16 MiB body in linear time, without recursion', () => {
    const body = 'iVBORw0K'.repeat((16 * 1024 * 1024) / 8)
    const started = performance.now()
    expect(isInlineImageDataUrl(`${prefix}${body}`)).toBe(true)
    expect(isInlineImageDataUrl(`${prefix}${body}AA==`)).toBe(true)
    expect(isInlineImageDataUrl(`${prefix}${body}A===`)).toBe(false)
    expect(isInlineImageDataUrl(`${prefix}${body}%`)).toBe(false)
    expect(isInlineImageDataUrl(`${prefix}%${body}`)).toBe(false)
    // Generous for a loaded CI host; the replaced pattern overflowed the stack near 4.5 MiB.
    expect(performance.now() - started).toBeLessThan(5000)
  })
})
