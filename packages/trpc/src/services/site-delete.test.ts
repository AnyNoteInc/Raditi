import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { KvMetadata, KvWriteOptions } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { accessibleSite } from './site-basics.ts'
import { deleteSite, lockLiveSite, type SiteSecretEraser } from './site-delete.ts'

const now = new Date('2026-10-25T09:00:00Z')

/** Vault as the policy `sites-writer` sees it: versions by CAS, the history `maxVersions` keeps. */
function fakeVault() {
  const keys = new Map<string, { versions: Record<string, string>[]; maxVersions: number | null }>()
  const state = { refuse: false }
  const store: SiteSecretEraser = {
    kvMetadata: async (path): Promise<KvMetadata | null> => {
      const key = keys.get(path)
      if (!key) return null
      return {
        currentVersion: key.versions.length,
        custom: {},
        createdTime: now,
        deleted: false,
        destroyed: false,
      }
    },
    kvWrite: async (path, data, options?: KvWriteOptions) => {
      if (state.refuse) throw new Error('Vault is sealed')
      const key = keys.get(path) ?? { versions: [], maxVersions: null }
      if (options?.cas !== undefined && options.cas !== key.versions.length)
        throw new Error('check-and-set parameter did not match')
      if (options?.maxVersions !== undefined) key.maxVersions = options.maxVersions
      key.versions.push(data)
      keys.set(path, key)
      return { version: key.versions.length }
    },
  }
  /** The versions a reader could still get: the newest `maxVersions` of them. */
  const kept = (path: string) => {
    const key = keys.get(path)
    if (!key) return []
    return key.maxVersions === null ? key.versions : key.versions.slice(-key.maxVersions)
  }
  return {
    store,
    kept,
    state,
    put: (path: string, data: Record<string, string>) => store.kvWrite(path, data),
  }
}

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: «Удалить проект»', () => {
  let db: PrismaClient
  const userIds: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const ids = userIds.splice(0)
    const owned = { createdById: { in: ids } }
    const workspaces = await db.workspace.findMany({ where: owned, select: { id: true } })
    await db.auditLog.deleteMany({
      where: { workspaceId: { in: workspaces.map((workspace) => workspace.id) } },
    })
    await db.siteRelease.deleteMany({ where: { site: { workspace: owned } } })
    await db.task.deleteMany({ where: { workspace: owned } })
    await db.siteEnvVar.deleteMany({ where: { site: { workspace: owned } } })
    await db.credentialRef.deleteMany({ where: { workspace: owned } })
    await db.site.deleteMany({ where: { workspace: owned } })
    await db.workspace.deleteMany({ where: owned })
    await db.user.deleteMany({ where: { id: { in: ids } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person() {
    const created = await db.user.create({
      data: { name: 'Site deletion', email: `${randomUUID()}@site-delete.example.ru` },
    })
    userIds.push(created.id)
    return created.id
  }

  /** A site of an owner, with a member, two accesses and a variable written to the fake Vault. */
  async function siteWithSecrets(vault: ReturnType<typeof fakeVault>) {
    const owner = await person()
    const member = await person()
    const workspace = await db.workspace.create({
      data: {
        name: 'Мои проекты',
        createdById: owner,
        dataClass: 'synthetic',
        members: {
          create: [
            { userId: owner, role: 'owner' },
            { userId: member, role: 'member' },
          ],
        },
      },
    })
    const url = `https://${randomUUID()}.example.ru`
    const site = await db.site.create({
      data: { name: 'УКК ЖКХ', url, stack: 'wordpress', workspaceId: workspace.id },
    })
    for (const kind of ['ssh', 'db'] as const) {
      const vaultPath = `kv/sites/${site.id}/${kind}`
      await vault.put(vaultPath, { password: `synthetic-${kind}-1` })
      await vault.put(vaultPath, { password: `synthetic-${kind}-2` })
      await db.credentialRef.create({
        data: { kind, workspaceId: workspace.id, siteId: site.id, vaultPath, keyVersion: 2 },
      })
    }
    const variable = `kv/sites/${site.id}/env/DELIVERY_KEY`
    await vault.store.kvWrite(variable, { value: 'synthetic-value' }, { cas: 0, maxVersions: 1 })
    await db.siteEnvVar.create({
      data: { siteId: site.id, name: 'DELIVERY_KEY', hosts: [], keyVersion: 1, createdBy: owner },
    })
    return { owner, member, workspaceId: workspace.id, siteId: site.id, url }
  }

  const input = (userId: string, siteId: string, confirmName = 'УКК ЖКХ') => ({
    userId,
    siteId,
    confirmName,
    ip: null,
    now,
  })

  it('hides the site, keeps its history, frees its address and erases its secrets', async () => {
    const vault = fakeVault()
    const { owner, workspaceId, siteId, url } = await siteWithSecrets(vault)
    const done = await db.task.create({ data: { workspaceId, siteId, status: 'done' } })
    // The secret of a kind «Изменить доступ» replaced: no reference names it any more.
    await vault.put(`kv/sites/${siteId}/ftp`, { password: 'synthetic-ftp-1' })

    await deleteSite(db, () => vault.store, input(owner, siteId, ' УКК ЖКХ '))

    const row = await db.site.findUniqueOrThrow({ where: { id: siteId } })
    expect(row.deletedAt).toEqual(now)
    expect(await db.site.findFirst({ where: accessibleSite(owner, siteId) })).toBeNull()
    // The history stays with the row.
    expect(await db.task.findUnique({ where: { id: done.id } })).not.toBeNull()
    expect(
      await db.auditLog.count({ where: { workspaceId, action: 'site.delete', targetId: siteId } }),
    ).toBe(1)
    // Each secret keeps one version, and it holds no value.
    for (const kind of ['ssh', 'db', 'ftp', 'env/DELIVERY_KEY'])
      expect(vault.kept(`kv/sites/${siteId}/${kind}`)).toEqual([{ removed: now.toISOString() }])
    // The same address may be added to the workspace again.
    await expect(
      db.site.create({ data: { name: 'УКК ЖКХ', url, stack: 'wordpress', workspaceId } }),
    ).resolves.toMatchObject({ url, deletedAt: null })
    await expect(deleteSite(db, () => vault.store, input(owner, siteId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('lets only an owner or an admin delete, with the name typed exactly', async () => {
    const vault = fakeVault()
    const { owner, member, siteId } = await siteWithSecrets(vault)
    await expect(deleteSite(db, () => vault.store, input(member, siteId))).rejects.toMatchObject({
      code: 'SITE_DELETE_NOT_ALLOWED',
    })
    await expect(
      deleteSite(db, () => vault.store, input(owner, siteId, 'УКК')),
    ).rejects.toMatchObject({ code: 'SITE_DELETE_NAME_MISMATCH' })
    await expect(
      deleteSite(db, () => vault.store, input(await person(), siteId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await db.site.findUniqueOrThrow({ where: { id: siteId } })).deletedAt).toBeNull()
    expect(vault.kept(`kv/sites/${siteId}/ssh`)).toHaveLength(2)
  })

  it.each(['queued', 'running', 'awaiting_user', 'awaiting_approval', 'deploying'] as const)(
    'refuses while a task is %s, and changes nothing',
    async (status) => {
      const vault = fakeVault()
      const { owner, workspaceId, siteId } = await siteWithSecrets(vault)
      await db.task.create({ data: { workspaceId, siteId, status } })
      await expect(deleteSite(db, () => vault.store, input(owner, siteId))).rejects.toMatchObject({
        code: 'SITE_DELETE_BUSY',
        details: { reason: 'tasks' },
      })
      expect((await db.site.findUniqueOrThrow({ where: { id: siteId } })).deletedAt).toBeNull()
      expect(vault.kept(`kv/sites/${siteId}/env/DELIVERY_KEY`)).toEqual([
        { value: 'synthetic-value' },
      ])
    },
  )

  it.each(['queued', 'running', 'failed'] as const)(
    'refuses while the first import is %s, and deletes once it succeeded',
    async (status) => {
      const vault = fakeVault()
      const { owner, siteId } = await siteWithSecrets(vault)
      await db.siteProvisioningStage.create({
        data: {
          siteId,
          stage: 'code_import',
          status,
          ...(status === 'failed' ? { errorCode: 'source_unreachable', finishedAt: now } : {}),
        },
      })
      try {
        await expect(deleteSite(db, () => vault.store, input(owner, siteId))).rejects.toMatchObject(
          { code: 'SITE_DELETE_BUSY', details: { reason: 'setup' } },
        )
        await db.siteProvisioningStage.updateMany({
          where: { siteId },
          data: { status: 'succeeded', errorCode: null, finishedAt: now },
        })
        await deleteSite(db, () => vault.store, input(owner, siteId))
      } finally {
        await db.siteProvisioningStage.deleteMany({ where: { siteId } })
      }
    },
  )

  it('leaves the site as it was when Vault refuses, and erases the rest when deleted again', async () => {
    const vault = fakeVault()
    const { owner, siteId } = await siteWithSecrets(vault)
    vault.state.refuse = true
    await expect(deleteSite(db, () => vault.store, input(owner, siteId))).rejects.toMatchObject({
      code: 'SITE_DELETE_UNAVAILABLE',
    })
    expect((await db.site.findUniqueOrThrow({ where: { id: siteId } })).deletedAt).toBeNull()
    vault.state.refuse = false
    await deleteSite(db, () => vault.store, input(owner, siteId))
    expect((await db.site.findUniqueOrThrow({ where: { id: siteId } })).deletedAt).toEqual(now)
    expect(vault.kept(`kv/sites/${siteId}/ssh`)).toEqual([{ removed: now.toISOString() }])
  })

  it('marks nothing when the secrets of the site cannot be reached', async () => {
    const vault = fakeVault()
    const { owner, siteId } = await siteWithSecrets(vault)
    await expect(deleteSite(db, null, input(owner, siteId))).rejects.toMatchObject({
      code: 'SITE_DELETE_UNAVAILABLE',
    })
    expect((await db.site.findUniqueOrThrow({ where: { id: siteId } })).deletedAt).toBeNull()
  })

  it('stops a new dialog or an undo on a deleted site under the lock', async () => {
    const vault = fakeVault()
    const { owner, siteId } = await siteWithSecrets(vault)
    await db.$transaction((tx) => lockLiveSite(tx, siteId))
    await deleteSite(db, () => vault.store, input(owner, siteId))
    await expect(db.$transaction((tx) => lockLiveSite(tx, siteId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
