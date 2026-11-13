import { tokenReasonOf, TURN_KEY_PATTERNS } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { newTurnKeys } from './turn-key.ts'

// The checks of a page (docs/plan/69-pages.md, Ст8) know the forms of the keys of a turn from
// @repo/domain, which cannot import this package: a change of the form here must break this.
describe('the keys of a turn on a page', () => {
  it('are found by the checks of the pages', () => {
    for (let round = 0; round < 50; round += 1) {
      const { llmApiKey, mcpToken } = newTurnKeys()
      for (const key of [llmApiKey, mcpToken]) {
        expect(TURN_KEY_PATTERNS.some((pattern) => pattern.test(key))).toBe(true)
        expect(tokenReasonOf(`<p>${key}</p>`)).toBe('turn_key')
      }
    }
  })
})
