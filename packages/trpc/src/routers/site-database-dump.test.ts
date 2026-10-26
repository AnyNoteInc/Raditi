import { randomUUID } from 'node:crypto'

import type { PrismaClient, User } from '@repo/db'
import { legalDocuments } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import type { Context } from '../trpc.ts'

const now = new Date('2026-10-26T09:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна',
  lastName: null,
  email: 'site-dump-test@example.ru',
  emailVerified: true,
  image: null,
  createdAt: now,
  updatedAt: now,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const siteId = randomUUID()
const workspaceId = randomUUID()
const site = (overrides: Record<string, unknown> = {}) => ({
  id: siteId,
  workspaceId,
  codeSource: { kind: 'ftp' },
  database: null,
  databaseDump: null,
  ...overrides,
})

function setup(role: string | null = 'owner') {
  const audits: unknown[] = []
  const writes: unknown[] = []
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: { findFirst: vi.fn<(args: unknown) => Promise<unknown>>().mockResolvedValue(site()) },
    member: {
      findUnique: vi.fn().mockResolvedValue(role ? { role } : null),
      findFirst: vi.fn().mockResolvedValue(role ? { role } : null),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        siteDatabaseDump: {
          upsert: async (args: unknown) => writes.push(['upsert', args]),
          deleteMany: async (args: unknown) => writes.push(['delete', args]),
        },
        auditLog: { create: async (args: unknown) => audits.push(args) },
      }),
  }
  const context: Context = {
    prisma: db as unknown as PrismaClient,
    headers: new Headers(),
    user,
    session: {
      id: randomUUID(),
      userId: user.id,
      token: 'site-dump-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
  }
  return { db, audits, writes, caller: createCaller(context) }
}

describe('siteDatabaseDump', () => {
  it('tells whether a dump is named and whether the site has a source to read it through', async () => {
    const { db, caller } = setup()
    expect(await caller.siteDatabaseDump.get({ siteId })).toEqual({
      path: null,
      updatedAt: null,
      readable: true,
      liveDatabase: false,
    })
    db.site.findFirst.mockResolvedValue(site({ codeSource: null }))
    expect((await caller.siteDatabaseDump.get({ siteId })).readable).toBe(false)
    db.site.findFirst.mockResolvedValue(null)
    await expect(caller.siteDatabaseDump.get({ siteId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('records the file the owner named, and the change in the audit log', async () => {
    const { audits, writes, caller } = setup()
    await caller.siteDatabaseDump.set({ siteId, path: ' backup-2026-08-30.sql ' })
    expect(writes).toEqual([
      [
        'upsert',
        {
          where: { siteId },
          create: { siteId, path: 'backup-2026-08-30.sql' },
          update: { path: 'backup-2026-08-30.sql' },
        },
      ],
    ])
    expect(audits).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'site.database_dump.set',
          meta: { path: 'backup-2026-08-30.sql' },
        }),
      }),
    ])
  })

  it('forgets the dump on null', async () => {
    const { writes, caller } = setup()
    await caller.siteDatabaseDump.set({ siteId, path: null })
    expect(writes).toEqual([['delete', { where: { siteId } }]])
  })

  it('refuses a path out of the login folder, another file and a site without a file source', async () => {
    const { db, writes, caller } = setup()
    for (const path of ['../backup.sql', '/backup.sql', 'backup.sql.CORRUPTED-DO-NOT-RESTORE'])
      await expect(caller.siteDatabaseDump.set({ siteId, path })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      })
    db.site.findFirst.mockResolvedValue(site({ codeSource: { kind: 'git' } }))
    await expect(caller.siteDatabaseDump.set({ siteId, path: 'backup.sql' })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    )
    expect(writes).toEqual([])
  })

  it('lets only an owner or an admin name it', async () => {
    const { writes, caller } = setup('member')
    await expect(caller.siteDatabaseDump.set({ siteId, path: 'backup.sql' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    )
    expect(writes).toEqual([])
  })
})
