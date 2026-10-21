import { describe, expect, it, vi } from 'vitest'

import { readSiteEnvValues, readSiteEnvValuesToRefuse } from './site-env-values.ts'

const SITE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'

describe('the values of a site’s variables (plan 53, Р13)', () => {
  it('reads each at the version its row names and leaves out what is not there', async () => {
    const stored: Record<string, { data: Record<string, string>; version: number }> = {
      [`kv/sites/${SITE}/env/PAYMENT_KEY`]: { data: { value: 'pay-secret-0001' }, version: 2 },
      [`kv/sites/${SITE}/env/NEWER_KEY`]: { data: { value: 'newer-value-0003' }, version: 3 },
      [`kv/sites/${SITE}/env/REMOVED_KEY`]: {
        data: { removed: '2026-10-17T10:00:00.000Z' },
        version: 4,
      },
      [`kv/sites/${SITE}/env/SHORT_KEY`]: { data: { value: 'short' }, version: 1 },
    }
    const kvRead = vi.fn(async (path: string) => stored[path] ?? null)
    expect(
      await readSiteEnvValues({ kvRead }, SITE, [
        { name: 'PAYMENT_KEY', keyVersion: 2 },
        // Written after the row: the row's version is not there any more.
        { name: 'NEWER_KEY', keyVersion: 2 },
        { name: 'REMOVED_KEY', keyVersion: 4 },
        { name: 'SHORT_KEY', keyVersion: 1 },
        { name: 'MISSING_KEY', keyVersion: 1 },
        // A name the platform reserves is never read, whatever a row says.
        { name: 'LD_PRELOAD', keyVersion: 1 },
      ]),
    ).toEqual({ PAYMENT_KEY: 'pay-secret-0001' })
    expect(kvRead.mock.calls.map(([path]) => path)).not.toContain(`kv/sites/${SITE}/env/LD_PRELOAD`)
  })

  it('refuses the values Vault holds now, whatever version a row names', async () => {
    const stored: Record<string, { data: Record<string, string>; version: number }> = {
      [`kv/sites/${SITE}/env/PAYMENT_KEY`]: { data: { value: 'pay-secret-0001' }, version: 2 },
      [`kv/sites/${SITE}/env/NEWER_KEY`]: { data: { value: 'newer-value-0003' }, version: 3 },
      [`kv/sites/${SITE}/env/REMOVED_KEY`]: {
        data: { removed: '2026-10-17T10:00:00.000Z' },
        version: 4,
      },
    }
    const kvRead = vi.fn(async (path: string) => stored[path] ?? null)
    expect(
      await readSiteEnvValuesToRefuse({ kvRead }, SITE, [
        'PAYMENT_KEY',
        'NEWER_KEY',
        'NEWER_KEY',
        'REMOVED_KEY',
        'MISSING_KEY',
        'LD_PRELOAD',
      ]),
    ).toEqual(['pay-secret-0001', 'newer-value-0003'])
    expect(kvRead).toHaveBeenCalledTimes(4)
  })
})
