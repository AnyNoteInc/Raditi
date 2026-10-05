import { siteAccessPath } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { activateSite } from './site-activation.ts'

const databaseUrl = process.env.DATABASE_URL
const SITE = '0199a000-0000-7000-8000-000000000001'

describe('site activation input validation', () => {
  it('rejects a malformed site, an empty, unknown or repeated access list before querying', async () => {
    const $queryRaw = vi.fn()
    const db = { $queryRaw }
    const refused = { code: 'BAD_REQUEST', httpStatus: 400 }
    await expect(activateSite(db, { siteId: 'bad', requiredAccess: ['wp'] })).rejects.toMatchObject(
      refused,
    )
    await expect(activateSite(db, { siteId: SITE, requiredAccess: [] })).rejects.toMatchObject(
      refused,
    )
    await expect(
      // @ts-expect-error -- a kind that is not an access of a site
      activateSite(db, { siteId: SITE, requiredAccess: ['subscription'] }),
    ).rejects.toMatchObject(refused)
    await expect(
      activateSite(db, { siteId: SITE, requiredAccess: ['wp', 'wp'] }),
    ).rejects.toMatchObject(refused)
    expect($queryRaw).not.toHaveBeenCalled()
  })

  it('answers with a domain error when the database returns a malformed row', async () => {
    const db = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { status: 'onboarding', access: ['unknown'], repository: true, activated: false },
        ]),
    }
    await expect(activateSite(db, { siteId: SITE, requiredAccess: ['wp'] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL site activation', () => {
  let db: PrismaClient
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    // One test may point a reference of one workspace at a site of another: references first.
    const ids = workspaces.splice(0)
    const sites = { workspaceId: { in: ids } }
    await db.gitRepository.deleteMany({ where: { site: sites } })
    await db.credentialRef.deleteMany({ where: { OR: [sites, { site: sites }] } })
    await db.site.deleteMany({ where: sites })
    await db.workspace.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function workspace() {
    const created = await db.workspace.create({
      data: { name: 'Synthetic activation verification', dataClass: 'synthetic' },
    })
    workspaces.push(created.id)
    return created.id
  }

  async function onboardingSite() {
    const workspaceId = await workspace()
    const site = await db.site.create({
      data: {
        workspaceId,
        name: 'Activation test',
        url: 'http://localhost:8080',
        stack: 'wordpress',
      },
    })
    expect(site.status).toBe('onboarding')
    return { siteId: site.id, workspaceId }
  }

  const access = (
    site: { siteId: string; workspaceId: string },
    kind: 'wp' | 'ssh' = 'wp',
    data: { vaultPath?: string; keyVersion?: number; workspaceId?: string } = {},
  ) =>
    db.credentialRef.create({
      data: {
        kind,
        siteId: site.siteId,
        workspaceId: data.workspaceId ?? site.workspaceId,
        vaultPath: data.vaultPath ?? siteAccessPath(site.siteId, kind),
        keyVersion: data.keyVersion ?? 1,
      },
    })

  const repository = (site: { siteId: string }) =>
    db.gitRepository.create({
      data: {
        siteId: site.siteId,
        provider: 'gitea',
        owner: 'sites',
        name: `site-${site.siteId}`,
        url: `https://127.0.0.1:3300/sites/site-${site.siteId}`,
      },
    })

  const status = async (siteId: string) =>
    (await db.site.findUniqueOrThrow({ where: { id: siteId } })).status

  it('moves an onboarding site with its access and repository to active, once', async () => {
    const site = await onboardingSite()
    await access(site)
    await repository(site)
    const input = { siteId: site.siteId, requiredAccess: ['wp'] as const }
    expect(await activateSite(db, input)).toEqual({ status: 'activated' })
    expect(await status(site.siteId)).toBe('active')
    // A repeated connection is not an error and changes nothing.
    const before = await db.site.findUniqueOrThrow({ where: { id: site.siteId } })
    expect(await activateSite(db, input)).toEqual({ status: 'already_active' })
    const after = await db.site.findUniqueOrThrow({ where: { id: site.siteId } })
    expect(after.updatedAt).toEqual(before.updatedAt)
  })

  it('lets exactly one of concurrent activations win', async () => {
    const site = await onboardingSite()
    await access(site)
    await repository(site)
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        activateSite(db, { siteId: site.siteId, requiredAccess: ['wp'] }),
      ),
    )
    expect(results.filter((result) => result.status === 'activated')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'already_active')).toHaveLength(7)
  })

  it('refuses a site without the access its adapter names', async () => {
    const site = await onboardingSite()
    await repository(site)
    expect(await activateSite(db, { siteId: site.siteId, requiredAccess: ['wp'] })).toEqual({
      status: 'refused',
      reason: 'access',
      access: ['wp'],
    })
    // Another kind of access does not stand in for the named one.
    await access(site, 'ssh')
    expect(await activateSite(db, { siteId: site.siteId, requiredAccess: ['wp', 'ssh'] })).toEqual({
      status: 'refused',
      reason: 'access',
      access: ['wp'],
    })
    expect(await status(site.siteId)).toBe('onboarding')
  })

  it('refuses a reference the reader of the access would not follow', async () => {
    const input = (siteId: string) => ({ siteId, requiredAccess: ['wp'] as const })
    const refused = { status: 'refused', reason: 'access', access: ['wp'] }

    const elsewhere = await onboardingSite()
    await repository(elsewhere)
    await access(elsewhere, 'wp', { vaultPath: `kv/sites/${SITE}/wp` })
    expect(await activateSite(db, input(elsewhere.siteId))).toEqual(refused)

    const unwritten = await onboardingSite()
    await repository(unwritten)
    await access(unwritten, 'wp', { keyVersion: 0 })
    expect(await activateSite(db, input(unwritten.siteId))).toEqual(refused)

    const foreign = await onboardingSite()
    await repository(foreign)
    await access(foreign, 'wp', { workspaceId: await workspace() })
    expect(await activateSite(db, input(foreign.siteId))).toEqual(refused)

    // Two rows of one kind: the reader takes neither.
    const doubled = await onboardingSite()
    await repository(doubled)
    await access(doubled)
    await access(doubled, 'wp', { vaultPath: `kv/sites/${doubled.siteId}/wp-old` })
    expect(await activateSite(db, input(doubled.siteId))).toEqual(refused)

    for (const site of [elsewhere, unwritten, foreign, doubled])
      expect(await status(site.siteId)).toBe('onboarding')
  })

  it('refuses a site without a repository', async () => {
    const site = await onboardingSite()
    await access(site)
    expect(await activateSite(db, { siteId: site.siteId, requiredAccess: ['wp'] })).toEqual({
      status: 'refused',
      reason: 'repository',
    })
    expect(await status(site.siteId)).toBe('onboarding')
  })

  it('activates only from onboarding and never finds a missing site', async () => {
    for (const from of ['paused', 'disconnected', 'archived'] as const) {
      const site = await onboardingSite()
      await access(site)
      await repository(site)
      await db.site.update({ where: { id: site.siteId }, data: { status: from } })
      expect(await activateSite(db, { siteId: site.siteId, requiredAccess: ['wp'] })).toEqual({
        status: 'refused',
        reason: 'status',
      })
      expect(await status(site.siteId)).toBe(from)
    }
    expect(await activateSite(db, { siteId: SITE, requiredAccess: ['wp'] })).toEqual({
      status: 'refused',
      reason: 'not_found',
    })
  })
})
