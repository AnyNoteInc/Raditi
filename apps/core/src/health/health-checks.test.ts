import { describe, expect, it } from 'vitest'

import { CORE_BUCKETS } from './health-checks.ts'

describe('checks', () => {
  it('core checks its own buckets: no backups, no platform', () => {
    expect(CORE_BUCKETS).toEqual(['inbox', 'sessions', 'logs', 'artifacts'])
  })
})
