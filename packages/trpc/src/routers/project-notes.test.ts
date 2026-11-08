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
  email: 'site-notes-test@example.ru',
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

// The notes of a project change only by `project.setAgentNotes` (docs/plan/61-chats-first.md, К31):
// an owner or an admin, with what they saw and left in the field.
function setup(
  role: string | null = 'owner',
  site: { agentNotes: string | null } | null = { agentNotes: null },
) {
  const audits: unknown[] = []
  const writes: unknown[] = []
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: {
      findFirst: vi
        .fn<(args: unknown) => Promise<unknown>>()
        .mockImplementation(async () => (site ? { id: siteId, workspaceId, ...site } : null)),
    },
    member: {
      findUnique: vi.fn().mockResolvedValue(role ? { role } : null),
      findFirst: vi.fn().mockResolvedValue(role ? { role } : null),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        site: {
          updateMany: async (args: unknown) => {
            writes.push(args)
            return { count: 1 }
          },
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
      token: 'site-notes-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
  }
  return { audits, writes, caller: createCaller(context) }
}

describe('the notes of a project', () => {
  it('reads them for every member, and says who may change them', async () => {
    const standing = { agentNotes: 'Вход по адресу /login' }
    expect(await setup('member', standing).caller.project.agentNotes({ id: siteId })).toEqual({
      notes: 'Вход по адресу /login',
      canManage: false,
    })
    for (const role of ['owner', 'admin'])
      expect((await setup(role).caller.project.agentNotes({ id: siteId })).canManage).toBe(true)
  })

  it('saves what the client left, trimmed, and audits it without the text', async () => {
    const { audits, writes, caller } = setup('admin')
    const notes = 'Тема лежит в wp-content/themes/shop'
    expect(
      await caller.project.setAgentNotes({ id: siteId, notes: `  ${notes}\n`, seen: null }),
    ).toEqual({ notes })
    expect(writes).toEqual([
      { where: { id: siteId, agentNotes: null }, data: { agentNotes: notes } },
    ])
    expect(audits).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'site.agent_notes.change',
          actorId: user.id,
          targetId: siteId,
          meta: { cleared: false },
        }),
      }),
    ])
    expect(JSON.stringify(audits)).not.toContain('wp-content')
  })

  it('clears them when the field is left empty', async () => {
    const { audits, writes, caller } = setup('owner', { agentNotes: 'Старые подсказки' })
    const seen = 'Старые подсказки'
    expect(await caller.project.setAgentNotes({ id: siteId, notes: ' \n ', seen })).toEqual({
      notes: null,
    })
    expect(writes).toEqual([
      { where: { id: siteId, agentNotes: seen }, data: { agentNotes: null } },
    ])
    expect(audits).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ meta: { cleared: true } }) }),
    ])
  })

  it('lets only an owner or an admin change them', async () => {
    const { audits, writes, caller } = setup('member')
    await expect(
      caller.project.setAgentNotes({ id: siteId, notes: 'Подсказка', seen: null }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: { code: 'PROJECT_NOTES_NOT_ALLOWED' },
    })
    expect(writes).toEqual([])
    expect(audits).toEqual([])
  })

  it('answers about a site of another as about one that does not exist', async () => {
    const { writes, caller } = setup('owner', null)
    await expect(caller.project.agentNotes({ id: siteId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      caller.project.setAgentNotes({ id: siteId, notes: 'Подсказка', seen: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(writes).toEqual([])
  })

  it('refuses what the checks of a note refuse, and writes nothing', async () => {
    const { writes, caller } = setup()
    await expect(
      caller.project.setAgentNotes({ id: siteId, notes: 'а'.repeat(2001), seen: null }),
    ).rejects.toMatchObject({ cause: { code: 'PROJECT_NOTES_TOO_LONG' } })
    await expect(
      caller.project.setAgentNotes({
        id: siteId,
        notes: 'логин admin, пароль: Qwerty123456',
        seen: null,
      }),
    ).rejects.toMatchObject({ cause: { code: 'PROJECT_NOTES_HAS_SECRET' } })
    expect(writes).toEqual([])
  })

  it('takes the answer of the agent about code, with names of files in it', async () => {
    const { writes, caller } = setup()
    const notes = 'Шапка — `Header.php`, начните с `README.md`, `useState()` в `ProductCard.tsx`.'
    expect(await caller.project.setAgentNotes({ id: siteId, notes, seen: null })).toEqual({ notes })
    expect(writes).toHaveLength(1)
  })
})
