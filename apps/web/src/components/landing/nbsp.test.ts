import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('landing sources', () => {
  it('write a non-breaking space as an escape or an entity, never as the invisible character', () => {
    const here = fileURLToPath(new URL('.', import.meta.url))
    const invisible = String.fromCharCode(0xa0)
    const files = readdirSync(here).filter((name) => /\.(tsx?|css)$/.test(name))

    expect(files.length).toBeGreaterThan(10)
    expect(
      files.filter((name) => readFileSync(`${here}${name}`, 'utf8').includes(invisible)),
    ).toEqual([])
  })
})
