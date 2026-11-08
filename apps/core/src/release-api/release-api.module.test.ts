import { getSiteContentAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import { releaseApiStacks } from './release-api.module.ts'

describe('ReleaseApiModule: the adapters of the stacks', () => {
  it('gives the release of a stack without published content no plugin (Т8)', () => {
    expect(releaseApiStacks.contentAdapter('wordpress')).toBe(getSiteContentAdapter('wordpress'))
    // Bitrix has no content adapter: its release goes without the plugin, not with an error.
    expect(releaseApiStacks.contentAdapter('bitrix')).toBeNull()
  })
})
