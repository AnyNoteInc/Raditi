import { describe, expect, it } from 'vitest'

import {
  emptyPreviewRecord,
  previewRecordOf,
  previewRecordSchema,
  SYNC_PATHS_BYTES,
  withSyncedPaths,
} from './preview-record.ts'

describe('the record of a preview', () => {
  it('reads a row of another shape as empty', () => {
    expect(previewRecordOf(null)).toEqual(emptyPreviewRecord())
    expect(previewRecordOf({ v: 2 })).toEqual(emptyPreviewRecord())
    expect(previewRecordOf({ ...emptyPreviewRecord(), password: 'x' })).toEqual(
      emptyPreviewRecord(),
    )
  })

  it('keeps the synced paths of a turn sorted and once, until they no longer fit', () => {
    expect(withSyncedPaths(['b.php'], ['a.php', 'b.php'])).toEqual(['a.php', 'b.php'])
    expect(withSyncedPaths(null, ['a.php'])).toBeNull()
    const many = Array.from({ length: 200 }, (_, i) => `wp-content/themes/shop/part-${i}.php`)
    expect(withSyncedPaths([], many)).toBeNull()
  })

  it('stays within the 8 KiB of the row with the most paths it keeps', () => {
    const paths: string[] = []
    for (let i = 0; ; i++) {
      const next = withSyncedPaths(paths, [`wp-content/themes/a/f${i}.php`])
      if (next === null) break
      paths.splice(0, paths.length, ...next)
    }
    const record = previewRecordSchema.parse({
      ...emptyPreviewRecord(),
      database: { tablePrefix: 'wp_', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
      web: `registry.invalid/web@sha256:${'a'.repeat(64)}`,
      sync: {
        assignmentId: '00000000-0000-4000-8000-000000000001',
        baseSha: 'a'.repeat(40),
        paths,
      },
    })
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(8192)
    expect(paths.join('').length).toBeLessThan(SYNC_PATHS_BYTES)
  })
})
