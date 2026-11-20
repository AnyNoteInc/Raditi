import { randomUUID } from 'node:crypto'

import { applyArtifactOps, createArtifact, createPrismaClient, type PrismaClient } from '@repo/db'
import { artifactExportKey } from '@repo/domain/artifacts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { ArtifactExports } from './artifact-exports.ts'

// The workbooks of tables on PostgreSQL (docs/plan/88-artifacts.md, question 26; slice 88.14):
// rows of its own, removed at the end; the bucket is a map in memory.

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('the workbooks of tables with PostgreSQL', () => {
  let db: PrismaClient
  let userId: string
  let strangerId: string
  let workspaceId: string
  const quiet = { log: vi.fn(), warn: vi.fn() }
  const objects = new Map<string, Uint8Array>()
  const storage = {
    put: vi.fn(
      async (_bucket: string, key: string, body: Uint8Array | AsyncIterable<Uint8Array>) => {
        objects.set(key, body as Uint8Array)
      },
    ),
    delete: vi.fn(async (_bucket: string, key: string) => {
      objects.delete(key)
    }),
  }

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    userId = (
      await db.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test` } })
    ).id
    strangerId = (
      await db.user.create({ data: { name: 'Stranger', email: `${randomUUID()}@example.test` } })
    ).id
    workspaceId = (
      await db.workspace.create({
        data: { name: 'Synthetic tables', dataClass: 'synthetic', createdById: userId },
      })
    ).id
    await db.member.create({ data: { workspaceId, userId, role: 'owner' } })
  })
  afterAll(async () => {
    if (!db) return
    await db.artifact.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.user.deleteMany({ where: { id: { in: [userId, strangerId] } } })
    await db.$disconnect()
  })

  async function table() {
    const actor = { kind: 'user' as const, userId }
    const { id } = await createArtifact(db, { workspaceId, kind: 'table', title: 'Прайс', actor })
    await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'insert',
            block: 'cols',
            after: null,
            kind: 'columns',
            content: JSON.stringify([
              { key: 'name', name: 'Название', type: 'text' },
              { key: 'price', name: 'Цена', type: 'money' },
            ]),
          },
          {
            op: 'insert',
            block: 'r1',
            after: 'cols',
            kind: 'row',
            content: JSON.stringify({ name: 'Батон', price: '45.00' }),
          },
        ],
      },
      actor,
    })
    return id
  }

  it('builds the workbook of the person who asked, once, and refuses one who lost the table', async () => {
    const artifactId = await table()
    const exports = new ArtifactExports({ db, storage, logger: quiet })
    const own = await db.artifactExport.create({
      data: { artifactId, userId, format: 'xlsx' },
    })
    expect(await exports.build(own.id)).toBe('ready')
    const key = artifactExportKey({ workspaceId, artifactId, exportId: own.id })
    expect(objects.get(key)?.byteLength).toBeGreaterThan(0)
    const row = await db.artifactExport.findUniqueOrThrow({ where: { id: own.id } })
    expect(row).toMatchObject({ state: 'ready', objectKey: key })
    expect(await exports.build(own.id)).toBe('skipped')

    const theirs = await db.artifactExport.create({
      data: { artifactId, userId: strangerId, format: 'xlsx' },
    })
    expect(await exports.build(theirs.id)).toBe('failed')
    expect((await db.artifactExport.findUniqueOrThrow({ where: { id: theirs.id } })).state).toBe(
      'failed',
    )
  })

  it('forgets the workbooks of a day ago', async () => {
    const artifactId = await table()
    const old = await db.artifactExport.create({
      data: {
        artifactId,
        userId,
        format: 'xlsx',
        state: 'ready',
        objectKey: 'artifacts/old.xlsx',
        bytes: 1n,
        readyAt: new Date(Date.now() - 2 * 86_400_000),
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    })
    objects.set('artifacts/old.xlsx', new Uint8Array([1]))
    const fresh = await db.artifactExport.create({ data: { artifactId, userId, format: 'xlsx' } })
    await new ArtifactExports({ db, storage, logger: quiet }).build(fresh.id)
    expect(await db.artifactExport.findUnique({ where: { id: old.id } })).toBeNull()
    expect(objects.has('artifacts/old.xlsx')).toBe(false)
  })
})
