import { describe, expect, it } from 'vitest'

import { browserDownloadPart } from './downloads.ts'

const bytes = (text: string) => new TextEncoder().encode(text).length

describe('browserDownloadPart', () => {
  it('gives a short text as one part, an empty one as one empty part', () => {
    expect(browserDownloadPart('a\nb\n', 1)).toEqual({ text: 'a\nb\n', parts: 1 })
    expect(browserDownloadPart('', 1)).toEqual({ text: '', parts: 1 })
    expect(browserDownloadPart('a', 2)).toEqual({ text: '', parts: 1 })
  })

  it('keeps whole lines in a part while they fit, and loses nothing between parts', () => {
    const lines = Array.from(
      { length: 50 },
      (_, index) => `Заявка ${index};+7 999 000-00-${index}\n`,
    )
    const text = lines.join('')
    const { parts } = browserDownloadPart(text, 1, 200)
    expect(parts).toBeGreaterThan(1)
    let joined = ''
    for (let part = 1; part <= parts; part++) {
      const piece = browserDownloadPart(text, part, 200).text
      expect(bytes(piece)).toBeLessThanOrEqual(200)
      expect(piece.endsWith('\n')).toBe(true)
      joined += piece
    }
    expect(joined).toBe(text)
  })

  it('cuts a line longer than a part between characters, never inside one', () => {
    const text = 'я'.repeat(150)
    const { parts } = browserDownloadPart(text, 1, 100)
    const pieces = Array.from(
      { length: parts },
      (_, index) => browserDownloadPart(text, index + 1, 100).text,
    )
    expect(pieces.join('')).toBe(text)
    for (const piece of pieces) expect(bytes(piece)).toBeLessThanOrEqual(100)
  })
})
