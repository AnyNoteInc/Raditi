import { describe, expect, it } from 'vitest'

import { previewDifferences, previewPassportSchema } from './passport.ts'

const checkedAt = '2026-11-06T09:00:00.000Z'

describe('the passport of a preview (Т33, Т34)', () => {
  it('takes how the copy started and how it differs', () => {
    for (const boot of ['proved', 'suspect', 'not_compared'] as const) {
      const passport = { boot, differences: ['redirects_away'], checkedAt }
      expect(previewPassportSchema.parse(passport)).toEqual(passport)
    }
    expect(previewPassportSchema.parse({ boot: 'suspect', differences: [], checkedAt })).toEqual({
      boot: 'suspect',
      differences: [],
      checkedAt,
    })
  })

  it('has no failed boot: a site that did not start has no preview, it is boot_failed', () => {
    expect(
      previewPassportSchema.safeParse({ boot: 'failed', differences: [], checkedAt }).success,
    ).toBe(false)
  })

  it('refuses a difference it does not know, a moment that is not one and an extra key', () => {
    for (const broken of [
      { boot: 'suspect', differences: ['looks_odd'], checkedAt },
      { boot: 'suspect', differences: [], checkedAt: 'yesterday' },
      { boot: 'suspect', differences: [], checkedAt, shown: true },
      {
        boot: 'suspect',
        differences: Array.from({ length: 25 }, () => 'code_drift'),
        checkedAt,
      },
    ])
      expect(previewPassportSchema.safeParse(broken).success).toBe(false)
  })

  it('names every row of the table of Т34 once', () => {
    expect(previewDifferences).toHaveLength(18)
    expect(new Set(previewDifferences).size).toBe(previewDifferences.length)
    expect(previewDifferences).toEqual([
      'code_drift',
      'php_differs',
      'php_unknown',
      'home_differs',
      'redirects_away',
      'media_on_hosting',
      'media_placeholders',
      'extension_data_left_out',
      'files_left_out',
      'documents_left_out',
      'encoded_code',
      'external_cache',
      'partial_site',
      'server_rules_default',
      'seed_from_dump',
      'live_edits',
      'secrets_masked',
      'other_system_left_out',
    ])
  })
})
