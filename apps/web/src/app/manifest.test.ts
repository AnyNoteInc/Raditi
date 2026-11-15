import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import manifest from './manifest'

/** The width and height of a PNG, from its IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(fileURLToPath(new URL(`../../public${path}`, import.meta.url)))
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('the manifest of the cabinet (docs/plan/82, Зп42)', () => {
  it('opens the chats as an app of its own, named in Russian', () => {
    const app = manifest()
    expect(app).toMatchObject({
      name: 'Радити',
      short_name: 'Радити',
      lang: 'ru',
      display: 'standalone',
      start_url: '/chats',
      scope: '/',
    })
  })

  it('has icons of 192 and 512 pixels that are there and are of that size', () => {
    const icons = manifest().icons ?? []
    expect(icons.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512'])
    for (const icon of icons) {
      const [width, height] = (icon.sizes ?? '').split('x').map(Number)
      expect(pngSize(icon.src)).toEqual({ width, height })
    }
  })
})
