import { getSiteContentAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import { contentAccessKindOf, hasSiteAccess } from './site-access.ts'

describe('the access of a site', () => {
  const db = (rows: number) => {
    const asked: unknown[] = []
    return {
      asked,
      credentialRef: {
        count: (query: unknown) => {
          asked.push(query)
          return Promise.resolve(rows)
        },
      },
    }
  }

  it('is there with exactly one row of its kind', async () => {
    const one = db(1)
    expect(await hasSiteAccess(one as never, 'site-1', 'wp')).toBe(true)
    expect(one.asked).toEqual([{ where: { siteId: 'site-1', kind: 'wp' } }])
  })

  it('is not there without a row, nor with two of them, as the content resolver refuses both', async () => {
    expect(await hasSiteAccess(db(0) as never, 'site-1', 'wp')).toBe(false)
    expect(await hasSiteAccess(db(2) as never, 'site-1', 'wp')).toBe(false)
  })
})

describe('the access of the content plugin of a stack', () => {
  it("is the content adapter's where the stack has one", () => {
    expect(contentAccessKindOf('wordpress')).toBe(getSiteContentAdapter('wordpress').accessKind)
  })

  it('is none where the stack has no published content (Т8)', () => {
    // Bitrix has no content adapter: no plugin, not an error.
    expect(contentAccessKindOf('bitrix')).toBeNull()
  })

  it('does not take another failure of the registry for a stack without a plugin', () => {
    // A stack the database holds as a plain string the registry does not know.
    expect(() => contentAccessKindOf('drupal' as never)).toThrow(/Unknown site stack/)
  })
})
