import { emptySiteStackFacts, siteStackFactsOf, siteStackFactsSchema } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { mergeSiteStackFacts } from './site-stack-facts.ts'

const databaseUrl = process.env.DATABASE_URL
const SITE = '0199a000-0000-7000-8000-000000000001'

/**
 * Every key at its longest, in the characters that cost the most bytes in the text of a jsonb:
 * `"` is escaped to two, U+4E00 takes three. `extras` stop just under their own bound.
 */
function largestStackFacts() {
  const wide = '\u4e00'
  const extras: Record<string, string> = {}
  for (let index = 0; ; index += 1) {
    const next = {
      ...extras,
      [`${wide.repeat(30)}${String(index).padStart(2, '0')}`]: wide.repeat(256),
    }
    if (!siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, extras: next }).success) break
    Object.assign(extras, next)
  }
  extras.q = '"'.repeat(256)
  while (!siteStackFactsSchema.safeParse({ ...emptySiteStackFacts, extras }).success) {
    if (extras.q === '') {
      delete extras.q
      break
    }
    extras.q = extras.q.slice(1)
  }
  return {
    cmsVersion: `${'9'.repeat(19)}.${'z'.repeat(12)}`,
    generation: 'g'.repeat(16),
    publicGeneration: 'p'.repeat(16),
    limit: 'encoding_unsupported' as const,
    phpSeen: '1234.567',
    adminPath: `/${'a'.repeat(64)}/`,
    extras,
    probe: {
      status: 'no_database' as const,
      php: '1234.567',
      reason: wide.repeat(48),
      at: '2026-11-07T10:00:00.123456789Z',
    },
  }
}

describe('mergeSiteStackFacts input', () => {
  it('sends no query for an empty part', async () => {
    const $executeRaw = vi.fn()
    await mergeSiteStackFacts({ $executeRaw }, SITE, {})
    await mergeSiteStackFacts({ $executeRaw }, SITE, { cmsVersion: undefined })
    expect($executeRaw).not.toHaveBeenCalled()
  })

  it('refuses a part of another shape and a malformed site before querying', async () => {
    const $executeRaw = vi.fn()
    const refused = { code: 'BAD_REQUEST' }
    await expect(
      mergeSiteStackFacts({ $executeRaw }, SITE, { cmsVersion: '5.4\nignore' }),
    ).rejects.toMatchObject(refused)
    await expect(
      // @ts-expect-error -- the writer adds the version of the record itself
      mergeSiteStackFacts({ $executeRaw }, SITE, { v: 1 }),
    ).rejects.toMatchObject(refused)
    await expect(
      mergeSiteStackFacts({ $executeRaw }, 'bad', { cmsVersion: '5.4.10' }),
    ).rejects.toMatchObject(refused)
    expect($executeRaw).not.toHaveBeenCalled()
  })

  // Both pass a schema of strings alone and fail in PostgreSQL: the check of 4096 bytes (23514)
  // and the jsonb cast of `\u0000` (22P05) — a bare driver error would abort the writer's
  // transaction instead of a refusal.
  it.each([
    [
      'extras larger than the record holds',
      { extras: Object.fromEntries(['a', 'b', 'c'].map((key) => [key, '\u0001'.repeat(256)])) },
    ],
    [
      'fifteen keys of extras of 256 characters',
      {
        extras: Object.fromEntries(
          Array.from({ length: 15 }, (_, index) => [`key${index}`, 'x'.repeat(256)]),
        ),
      },
    ],
    ['a NUL in extras', { extras: { prefix: 'jos_\u0000' } }],
    [
      'a NUL in the reason of the probe',
      {
        probe: {
          status: 'failed' as const,
          php: null,
          reason: 'x\u0000',
          at: '2026-11-07T10:00:00.000Z',
        },
      },
    ],
  ])('refuses %s before querying', async (_, patch) => {
    const $executeRaw = vi.fn()
    await expect(mergeSiteStackFacts({ $executeRaw }, SITE, patch)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect($executeRaw).not.toHaveBeenCalled()
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL facts of a site', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = workspaces.splice(0)
    await db.site.deleteMany({ where: { workspaceId: { in: ids } } })
    await db.workspace.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function site() {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic facts verification', dataClass: 'synthetic' },
    })
    workspaces.push(workspace.id)
    const created = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Facts test',
        url: `https://${workspace.id}.invalid`,
        stack: 'wordpress',
      },
    })
    return created.id
  }

  async function factsOf(siteId: string) {
    const row = await db.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { stackFacts: true, updatedAt: true },
    })
    return { facts: siteStackFactsOf(row.stackFacts), updatedAt: row.updatedAt }
  }

  it('reads a new site as the empty record', async () => {
    const siteId = await site()
    expect((await factsOf(siteId)).facts).toEqual(emptySiteStackFacts)
  })

  it('keeps both parts written one after another', async () => {
    const siteId = await site()
    // Prisma sets `updatedAt` only on its own writes: a raw query keeps it unless it sets it.
    const before = new Date('2020-01-01T00:00:00Z')
    await db.site.update({ where: { id: siteId }, data: { updatedAt: before } })
    await mergeSiteStackFacts(db, siteId, { cmsVersion: '5.4.10', generation: 'j5' })
    await mergeSiteStackFacts(db, siteId, { phpSeen: '8.3', adminPath: '/administrator/' })
    const { facts, updatedAt } = await factsOf(siteId)
    expect(facts).toEqual({
      ...emptySiteStackFacts,
      cmsVersion: '5.4.10',
      generation: 'j5',
      phpSeen: '8.3',
      adminPath: '/administrator/',
    })
    expect(updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('leaves the row untouched for an empty part', async () => {
    const siteId = await site()
    const before = new Date('2020-01-01T00:00:00Z')
    await db.site.update({ where: { id: siteId }, data: { updatedAt: before } })
    await mergeSiteStackFacts(db, siteId, {})
    expect((await factsOf(siteId)).updatedAt).toEqual(before)
  })

  it('writes the largest record the schema takes', async () => {
    const siteId = await site()
    await mergeSiteStackFacts(db, siteId, largestStackFacts())
    expect((await factsOf(siteId)).facts).toEqual({ v: 1, ...largestStackFacts() })
  })

  it('replaces the extras of the first part with those of the second', async () => {
    const siteId = await site()
    await mergeSiteStackFacts(db, siteId, { extras: { prefix: 'jos_', secretWord: 'x' } })
    await mergeSiteStackFacts(db, siteId, { extras: { prefix: 'oc_' } })
    expect((await factsOf(siteId)).facts.extras).toEqual({ prefix: 'oc_' })
  })

  it('writes a value back to null', async () => {
    const siteId = await site()
    await mergeSiteStackFacts(db, siteId, { limit: 'outside_root' })
    await mergeSiteStackFacts(db, siteId, { limit: null })
    expect((await factsOf(siteId)).facts.limit).toBeNull()
  })
})
