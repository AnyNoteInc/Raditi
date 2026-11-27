import { randomUUID } from 'node:crypto'

import type { SecretStore } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { SkillSecrets } from './skill-secrets.ts'

const workspaceId = randomUUID()

/** A Vault whose reads wait until the test lets them answer. */
function vault() {
  const answers: Array<(value: Awaited<ReturnType<SecretStore['kvRead']>>) => void> = []
  const kvRead = vi.fn<SecretStore['kvRead']>(
    () =>
      new Promise((resolve) => {
        answers.push(resolve)
      }),
  )
  const answer = (value: string, version = 1) =>
    answers.shift()!({ data: { value }, version } as Awaited<ReturnType<SecretStore['kvRead']>>)
  return { kvRead, answer }
}

describe('the secrets of MCP servers', () => {
  it('reads Vault once for the calls that miss together, and keeps what it read', async () => {
    const { kvRead, answer } = vault()
    const secrets = new SkillSecrets({ kvRead })
    const reads = Promise.all([
      secrets.read(workspaceId, 'crm'),
      secrets.read(workspaceId, 'crm'),
      secrets.read(workspaceId, 'crm'),
    ])
    expect(kvRead).toHaveBeenCalledTimes(1)
    answer('synthetic-header-value-1')
    const [first, ...others] = await reads
    expect(first).toEqual({ secret: { value: 'synthetic-header-value-1' }, version: 1 })
    for (const other of others) expect(other).toEqual(first)
    expect(await secrets.read(workspaceId, 'crm')).toEqual(first)
    expect(kvRead).toHaveBeenCalledTimes(1)
    // Another server is another read.
    const other = secrets.read(workspaceId, 'mail')
    expect(kvRead).toHaveBeenCalledTimes(2)
    answer('synthetic-header-value-2')
    expect((await other)?.secret).toEqual({ value: 'synthetic-header-value-2' })
  })

  it('keeps nothing of a read the key was forgotten during, and reads again after it', async () => {
    const { kvRead, answer } = vault()
    const secrets = new SkillSecrets({ kvRead })
    const stale = secrets.read(workspaceId, 'crm')
    secrets.forget(workspaceId, 'crm')
    const fresh = secrets.read(workspaceId, 'crm')
    expect(kvRead).toHaveBeenCalledTimes(2)
    answer('synthetic-header-old', 1)
    answer('synthetic-header-new', 2)
    expect((await stale)?.version).toBe(1)
    expect((await fresh)?.version).toBe(2)
    expect((await secrets.read(workspaceId, 'crm'))?.version).toBe(2)
    expect(kvRead).toHaveBeenCalledTimes(2)
  })

  it('lets the next call read again after a failed read', async () => {
    const kvRead = vi
      .fn<SecretStore['kvRead']>()
      .mockRejectedValueOnce(new Error('synthetic vault outage'))
      .mockResolvedValueOnce({ data: { value: 'synthetic-header-value' }, version: 3 } as Awaited<
        ReturnType<SecretStore['kvRead']>
      >)
    const secrets = new SkillSecrets({ kvRead })
    await expect(secrets.read(workspaceId, 'crm')).rejects.toThrow('synthetic vault outage')
    expect((await secrets.read(workspaceId, 'crm'))?.version).toBe(3)
  })
})
