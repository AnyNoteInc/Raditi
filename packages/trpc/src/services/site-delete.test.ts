import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import type { KvMetadata, KvWriteOptions } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { accessibleSite, lockLiveSite } from './site-basics.ts'
import { deleteSite, type SiteSecretEraser } from './site-delete.ts'

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
    await db.scheduledTask.deleteMany({ where: { workspace: owned } })
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

  it('stops the scheduled tasks of the project in the same transaction (docs/plan/82, Зп22)', async () => {
    const vault = fakeVault()
    const { owner, workspaceId, siteId } = await siteWithSecrets(vault)
    const task = (name: string, data: { enabled?: boolean; deletedAt?: Date } = {}) =>
      db.scheduledTask.create({
        data: {
          workspaceId,
          siteId,
          createdById: owner,
          name,
          instructions: 'Проверьте сайт',
          effort: 'low',
          triggers: [{ kind: 'daily', time: '09:00' }],
          timezone: 'Europe/Moscow',
          enabled: data.enabled ?? true,
          nextRunAt: data.enabled === false ? null : new Date(now.getTime() + 3_600_000),
          createdVia: 'manual',
          ...(data.deletedAt ? { deletedAt: data.deletedAt } : {}),
        },
      })
    const on = await task('Включена')
    const paused = await task('На паузе', { enabled: false })
    const gone = await task('Удалена', { enabled: false, deletedAt: now })

    await deleteSite(db, () => vault.store, input(owner, siteId))

    for (const id of [on.id, paused.id])
      expect(await db.scheduledTask.findUniqueOrThrow({ where: { id } })).toMatchObject({
        enabled: false,
        nextRunAt: null,
        pausedReason: 'project_gone',
      })
    expect(
      (await db.scheduledTask.findUniqueOrThrow({ where: { id: gone.id } })).pausedReason,
    ).toBeNull()
  })

  /** A scheduled task of the project, on, due in an hour. */
  const scheduledTaskOf = (owner: string, workspaceId: string, siteId: string) =>
    db.scheduledTask.create({
      data: {
        workspaceId,
        siteId,
        createdById: owner,
        name: 'Проверка сайта',
        instructions: 'Проверьте сайт',
        effort: 'low',
        triggers: [{ kind: 'hourly', minute: 0 }],
        timezone: 'Europe/Moscow',
        nextRunAt: new Date(now.getTime() + 3_600_000),
        createdVia: 'manual',
      },
    })

  it('closes the chats of runs that wait for the client, and still refuses an ordinary one (Зп22)', async () => {
    const vault = fakeVault()
    const { owner, workspaceId, siteId } = await siteWithSecrets(vault)
    const schedule = await scheduledTaskOf(owner, workspaceId, siteId)
    // Runs that answered and asked: their chats wait for the client for good.
    const chats: string[] = []
    for (const [index, status] of (['awaiting_user', 'awaiting_approval'] as const).entries()) {
      const chat = await db.task.create({
        data: { workspaceId, siteId, status, createdById: owner, needsRepository: true },
      })
      await db.scheduledRun.create({
        data: {
          scheduledTaskId: schedule.id,
          dueAt: new Date(now.getTime() - (index + 1) * 3_600_000),
          trigger: 'schedule',
          status: 'started',
          taskId: chat.id,
          startedAt: now,
          siteId,
          name: schedule.name,
          instructions: schedule.instructions,
          effort: schedule.effort,
        },
      })
      chats.push(chat.id)
    }
    const ordinary = await db.task.create({
      data: { workspaceId, siteId, status: 'awaiting_user', createdById: owner },
    })
    await expect(deleteSite(db, () => vault.store, input(owner, siteId))).rejects.toMatchObject({
      code: 'SITE_DELETE_BUSY',
      details: { reason: 'tasks' },
    })
    // Nothing of the refused deletion stays: the chats of runs wait as they did.
    for (const id of chats)
      expect((await db.task.findUniqueOrThrow({ where: { id } })).status).not.toBe('cancelled')

    await db.task.update({ where: { id: ordinary.id }, data: { status: 'done' } })
    await deleteSite(db, () => vault.store, input(owner, siteId))
    expect((await db.site.findUniqueOrThrow({ where: { id: siteId } })).deletedAt).toEqual(now)
    for (const id of chats) {
      expect((await db.task.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled')
      expect(await db.taskEvent.count({ where: { taskId: id, type: 'feed.cancelled' } })).toBe(1)
    }
    expect(await db.scheduledTask.findUniqueOrThrow({ where: { id: schedule.id } })).toMatchObject({
      enabled: false,
      pausedReason: 'project_gone',
    })
  })

  it('takes the tasks of the project before the project, as the tick does: no deadlock (Зп22, Зп24)', async () => {
    const vault = fakeVault()
    const { owner, workspaceId, siteId } = await siteWithSecrets(vault)
    const schedule = await scheduledTaskOf(owner, workspaceId, siteId)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    // The tick holds the task and then writes a run that refers to the project.
    const tick = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM scheduled_tasks WHERE id = ${schedule.id}::uuid FOR UPDATE`
        locked()
        await held
        await tx.scheduledRun.create({
          data: {
            scheduledTaskId: schedule.id,
            dueAt: now,
            trigger: 'schedule',
            status: 'pending',
            siteId,
            name: schedule.name,
            instructions: schedule.instructions,
            effort: schedule.effort,
          },
        })
      },
      { timeout: 20_000 },
    )
    await isLocked
    const deletion = deleteSite(db, () => vault.store, input(owner, siteId))
    await new Promise((resolve) => setTimeout(resolve, 300))
    release()
    await expect(tick).resolves.toBeUndefined()
    await expect(deletion).resolves.toBeUndefined()
    expect((await db.site.findUniqueOrThrow({ where: { id: siteId } })).deletedAt).toEqual(now)
    expect(await db.scheduledTask.findUniqueOrThrow({ where: { id: schedule.id } })).toMatchObject({
      enabled: false,
      pausedReason: 'project_gone',
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
