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
  email: 'site-skills-test@example.ru',
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
type Row = { name: string; url: string | null; enabled: boolean }

function setup(role: string | null = 'owner', rows: Row[] = []) {
  const audits: unknown[] = []
  const writes: unknown[] = []
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    site: {
      findFirst: vi
        .fn<(args: unknown) => Promise<unknown>>()
        .mockImplementation(async () => ({ id: siteId, workspaceId, agentSkills: rows })),
    },
    member: {
      findUnique: vi.fn().mockResolvedValue(role ? { role } : null),
      findFirst: vi.fn().mockResolvedValue(role ? { role } : null),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        siteAgentSkill: {
          upsert: async (args: unknown) => writes.push(['upsert', args]),
          create: async (args: unknown) => writes.push(['create', args]),
          delete: async (args: unknown) => writes.push(['delete', args]),
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
      token: 'site-skills-test-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
    },
    billing: null,
  }
  return { db, audits, writes, caller: createCaller(context) }
}

describe('siteAgentSkills', () => {
  it('shows the platform skills on by default, then the added ones by name', async () => {
    const { caller } = setup('member', [
      { name: 'zeta', url: 'https://zeta.example.org/mcp', enabled: false },
      { name: 'context7', url: null, enabled: false },
      { name: 'alpha', url: 'https://alpha.example.org/mcp', enabled: true },
    ])
    const view = await caller.siteAgentSkills.list({ siteId })
    expect(view.canManage).toBe(false)
    expect(view.addable).toBe(6)
    expect(view.skills.map(({ name, builtin, enabled }) => [name, builtin, enabled])).toEqual([
      ['context7', true, false],
      ['playwright', true, true],
      ['alpha', false, true],
      ['zeta', false, false],
    ])
    expect(view.skills[1]).toMatchObject({ title: 'Playwright', url: null })
  })

  it('switches a platform skill with a row of its own, and audits it', async () => {
    const { audits, writes, caller } = setup()
    const view = await caller.siteAgentSkills.switch({ siteId, name: 'playwright', enabled: false })
    expect(view.canManage).toBe(true)
    expect(writes).toEqual([
      [
        'upsert',
        {
          where: { siteId_name: { siteId, name: 'playwright' } },
          create: { siteId, name: 'playwright', url: null, enabled: false },
          update: { enabled: false },
        },
      ],
    ])
    expect(audits).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'site.agent_skill.switch',
          meta: { name: 'playwright', enabled: false },
        }),
      }),
    ])
  })

  it('adds a remote skill by its kept address, and refuses anything secret or private', async () => {
    const { writes, caller } = setup()
    await caller.siteAgentSkills.add({
      siteId,
      name: ' Docs ',
      url: ' https://Docs.Example.org/mcp ',
    })
    expect(writes).toEqual([
      ['create', { data: { siteId, name: 'docs', url: 'https://docs.example.org/mcp' } }],
    ])
    for (const url of [
      'http://docs.example.org/mcp',
      'https://docs.example.org/mcp?api_key=1',
      'https://user:pw@docs.example.org/mcp',
      'https://10.0.0.1/mcp',
      'https://vault.internal/mcp',
    ])
      await expect(
        caller.siteAgentSkills.add({ siteId, name: 'other', url }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    for (const name of ['raditi-docs', 'my_docs', ''])
      await expect(
        caller.siteAgentSkills.add({ siteId, name, url: 'https://docs.example.org/mcp' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.siteAgentSkills.add({ siteId, name: 'context7', url: 'https://docs.example.org/mcp' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(writes).toHaveLength(1)
  })

  it('keeps the number of added skills bounded and their names unique', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      name: `s${index}`,
      url: `https://s${index}.example.org/mcp`,
      enabled: true,
    }))
    const { writes, caller } = setup('admin', rows)
    expect((await caller.siteAgentSkills.list({ siteId })).addable).toBe(0)
    await expect(
      caller.siteAgentSkills.add({ siteId, name: 'more', url: 'https://more.example.org/mcp' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.siteAgentSkills.add({ siteId, name: 's1', url: 'https://more.example.org/mcp' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(writes).toEqual([])
  })

  it('removes an added skill, never a platform one', async () => {
    const { writes, caller } = setup('owner', [
      { name: 'docs', url: 'https://docs.example.org/mcp', enabled: true },
    ])
    await caller.siteAgentSkills.remove({ siteId, name: 'docs' })
    expect(writes).toEqual([['delete', { where: { siteId_name: { siteId, name: 'docs' } } }]])
    await expect(caller.siteAgentSkills.remove({ siteId, name: 'context7' })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      },
    )
    await expect(caller.siteAgentSkills.remove({ siteId, name: 'nothing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      caller.siteAgentSkills.switch({ siteId, name: 'nothing', enabled: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lets only an owner or an admin change them', async () => {
    const { writes, caller } = setup('member')
    await expect(
      caller.siteAgentSkills.switch({ siteId, name: 'context7', enabled: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.siteAgentSkills.add({ siteId, name: 'docs', url: 'https://docs.example.org/mcp' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(writes).toEqual([])
  })
})
