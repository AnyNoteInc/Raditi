import { randomUUID } from 'node:crypto'

import {
  createArtifact,
  createPrismaClient,
  readArtifact,
  reserveArtifactFile,
  reserveArtifactImport,
  startArtifactFileUpload,
  sweepArtifacts,
  type PrismaClient,
} from '@repo/db'
import { packOutbox } from '@repo/snapshots'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { ArtifactOutbox } from './artifact-outbox.ts'

// What a turn put from its outbox into artifacts, on PostgreSQL (docs/plan/88-artifacts.md, §7.5;
// slice 88.12): a picture reserved by `artifact_file_put` lands in the bucket and becomes ready, a
// `.md` of `artifact_import` becomes a document of agent's writes waiting for the check, a file
// that is no picture goes, and nothing of it is a file of the chat.

const databaseUrl = process.env.DATABASE_URL
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe.skipIf(!databaseUrl)('the outbox of a turn into artifacts with PostgreSQL', () => {
  let db: PrismaClient
  let userId: string
  let workspaceId: string
  const put = vi.fn(async () => undefined)

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    userId = (
      await db.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test` } })
    ).id
    workspaceId = (
      await db.workspace.create({
        data: { name: 'Synthetic outbox', dataClass: 'synthetic', createdById: userId },
      })
    ).id
    await db.member.create({ data: { workspaceId, userId, role: 'owner' } })
  })
  afterAll(async () => {
    if (!db) return
    await db.artifact.deleteMany({ where: { workspaceId } })
    await db.task.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.delete({ where: { id: workspaceId } })
    await db.user.delete({ where: { id: userId } })
    await db.$disconnect()
  })

  it('writes a reserved picture, imports a Markdown file and leaves the rest to the chat', async () => {
    const taskId = (
      await db.task.create({
        data: { workspaceId, createdById: userId, status: 'running' },
        select: { id: true },
      })
    ).id
    const { id: mockupId } = await createArtifact(db, {
      workspaceId,
      kind: 'mockup',
      title: 'Макет',
      actor: { kind: 'user', userId },
    })
    const file = await reserveArtifactFile(db, {
      taskId,
      turnNo: 1,
      artifactId: mockupId,
      fileName: 'logo.png',
    })
    const bad = await reserveArtifactFile(db, {
      taskId,
      turnNo: 1,
      artifactId: mockupId,
      fileName: 'fake.png',
    })
    const imported = await reserveArtifactImport(db, {
      taskId,
      turnNo: 1,
      fileName: 'plan.md',
      artifactId: null,
      title: null,
      personal: true,
    })
    const outbox = await packOutbox([
      { name: 'logo.png', bytes: PNG },
      { name: 'fake.png', bytes: '<html>' },
      { name: 'plan.md', bytes: '# План\n\nВступление\n\n## Цель\n\nПродажи' },
      { name: 'report.docx', bytes: 'x' },
    ])
    const taken = await new ArtifactOutbox({ db, storage: { put } }).take({
      taskId,
      turn: 1,
      outbox,
    })
    expect([...taken].toSorted()).toEqual(['fake.png', 'logo.png', 'plan.md'])
    expect(put).toHaveBeenCalledTimes(1)
    expect(await db.artifactFile.findUnique({ where: { id: file.id } })).toMatchObject({
      state: 'ready',
      contentType: 'image/png',
      bytes: BigInt(PNG.byteLength),
    })
    expect(await db.artifactFile.findUnique({ where: { id: bad.id } })).toBeNull()
    const document = await readArtifact(db, {
      artifactId: imported.artifactId,
      actor: { kind: 'agent', taskId, turnNo: 1 },
    })
    expect(document.kind).toBe('document')
    expect(document.blocks.map((block) => block.props.heading)).toEqual(['План', 'Цель'])
    // The agent's writes wait for the check of the end of the turn, as every other.
    expect(document.blocks.every((block) => block.checking)).toBe(true)
    expect(
      await db.artifactImport.findUnique({ where: { id: imported.id }, select: { state: true } }),
    ).toEqual({ state: 'done' })
  })

  it('closes the reservations of a turn that left nothing', async () => {
    const taskId = (
      await db.task.create({
        data: { workspaceId, createdById: userId, status: 'failed' },
        select: { id: true },
      })
    ).id
    const { id } = await createArtifact(db, {
      workspaceId,
      kind: 'mockup',
      title: 'Макет 2',
      actor: { kind: 'user', userId },
    })
    const file = await reserveArtifactFile(db, {
      taskId,
      turnNo: 1,
      artifactId: id,
      fileName: 'a.png',
    })
    const taken = await new ArtifactOutbox({ db, storage: { put } }).take({
      taskId,
      turn: 1,
      outbox: null,
    })
    expect([...taken]).toEqual(['a.png'])
    expect(await db.artifactFile.findUnique({ where: { id: file.id } })).toBeNull()
  })

  it('the collector gives back the objects of uploads that never came and of purged artifacts', async () => {
    const { id } = await createArtifact(db, {
      workspaceId,
      kind: 'mockup',
      title: 'Макет 3',
      actor: { kind: 'user', userId },
    })
    const upload = await startArtifactFileUpload(db, {
      userId,
      artifactId: id,
      name: 'never.png',
      sizeBytes: 10,
    })
    const swept = await sweepArtifacts(db, new Date(Date.now() + 3 * 60 * 60 * 1000))
    expect(swept.objects).toContain(upload.objectKey)
    expect(await db.artifactFile.findUnique({ where: { id: upload.id } })).toBeNull()
  })
})
