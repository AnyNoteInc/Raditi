import { describe, expect, it } from 'vitest'

import { previewRuntimeDiffers, previewRuntimeMatch } from './runtime-match.ts'

const runtime = (runtimeVersion: string, extensions: string[]) => ({
  version: 1 as const,
  kind: 'runtime' as const,
  runtimeVersion,
  extensions,
})

describe('the runtime of a preview against the site', () => {
  it('names the versions and the extensions the preview lacks', () => {
    const match = previewRuntimeMatch(
      runtime('7.4', ['curl', 'imagick', 'ioncube loader', 'zend opcache', 'xdebug']),
      runtime('8.3', ['curl', 'zend opcache']),
    )
    expect(match).toEqual({
      production: '7.4',
      preview: '8.3',
      missing: ['imagick', 'ioncube loader'],
    })
    expect(previewRuntimeDiffers(match)).toBe(true)
  })

  it('tells nothing when they agree, or when the site could not be read', () => {
    const same = previewRuntimeMatch(runtime('8.3', ['curl']), runtime('8.3', ['curl', 'gd']))
    expect(same).toEqual({ production: '8.3', preview: '8.3', missing: [] })
    expect(previewRuntimeDiffers(same)).toBe(false)
    expect(previewRuntimeMatch(null, runtime('8.3', []))).toBeNull()
    expect(previewRuntimeDiffers(null)).toBe(false)
    // The preview could not tell: only the version the site runs is known.
    expect(previewRuntimeMatch(runtime('8.1', ['curl']), null)).toEqual({
      production: '8.1',
      preview: null,
      missing: [],
    })
  })
})
