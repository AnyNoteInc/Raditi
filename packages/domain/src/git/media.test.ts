import { describe, expect, it } from 'vitest'

import { mediaChecksSchema, mediaContentProblem, mediaNameProblem } from './media.ts'

const checks = mediaChecksSchema.parse({
  extensions: {
    png: [{ offset: 0, hex: '89504e470d0a1a0a' }],
    webp: [
      { offset: 0, hex: '52494646' },
      { offset: 8, hex: '57454250' },
    ],
  },
  refusedNameParts: ['.php', '.svg', '.htaccess'],
  maxFileBytes: 16,
})
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')

describe('media of a candidate', () => {
  it('takes an allowed extension in any letter case', () => {
    expect(mediaNameProblem('2026/hero.png', checks)).toBeNull()
    expect(mediaNameProblem('Hero.PNG', checks)).toBeNull()
    // A dot in a folder is not an extension of the file.
    expect(mediaNameProblem('2026.10/hero.png', checks)).toBeNull()
  })

  it.each([
    ['.hidden.png', 'hidden'],
    ['.well-known/x.png', 'hidden'],
    ['a/.png', 'hidden'],
    ['shell.php.png', 'refused_name'],
    ['x.PHP/a.png', 'refused_name'],
    ['logo.svg.png', 'refused_name'],
    ['readme', 'extension'],
    ['page.html', 'extension'],
    ['x.svg', 'refused_name'],
    ['constructor', 'extension'],
    ['a.constructor', 'extension'],
    // A second extension gets a handler of its own on Apache: one extension only.
    ['x.shtml.gif', 'refused_name'],
    ['x.cgi.png', 'refused_name'],
    ['x.html.png', 'refused_name'],
    ['logo.min.png', 'refused_name'],
    ['x.png.png', 'refused_name'],
  ])('refuses the name %s (%s)', (name, problem) => {
    expect(mediaNameProblem(name, checks)).toBe(problem)
  })

  it('checks every signature of the extension and the size', () => {
    expect(mediaContentProblem('a.png', png, checks)).toBeNull()
    expect(mediaContentProblem('a.webp', webp, checks)).toBeNull()
    expect(mediaContentProblem('a.png', webp, checks)).toBe('signature')
    // RIFF alone is a WAV or an AVI as well.
    const riff = new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ')
    expect(mediaContentProblem('a.webp', riff, checks)).toBe('signature')
    expect(mediaContentProblem('a.png', png.subarray(0, 4), checks)).toBe('signature')
    expect(mediaContentProblem('a.png', new Uint8Array(17), checks)).toBe('size')
    expect(mediaContentProblem('a.html', png, checks)).toBe('extension')
  })

  it('never takes a name of the object prototype for an extension', () => {
    expect(mediaContentProblem('a.constructor', png, checks)).toBe('extension')
    expect(mediaContentProblem('a.__proto__', png, checks)).toBe('extension')
  })
})
