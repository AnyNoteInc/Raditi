import type { Prisma, PrismaClient } from '@repo/db'
import { conflict, type SecretStore, type TurnCredentialRef } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { turnCredentialPath } from './turn-key.ts'
import { revokeTurnCredentials } from './turn-revocation.ts'

const ref: TurnCredentialRef = {
  taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sessionId: 'synthetic-session',
  turn: 2,
  epoch: 3,
}

function fixture() {
  const steps: string[] = []
  const text = (query: TemplateStringsArray) => query.join('?')
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      const sql = text(query)
      steps.push(
        sql.includes('site_leases')
          ? 'lease lock'
          : sql.includes('set_config')
            ? 'bounds'
            : 'key lock',
      )
      return []
    }),
    $executeRaw: vi.fn(async (query: TemplateStringsArray) => {
      steps.push(text(query).includes('WITH marker AS') ? 'fence' : 'close')
      return 1
    }),
  }
  const prisma = {
    $transaction: vi.fn(async (work: (db: Prisma.TransactionClient) => Promise<unknown>) =>
      work(tx as unknown as Prisma.TransactionClient),
    ),
  } as unknown as Pick<PrismaClient, '$transaction'>
  const secrets = {
    kvDelete: vi.fn(async (path: string) => {
      steps.push(`delete ${path}`)
    }),
    kvDestroyAll: vi.fn(async (path: string) => {
      steps.push(`destroy ${path}`)
    }),
  } satisfies Pick<SecretStore, 'kvDelete' | 'kvDestroyAll'>
  return { prisma, secrets, steps }
}

describe('revocation of a turn key', () => {
  it('closes admission under the site lease before Vault and destroys the value last', async () => {
    const f = fixture()
    await revokeTurnCredentials(f, ref)
    const path = turnCredentialPath(ref)
    expect(f.steps).toEqual([
      'bounds',
      'lease lock',
      'fence',
      `delete ${path}`,
      'bounds',
      'key lock',
      'close',
      `destroy ${path}`,
    ])
  })

  it('leaves the durable fence when Vault fails and answers with an unavailable gateway', async () => {
    const f = fixture()
    f.secrets.kvDelete.mockRejectedValueOnce(new Error('token=private-vault-body'))
    await expect(revokeTurnCredentials(f, ref)).rejects.toMatchObject({
      code: 'LLM_GATEWAY_UNAVAILABLE',
      message: 'Subscription gateway is unavailable',
    })
    expect(f.steps).toEqual(['bounds', 'lease lock', 'fence'])
    expect(f.secrets.kvDestroyAll).not.toHaveBeenCalled()
  })

  it('passes a refusal of the domain through as it is', async () => {
    const f = fixture()
    f.secrets.kvDestroyAll.mockRejectedValueOnce(conflict('Synthetic refusal'))
    await expect(revokeTurnCredentials(f, ref)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Synthetic refusal',
    })
  })

  it('refuses a malformed reference before any SQL or Vault call', async () => {
    const f = fixture()
    await expect(revokeTurnCredentials(f, { ...ref, taskId: 'not-a-task' })).rejects.toThrow()
    expect(f.prisma.$transaction).not.toHaveBeenCalled()
    expect(f.steps).toEqual([])
  })
})
