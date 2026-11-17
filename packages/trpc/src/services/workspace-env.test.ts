import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import type { KvMetadata, KvWriteOptions } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import type { ChatSecretWriter } from './chat/context.ts'
import { listWorkspaceEnv, removeWorkspaceEnv, setWorkspaceEnv } from './workspace-env.ts'

// «Настройки → Переменные» (docs/plan/83-remove-projects.md, БП4) on fakes: the value goes to
// Vault alone, never back; the row names the version; a member reads, a manager writes.

const workspaceId = randomUUID()
const userId = randomUUID()
const now = new Date('2026-11-15T12:00:00Z')

interface Row {
  name: string
  keyVersion: number
  updatedAt: Date
}

/** Vault KV v2 in memory with CAS and `max_versions`, as `sites-writer` may use it. */
function memoryVault() {
  const keys = new Map<string, { version: number; data: Record<string, string> }[]>()
  const writer = {
    kvMetadata: vi.fn(async (path: string): Promise<KvMetadata | null> => {
      const versions = keys.get(path)
      if (versions === undefined) return null
      return {
        currentVersion: versions.at(-1)!.version,
        custom: {},
        createdTime: now,
        deleted: false,
        destroyed: false,
      }
    }),
    kvWrite: vi.fn(async (path: string, data: Record<string, string>, options?: KvWriteOptions) => {
      const versions = keys.get(path) ?? []
      const current = versions.at(-1)?.version ?? 0
      if (options?.cas !== undefined && options.cas !== current)
        throw new Error('check-and-set parameter did not match the current version')
      versions.push({ version: current + 1, data })
      keys.set(path, versions.slice(-(options?.maxVersions ?? 10)))
      return { version: current + 1 }
    }),
    transitEnsureKey: vi.fn(),
  }
  return { writer: writer as unknown as ChatSecretWriter, keys, raw: writer }
}

/** One workspace the user is a member of with `role`, and its rows of `workspace_env_vars`. */
function fakeDb(role: 'owner' | 'admin' | 'member' | null) {
  const rows = new Map<string, Row>()
  const db = {
    member: {
      findUnique: vi.fn(async () => (role === null ? null : { role })),
    },
    workspaceEnvVar: {
      findMany: vi.fn(async () => [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))),
      count: vi.fn(
        async ({ where }: { where: { name: { not: string } } }) =>
          [...rows.keys()].filter((name) => name !== where.name.not).length,
      ),
      createMany: vi.fn(async ({ data }: { data: { name: string; keyVersion: number }[] }) => {
        const [row] = data
        if (rows.has(row!.name)) return { count: 0 }
        rows.set(row!.name, { name: row!.name, keyVersion: row!.keyVersion, updatedAt: now })
        return { count: 1 }
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { name: string; keyVersion: { lt: number } }
          data: { keyVersion: number }
        }) => {
          const row = rows.get(where.name)
          if (row === undefined || row.keyVersion >= where.keyVersion.lt) return { count: 0 }
          row.keyVersion = data.keyVersion
          return { count: 1 }
        },
      ),
      findUniqueOrThrow: vi.fn(
        async ({ where }: { where: { workspaceId_name: { name: string } } }) =>
          rows.get(where.workspaceId_name.name)!,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { workspaceId_name: { name: string } } }) =>
          rows.get(where.workspaceId_name.name) ?? null,
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { name: string; keyVersion: { lt?: number; lte?: number } }
        }) => {
          const row = rows.get(where.name)
          const bound = where.keyVersion.lt ?? where.keyVersion.lte! + 1
          if (row === undefined || row.keyVersion >= bound) return { count: 0 }
          rows.delete(where.name)
          return { count: 1 }
        },
      ),
    },
  }
  return { db, prisma: db as unknown as PrismaClient, rows }
}

const place = { appEnv: 'test' as const, userId, workspaceId }

describe('the variables of a workspace', () => {
  it('puts the value into Vault only, under the path of the workspace, and never gives it back', async () => {
    const { prisma, rows } = fakeDb('owner')
    const vault = memoryVault()

    const saved = await setWorkspaceEnv(prisma, () => vault.writer, {
      ...place,
      name: 'TELEGRAM_TOKEN',
      value: 'secret-value-123',
    })

    expect(saved).toEqual({ name: 'TELEGRAM_TOKEN', keyVersion: 1, updatedAt: now })
    expect(JSON.stringify(saved)).not.toContain('secret-value-123')
    expect(vault.keys.get(`kv/workspaces/${workspaceId}/env/TELEGRAM_TOKEN`)).toEqual([
      { version: 1, data: { value: 'secret-value-123' } },
    ])
    expect(vault.raw.kvWrite).toHaveBeenCalledWith(
      `kv/workspaces/${workspaceId}/env/TELEGRAM_TOKEN`,
      { value: 'secret-value-123' },
      { cas: 0, maxVersions: 1 },
    )
    expect(rows.get('TELEGRAM_TOKEN')?.keyVersion).toBe(1)

    const listed = await listWorkspaceEnv(prisma, place)
    expect(listed).toEqual({
      workspaceId,
      canEdit: true,
      variables: [{ name: 'TELEGRAM_TOKEN', keyVersion: 1, updatedAt: now }],
    })
    expect(JSON.stringify(listed)).not.toContain('secret-value-123')
  })

  it('replaces a value by the next version, and the row names it', async () => {
    const { prisma, rows } = fakeDb('admin')
    const vault = memoryVault()
    const input = { ...place, name: 'API_KEY', value: 'first-value' }
    await setWorkspaceEnv(prisma, () => vault.writer, input)
    await setWorkspaceEnv(prisma, () => vault.writer, { ...input, value: 'second-value' })

    expect(rows.get('API_KEY')?.keyVersion).toBe(2)
    expect(vault.keys.get(`kv/workspaces/${workspaceId}/env/API_KEY`)).toEqual([
      { version: 2, data: { value: 'second-value' } },
    ])
  })

  it('removes a variable with a version without its value, and the row with it', async () => {
    const { prisma, rows } = fakeDb('owner')
    const vault = memoryVault()
    await setWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'API_KEY', value: 'x' })

    await expect(
      removeWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'API_KEY', now }),
    ).resolves.toEqual({ removed: true })
    expect(rows.size).toBe(0)
    expect(vault.keys.get(`kv/workspaces/${workspaceId}/env/API_KEY`)).toEqual([
      { version: 2, data: { removed: now.toISOString() } },
    ])
    await expect(
      removeWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'API_KEY', now }),
    ).resolves.toEqual({ removed: false })
  })

  it('lets a member read the names and not change them', async () => {
    const { prisma } = fakeDb('member')
    const vault = memoryVault()

    await expect(listWorkspaceEnv(prisma, place)).resolves.toMatchObject({ canEdit: false })
    await expect(
      setWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'API_KEY', value: 'x' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_ENV_NOT_ALLOWED' })
    await expect(
      removeWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'API_KEY', now }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_ENV_NOT_ALLOWED' })
    expect(vault.raw.kvWrite).not.toHaveBeenCalled()
  })

  it('answers a workspace of someone else as one that does not exist', async () => {
    const { prisma } = fakeDb(null)
    await expect(listWorkspaceEnv(prisma, place)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it.each([
    ['lower case', 'api_key', 'WORKSPACE_ENV_NAME_INVALID'],
    ['reserved', 'PATH', 'WORKSPACE_ENV_NAME_RESERVED'],
    ['of the platform', 'RADITI_TOKEN', 'WORKSPACE_ENV_NAME_RESERVED'],
  ])('refuses a name %s before Vault is asked', async (_case, name, code) => {
    const { prisma } = fakeDb('owner')
    const vault = memoryVault()
    await expect(
      setWorkspaceEnv(prisma, () => vault.writer, { ...place, name, value: 'x' }),
    ).rejects.toMatchObject({ code })
    expect(vault.raw.kvWrite).not.toHaveBeenCalled()
  })

  it('refuses an empty value and one with NUL', async () => {
    const { prisma } = fakeDb('owner')
    const vault = memoryVault()
    for (const value of ['', 'a\0b'])
      await expect(
        setWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'API_KEY', value }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_ENV_VALUE_INVALID' })
  })

  it('takes no more than 64 variables', async () => {
    const { prisma, rows } = fakeDb('owner')
    for (let index = 0; index < 64; index += 1)
      rows.set(`KEY_${index}`, { name: `KEY_${index}`, keyVersion: 1, updatedAt: now })
    const vault = memoryVault()
    await expect(
      setWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'ONE_MORE', value: 'x' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_ENV_LIMIT' })
    // A value of one of them may still be replaced.
    await expect(
      setWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'KEY_3', value: 'x' }),
    ).resolves.toMatchObject({ name: 'KEY_3' })
  })

  it('tells a writer that lost the race of Vault that the variable changed', async () => {
    const { prisma } = fakeDb('owner')
    const vault = memoryVault()
    // Another writer gets in between the read of the version and the write.
    vault.raw.kvMetadata.mockResolvedValueOnce(null)
    vault.keys.set(`kv/workspaces/${workspaceId}/env/API_KEY`, [
      { version: 1, data: { value: 'theirs' } },
    ])
    await expect(
      setWorkspaceEnv(prisma, () => vault.writer, { ...place, name: 'API_KEY', value: 'mine' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_ENV_CHANGED' })
  })
})
