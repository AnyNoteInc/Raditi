import { describe, expect, it, vi } from 'vitest'

import { readWorkspaceEnvValues, readWorkspaceEnvValuesToRefuse } from './workspace-env-values.ts'

const WORKSPACE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const at = (name: string) => `kv/workspaces/${WORKSPACE}/env/${name}`

describe('the values of a workspace’s variables (plan 83, БП4)', () => {
  it('reads each at the version its row names and leaves out what is not there', async () => {
    const stored: Record<string, { data: Record<string, string>; version: number }> = {
      [at('PAYMENT_KEY')]: { data: { value: 'pay-secret-0001' }, version: 2 },
      [at('NEWER_KEY')]: { data: { value: 'newer-value-0003' }, version: 3 },
      [at('REMOVED_KEY')]: { data: { removed: '2026-10-17T10:00:00.000Z' }, version: 4 },
      [at('EMPTY_KEY')]: { data: { value: '' }, version: 1 },
    }
    const kvRead = vi.fn(async (path: string) => stored[path] ?? null)
    expect(
      await readWorkspaceEnvValues({ kvRead }, WORKSPACE, [
        { name: 'PAYMENT_KEY', keyVersion: 2 },
        // Written after the row: the row's version is not there any more.
        { name: 'NEWER_KEY', keyVersion: 2 },
        { name: 'REMOVED_KEY', keyVersion: 4 },
        { name: 'EMPTY_KEY', keyVersion: 1 },
        { name: 'MISSING_KEY', keyVersion: 1 },
        // A name the platform reserves is never read, whatever a row says.
        { name: 'LD_PRELOAD', keyVersion: 1 },
      ]),
    ).toEqual({ PAYMENT_KEY: 'pay-secret-0001' })
    expect(kvRead.mock.calls.map(([path]) => path)).not.toContain(at('LD_PRELOAD'))
  })

  it('refuses the values Vault holds now, whatever version a row names', async () => {
    const stored: Record<string, { data: Record<string, string>; version: number }> = {
      [at('PAYMENT_KEY')]: { data: { value: 'pay-secret-0001' }, version: 2 },
      [at('NEWER_KEY')]: { data: { value: 'newer-value-0003' }, version: 3 },
      [at('REMOVED_KEY')]: { data: { removed: '2026-10-17T10:00:00.000Z' }, version: 4 },
    }
    const kvRead = vi.fn(async (path: string) => stored[path] ?? null)
    expect(
      await readWorkspaceEnvValuesToRefuse({ kvRead }, WORKSPACE, [
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
