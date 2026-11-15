import { Registry } from '@prometheus-io/client'
import { describe, expect, it, vi } from 'vitest'

import { PageMetrics } from './page-metrics.ts'

describe('PageMetrics', () => {
  it('reports the sites by state and the bytes of the trash of the last count, with no id', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        { state: 'live', sites: 3n },
        { state: 'deleted', sites: 1n },
      ])
      .mockResolvedValueOnce([{ bytes: 2048n }])
    const metrics = new PageMetrics({ $queryRaw: queryRaw } as never)
    const registry = new Registry()
    metrics.register(registry)
    // Nothing counted yet: no value is made up.
    expect(await registry.metrics()).not.toMatch(/raditi_pages_trees\{/)
    await metrics.refresh()
    const text = await registry.metrics()
    expect(text).toContain('raditi_pages_trees{state="live"} 3')
    expect(text).toContain('raditi_pages_trees{state="deleted"} 1')
    expect(text).toContain('raditi_pages_trees{state="purged"} 0')
    expect(text).toContain('raditi_pages_trash_bytes 2048')
    expect(text).not.toMatch(/workspace|tree_id|slug/)
  })
})
