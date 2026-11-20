import { randomUUID } from 'node:crypto'

import { isDomainError } from '@repo/domain'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import {
  applyArtifactOps,
  artifactRole,
  canonicalJson,
  claimArtifactBlock,
  createArtifact,
  dropArtifactWrites,
  dropStaleArtifactWrites,
  pendingArtifactTitles,
  pendingArtifactWrites,
  readArtifact,
  readArtifactVersion,
  restoreArtifact,
  saveArtifactVersion,
  settleArtifactWrites,
  staleArtifactWriters,
  sweepArtifacts,
  takeArtifactBlock,
  trashArtifact,
  type ArtifactActor,
} from './artifacts.ts'
import {
  artifactChatNews,
  artifactPlaceholders,
  artifactsOfTurn,
  chatArtifactAccess,
  chatLastRevOf,
  listChatArtifacts,
} from './artifact-chats.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  createChatDocument,
  readChatDocument,
  requestDocFinish,
  settleTurnSections,
  writeDocSection,
} from './pages.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL
/** After the lease of a person who just wrote (30 s): when the agent may write again. */
const soon = () => new Date(Date.now() + 60_000)

async function codeOf(act: () => Promise<unknown>): Promise<string | null> {
  try {
    await act()
    return null
  } catch (error) {
    return isDomainError(error) ? error.code : String(error)
  }
}

async function detailsOf(act: () => Promise<unknown>): Promise<unknown> {
  try {
    await act()
    return null
  } catch (error) {
    return isDomainError(error) ? error.details : String(error)
  }
}

describe.skipIf(!databaseUrl)('PostgreSQL: artifacts (plan 88, 88.3)', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'artifacts')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  async function owner() {
    const user = await db.user.create({
      data: { name: 'Synthetic', email: `${randomUUID()}@example.test` },
    })
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const chat = async () =>
      (
        await db.task.create({
          data: { id: uuidv7(), workspaceId: workspace.id, createdById: user.id },
          select: { id: true },
        })
      ).id
    const person: ArtifactActor = { kind: 'user', userId: user.id }
    const agent = (taskId: string, turnNo = 1): ArtifactActor => ({ kind: 'agent', taskId, turnNo })
    const create = async (kind = 'document', title = 'Прайс', actor: ArtifactActor = person) =>
      (await createArtifact(db, { workspaceId: workspace.id, kind, title, actor })).id
    let n = 0
    const apply = (
      artifactId: string,
      ops: unknown[],
      actor: ArtifactActor = person,
      now?: Date,
      opId = `op-${(n += 1)}`,
    ) => applyArtifactOps(db, { batch: { artifactId, opId, ops }, actor, now })
    return { user, workspace, chat, person, agent, create, apply }
  }

  const section = (block: string, text: string, after: string | null = null) => ({
    op: 'insert',
    block,
    after,
    kind: 'section',
    content: text,
    props: { heading: `Раздел ${block}` },
  })

  it('applies a person’s batch at once: insert, replace by ifRev, quote, move, delete, title', async () => {
    const { create, apply, person } = await owner()
    const id = await create()
    const first = await apply(id, [section('a', 'Кофе 200'), section('b', 'Чай 150', 'a')])
    expect(first).toMatchObject({
      seq: 3,
      repeated: false,
      blocks: [
        { key: 'a', rev: 1, state: 'applied' },
        { key: 'b', rev: 1, state: 'applied' },
      ],
    })
    expect(
      await codeOf(() => apply(id, [{ op: 'replace', block: 'a', ifRev: 0, content: 'x' }])),
    ).toBe('ARTIFACT_STALE')
    expect(
      await detailsOf(() => apply(id, [{ op: 'replace', block: 'a', ifRev: 0, content: 'x' }])),
    ).toMatchObject({ current: { block: 'a', rev: 1, content: 'Кофе 200' } })
    await apply(id, [{ op: 'replace', block: 'a', ifRev: 1, content: 'Кофе 250 и 250' }])
    expect(
      await codeOf(() => apply(id, [{ op: 'edit', block: 'a', find: '250', replace: '300' }])),
    ).toBe('ARTIFACT_FIND_MANY')
    expect(
      await codeOf(() => apply(id, [{ op: 'edit', block: 'a', find: 'Сок', replace: 'М' }])),
    ).toBe('ARTIFACT_FIND_NONE')
    await apply(id, [{ op: 'edit', block: 'a', find: 'Кофе', replace: 'Капучино' }])
    await apply(id, [
      { op: 'move', block: 'b', ifRev: 1, after: null },
      { op: 'title', title: 'Цены' },
    ])
    const read = await readArtifact(db, { artifactId: id, actor: person })
    expect(read.title).toBe('Цены')
    expect(read.blocks.map((block) => [block.key, block.content])).toEqual([
      ['b', 'Чай 150'],
      ['a', 'Капучино 250 и 250'],
    ])
    await apply(id, [{ op: 'delete', block: 'b', ifRev: 2 }])
    const after = await readArtifact(db, { artifactId: id, actor: person })
    expect(after.blocks.map((block) => block.key)).toEqual(['a'])
    const row = await db.artifact.findUniqueOrThrow({ where: { id } })
    expect(Number(row.bytes)).toBe(Buffer.byteLength('Капучино 250 и 250'))
    // Every operation is a line of the journal, without text.
    const journal = await db.artifactOp.findMany({
      where: { artifactId: id },
      orderBy: { seq: 'asc' },
    })
    expect(journal.map((line) => line.kind)).toEqual([
      'create',
      'insert',
      'insert',
      'replace',
      'edit',
      'move',
      'title',
      'delete',
    ])
    expect(Number(row.seq)).toBe(8)
    // The legacy reader of plan 69 shows a person's section as it is.
    const legacy = await readChatDocument(db, {
      workspaceId: row.workspaceId,
      documentId: id,
      reader: 'client',
    })
    expect(legacy.sections).toMatchObject([{ key: 'a', markdown: 'Капучино 250 и 250' }])
  })

  it('answers a repeated batch the same, and refuses the opId of another batch', async () => {
    const { create, apply } = await owner()
    const id = await create()
    const once = await apply(id, [section('a', 'Текст')], undefined, undefined, 'same')
    const again = await apply(id, [section('a', 'Текст')], undefined, undefined, 'same')
    expect(again).toEqual({ ...once, repeated: true })
    expect(
      await codeOf(() => apply(id, [section('a', 'Другой')], undefined, undefined, 'same')),
    ).toBe('ARTIFACT_OP_REUSED')
    // A refused batch keeps nothing: the same opId may come again with a fix.
    expect(
      await codeOf(() => apply(id, [section('b', 'x', 'zz')], undefined, undefined, 'fix')),
    ).toBe('ARTIFACT_OP_INVALID')
    expect((await apply(id, [section('b', 'x', 'a')], undefined, undefined, 'fix')).repeated).toBe(
      false,
    )
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
  })

  it('refuses a person’s secret, bad content, and nothing is written', async () => {
    const { create, apply } = await owner()
    const id = await create()
    expect(
      await codeOf(() =>
        apply(id, [section('a', 'пароль ghp_0123456789abcdefghijABCDEFGHIJ012345')]),
      ),
    ).toBe('ARTIFACT_SECRET_SHAPE')
    expect(await codeOf(() => apply(id, [{ ...section('a', 'x'), props: {} }]))).toBe(
      'ARTIFACT_OP_INVALID',
    )
    expect(await codeOf(() => apply(id, [{ ...section('a', 'x'), kind: 'row' }]))).toBe(
      'ARTIFACT_OP_INVALID',
    )
    expect(await codeOf(() => apply(id, [section('a', 'x'), section('a', 'y')]))).toBe(
      'ARTIFACT_OP_INVALID',
    )
    expect(await db.artifactBlock.count({ where: { documentId: id } })).toBe(0)
  })

  it('holds the agent’s write until the check, and shows others the checked text meanwhile', async () => {
    const { create, apply, chat, agent, person } = await owner()
    const id = await create()
    await apply(id, [section('a', 'Старый')])
    const writer = await chat()
    const other = await chat()
    const answer = await apply(
      id,
      [{ op: 'replace', block: 'a', ifRev: 1, content: 'Новый' }],
      agent(writer),
      soon(),
    )
    expect(answer.blocks).toEqual([{ key: 'a', rev: 2, state: 'checking' }])
    const seenByPerson = await readArtifact(db, { artifactId: id, actor: person })
    expect(seenByPerson.blocks[0]).toMatchObject({
      content: 'Старый',
      checking: true,
      hold: 'checking',
    })
    const seenByWriter = await readArtifact(db, { artifactId: id, actor: agent(writer) })
    expect(seenByWriter.blocks[0]).toMatchObject({ content: 'Новый' })
    // Another chat and the person are held off; the writer writes on.
    expect(
      await detailsOf(() =>
        apply(
          id,
          [{ op: 'replace', block: 'a', ifRev: 2, content: 'Чужой' }],
          agent(other),
          soon(),
        ),
      ),
    ).toEqual({ block: 'a', reason: 'checking' })
    expect(
      await codeOf(() => apply(id, [{ op: 'replace', block: 'a', ifRev: 2, content: 'Мой' }])),
    ).toBe('ARTIFACT_BLOCK_HELD')
    await apply(
      id,
      [{ op: 'edit', block: 'a', find: 'Новый', replace: 'Новейший' }],
      agent(writer),
      soon(),
    )
    // A check of an older revision does nothing; of the current one — the text is checked.
    await settleArtifactWrites(db, {
      taskId: writer,
      blocks: [{ artifactId: id, block: 'a', rev: 2, refusal: null }],
    })
    expect((await readArtifact(db, { artifactId: id, actor: person })).blocks[0]).toMatchObject({
      content: 'Старый',
      checking: true,
    })
    expect(
      await settleArtifactWrites(db, {
        taskId: writer,
        blocks: [{ artifactId: id, block: 'a', rev: 3, refusal: null }],
      }),
    ).toEqual([{ artifactId: id, checked: 1, refused: 0 }])
    expect((await readArtifact(db, { artifactId: id, actor: person })).blocks[0]).toMatchObject({
      content: 'Новейший',
      checking: false,
      rev: 3,
    })
    // A refused rewrite keeps the checked text under a new revision; a refused insert goes.
    await apply(
      id,
      [
        { op: 'replace', block: 'a', ifRev: 3, content: 'Плохой' },
        { ...section('b', 'Плохой новый', 'a'), intent: 'Чай' },
      ],
      agent(writer),
      soon(),
    )
    await settleArtifactWrites(db, {
      taskId: writer,
      blocks: [
        { artifactId: id, block: 'a', rev: 4, refusal: 'client_value' },
        { artifactId: id, block: 'b', rev: 1, refusal: 'client_value' },
      ],
    })
    const settled = await readArtifact(db, { artifactId: id, actor: person })
    expect(settled.blocks.map((block) => [block.key, block.content, block.rev])).toEqual([
      ['a', 'Новейший', 5],
    ])
    const lines = await db.artifactOp.findMany({
      where: { artifactId: id, kind: 'check' },
      orderBy: { seq: 'asc' },
    })
    expect(lines.map((line) => line.result)).toEqual(['checked', 'refused', 'refused'])
  })

  it('drops the writes of a failed turn and releases its claims', async () => {
    const { create, apply, chat, agent, person } = await owner()
    const id = await create()
    await apply(id, [section('a', 'Был')])
    const writer = await chat()
    await apply(
      id,
      [{ op: 'replace', block: 'a', ifRev: 1, content: 'Стал' }],
      agent(writer),
      soon(),
    )
    await dropArtifactWrites(db, writer)
    expect(
      (await readArtifact(db, { artifactId: id, actor: person, now: soon() })).blocks[0],
    ).toMatchObject({ content: 'Был', checking: false, hold: null })
    expect(
      (await db.artifactOp.findFirstOrThrow({ where: { artifactId: id, kind: 'check' } })).result,
    ).toBe('dropped')
  })

  it('keeps the agent off a block a person types in, and tells the taken chat its lease is lost', async () => {
    const { create, apply, chat, agent } = await owner()
    const id = await create()
    const now = new Date()
    await apply(id, [section('a', 'Набираю')], undefined, now)
    const writer = await chat()
    const write = (at: Date, rev: number) =>
      apply(id, [{ op: 'replace', block: 'a', ifRev: rev, content: 'Агент' }], agent(writer), at)
    expect(await detailsOf(() => write(new Date(now.getTime() + 5_000), 1))).toEqual({
      block: 'a',
      reason: 'human',
    })
    // 30 s without typing: the lease is over.
    expect((await write(new Date(now.getTime() + 31_000), 1)).blocks[0]?.state).toBe('checking')
    // «Забрать правку»: the write is dropped, the chat hears its lease is lost.
    const taken = await takeArtifactBlock(db, {
      artifactId: id,
      block: 'a',
      userId: (await db.task.findUniqueOrThrow({ where: { id: writer } })).createdById!,
      now: new Date(now.getTime() + 32_000),
    })
    expect(taken.rev).toBe(3)
    expect(await codeOf(() => write(new Date(now.getTime() + 33_000), 3))).toBe(
      'ARTIFACT_LEASE_LOST',
    )
  })

  it('lets a claim of the agent hold a block for others', async () => {
    const { create, apply, chat, agent } = await owner()
    const id = await create()
    const now = new Date()
    await apply(id, [section('a', 'Текст')], undefined, now)
    const later = new Date(now.getTime() + 40_000)
    const claimer = await chat()
    await claimArtifactBlock(db, {
      artifactId: id,
      block: 'a',
      actor: { kind: 'agent', taskId: claimer, turnNo: 1 },
      intent: 'Обновлю цены',
      now: later,
    })
    const stranger = await chat()
    expect(
      await detailsOf(() =>
        apply(id, [{ op: 'replace', block: 'a', ifRev: 1, content: 'x' }], agent(stranger), later),
      ),
    ).toEqual({ block: 'a', reason: 'claim' })
    expect(
      await detailsOf(() =>
        apply(id, [{ op: 'replace', block: 'a', ifRev: 1, content: 'x' }], undefined, later),
      ),
    ).toEqual({ block: 'a', reason: 'claim' })
    const own = await apply(
      id,
      [{ op: 'replace', block: 'a', ifRev: 1, content: 'Новые цены' }],
      agent(claimer),
      later,
    )
    expect(own.blocks[0]?.state).toBe('checking')
  })

  it('keeps a table’s cells by its columns', async () => {
    const { create, apply, person } = await owner()
    const id = await create('table', 'Прайс')
    const columns = JSON.stringify([
      { key: 'name', name: 'Товар', type: 'text' },
      { key: 'price', name: 'Цена', type: 'money' },
    ])
    await apply(id, [
      { op: 'insert', block: 'cols', after: null, kind: 'columns', content: columns },
      { op: 'insert', block: 'r1', after: 'cols', kind: 'row', content: '{"name":"Кофе"}' },
      { op: 'cells', block: 'r1', cells: { price: '250.00' } },
    ])
    expect(
      await codeOf(() => apply(id, [{ op: 'cells', block: 'r1', cells: { price: 250 } }])),
    ).toBe('ARTIFACT_OP_INVALID')
    expect(
      await codeOf(() => apply(id, [{ op: 'cells', block: 'r1', cells: { size: 'L' } }])),
    ).toBe('ARTIFACT_OP_INVALID')
    await apply(id, [{ op: 'cells', block: 'r1', cells: { name: null } }])
    const read = await readArtifact(db, { artifactId: id, actor: person })
    expect(JSON.parse(read.blocks[1]!.content!)).toEqual({ price: '250.00' })
    // A paste of rows in the cabinet goes as one batch beyond 50 operations.
    const rows = Array.from({ length: 120 }, (_, index) => ({
      op: 'insert',
      block: `p${index}`,
      after: index === 0 ? 'r1' : `p${index - 1}`,
      kind: 'row',
      content: JSON.stringify({ name: `Товар ${index}`, price: `${index}.00` }),
    }))
    await apply(id, rows)
    const all = await readArtifact(db, { artifactId: id, actor: person })
    expect(all.blocks.map((block) => block.key)).toEqual([
      'cols',
      'r1',
      ...rows.map((row) => row.block),
    ])
  })

  it('keeps versions as lists of revisions, the text of each hash once', async () => {
    const { create, apply, person, chat, agent } = await owner()
    const id = await create()
    await apply(id, [section('a', 'Один'), section('b', 'Два', 'a')])
    const first = await saveArtifactVersion(db, {
      artifactId: id,
      actor: person,
      label: 'Черновик',
    })
    expect(first).toMatchObject({ no: 1, glued: false })
    await apply(id, [{ op: 'move', block: 'b', ifRev: 1, after: null }])
    const writer = await chat()
    // The agent's unchecked write is not in a version: the checked text is.
    await apply(
      id,
      [{ op: 'replace', block: 'a', ifRev: 1, content: 'Непроверенный' }],
      agent(writer),
      soon(),
    )
    const now = new Date()
    const second = await saveArtifactVersion(db, { artifactId: id, actor: person, glue: true, now })
    const glued = await saveArtifactVersion(db, {
      artifactId: id,
      actor: person,
      glue: true,
      now: new Date(now.getTime() + 60_000),
    })
    expect(second.no).toBe(2)
    expect(glued).toMatchObject({ no: 2, glued: true })
    const version = await readArtifactVersion(db, { artifactId: id, no: 2, actor: person })
    expect(version.blocks.map((block) => [block.key, block.rev, block.content])).toEqual([
      ['b', 2, 'Два'],
      ['a', 1, 'Один'],
    ])
    const old = await readArtifactVersion(db, { artifactId: id, no: 1, actor: person })
    expect(old).toMatchObject({ label: 'Черновик', named: true })
    expect(old.blocks.map((block) => [block.key, block.content])).toEqual([
      ['a', 'Один'],
      ['b', 'Два'],
    ])
    // The move kept no second copy of «Два».
    const kept = await db.artifactBlockRevision.findMany({
      where: { artifactId: id, blockKey: 'b' },
      orderBy: { rev: 'asc' },
    })
    expect(kept.map((row) => row.content)).toEqual(['Два', null])
    expect(new Set(kept.map((row) => row.sha256)).size).toBe(1)
    // A document keeps its Markdown as before.
    const content = await db.artifactContent.findUniqueOrThrow({ where: { documentId: id } })
    expect(content.markdown).toContain('## Раздел a')
  })

  it('creates as the agent with the title waiting for the check, and gives the owner alone a role', async () => {
    const { create, chat, agent, workspace, user } = await owner()
    const writer = await chat()
    const id = await create('mockup', 'Лендинг кофейни', agent(writer))
    const row = await db.artifact.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({
      title: 'Макет',
      pendingTitle: 'Лендинг кофейни',
      ownerUserId: user.id,
    })
    expect(await artifactRole(db, { artifactId: id, userId: user.id })).toBe('owner')
    const stranger = await db.user.create({
      data: { name: 'Other', email: `${randomUUID()}@example.test` },
    })
    expect(await artifactRole(db, { artifactId: id, userId: stranger.id })).toBeNull()
    expect(
      await codeOf(() =>
        createArtifact(db, {
          workspaceId: workspace.id,
          kind: 'mockup',
          title: 'x',
          actor: { kind: 'user', userId: stranger.id },
        }),
      ),
    ).toBe('ARTIFACT_FORBIDDEN')
    expect(await codeOf(() => create('poster'))).toBe('ARTIFACT_KIND_REFUSED')
    expect(
      await codeOf(() =>
        applyArtifactOps(db, {
          batch: { artifactId: id, opId: 'x', ops: [{ op: 'title', title: 'y' }] },
          actor: { kind: 'user', userId: stranger.id },
        }),
      ),
    ).toBe('ARTIFACT_NOT_FOUND')
  })

  it('puts in the trash and returns, and the collector deletes after 30 days', async () => {
    const { create, apply, user } = await owner()
    const id = await create()
    await apply(id, [section('a', 'x')])
    // A version and the Markdown of the current one go with it (their keys hold each other).
    await saveArtifactVersion(db, { artifactId: id, actor: { kind: 'user', userId: user.id } })
    const now = new Date()
    await trashArtifact(db, { artifactId: id, userId: user.id, by: 'client', now })
    expect(
      (
        await db.artifactOp.findFirstOrThrow({
          where: { artifactId: id },
          orderBy: { seq: 'desc' },
        })
      ).kind,
    ).toBe('trash')
    expect(await artifactRole(db, { artifactId: id, userId: user.id })).toBeNull()
    expect(await artifactRole(db, { artifactId: id, userId: user.id, trashed: true })).toBe('owner')
    expect(await codeOf(() => apply(id, [section('b', 'y')]))).toBe('ARTIFACT_NOT_FOUND')
    expect(await restoreArtifact(db, { artifactId: id, userId: user.id, onlyBy: 'project' })).toBe(
      false,
    )
    expect(await restoreArtifact(db, { artifactId: id, userId: user.id })).toBe(true)
    await trashArtifact(db, { artifactId: id, userId: user.id, by: 'client', now })
    const swept = await sweepArtifacts(db, new Date(now.getTime() + 31 * 24 * 3600 * 1000))
    expect(swept.purged).toBeGreaterThanOrEqual(1)
    expect(await db.artifact.findUnique({ where: { id } })).toBeNull()
  })

  it('signals raditi_artifact once per batch with the id alone', async () => {
    const { create, apply } = await owner()
    const id = await create()
    const listener = new Client({ connectionString: databaseUrl })
    await listener.connect()
    const heard: string[] = []
    listener.on('notification', (message) => {
      if (message.channel === 'raditi_artifact' && message.payload === id)
        heard.push(message.payload)
    })
    try {
      await listener.query('LISTEN raditi_artifact')
      await apply(id, [section('a', 'x'), section('b', 'y', 'a'), { op: 'title', title: 'Z' }])
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(heard).toEqual([id])
    } finally {
      await listener.end()
    }
  })

  it('ranks the sections of a document of plan 69 and lets the new operations write them', async () => {
    const { workspace, chat, apply, person } = await owner()
    const taskId = await chat()
    const document = await createChatDocument(db, {
      workspaceId: workspace.id,
      taskId,
      title: 'Аудит',
      view: 'text',
      sections: [
        { key: 'one', intent: 'Первый' },
        { key: 'two', intent: 'Второй' },
      ],
    })
    const blocks = await db.artifactBlock.findMany({
      where: { documentId: document.id },
      orderBy: { rank: 'asc' },
    })
    expect(blocks.map((block) => [block.sectionKey, block.rank])).toEqual([
      ['one', '000i'],
      ['two', '001i'],
    ])
    await apply(document.id, [section('mid', 'Между', 'one')])
    const read = await readArtifact(db, { artifactId: document.id, actor: person })
    expect(read.blocks.map((block) => block.key)).toEqual(['one', 'mid', 'two'])
  })

  it('keeps the agent of a chat to its workspace, and scopes opId to its author', async () => {
    const { create, apply, agent, chat } = await owner()
    const id = await create()
    await apply(id, [section('a', 'x')])
    // The same person's chat in another workspace of theirs reads nothing of this one.
    const { user } = await db.artifact
      .findUniqueOrThrow({ where: { id }, select: { owner: true } })
      .then((row) => ({ user: row.owner! }))
    const elsewhere = await db.workspace.create({
      data: { name: 'Second', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: elsewhere.id, userId: user.id, role: 'owner' } })
    const stray = await db.task.create({
      data: { id: uuidv7(), workspaceId: elsewhere.id, createdById: user.id },
    })
    expect(await codeOf(() => readArtifact(db, { artifactId: id, actor: agent(stray.id) }))).toBe(
      'ARTIFACT_NOT_FOUND',
    )
    // Two chats that made up the same opId do not share an answer.
    const first = await chat()
    const second = await chat()
    const one = await apply(id, [section('b', 'y', 'a')], agent(first), soon(), 'same-id')
    expect(one.repeated).toBe(false)
    const two = await apply(id, [section('c', 'z', 'a')], agent(second), soon(), 'same-id')
    expect(two.repeated).toBe(false)
  })

  it('drops a refused insert even after its chat rewrote it, and gives the agent no label', async () => {
    const { create, apply, agent, chat, person } = await owner()
    const id = await create()
    await apply(id, [section('a', 'Был')])
    const writer = await chat()
    await apply(id, [section('n', 'Новый', 'a')], agent(writer), soon())
    await apply(
      id,
      [{ op: 'replace', block: 'n', ifRev: 1, content: 'Новее' }],
      agent(writer),
      soon(),
    )
    await settleArtifactWrites(db, {
      taskId: writer,
      blocks: [{ artifactId: id, block: 'n', rev: 2, refusal: 'client_value' }],
    })
    const read = await readArtifact(db, { artifactId: id, actor: person })
    expect(read.blocks.map((block) => block.key)).toEqual(['a'])
    const saved = await saveArtifactVersion(db, {
      artifactId: id,
      actor: agent(writer),
      label: 'Метка агента',
    })
    const version = await readArtifactVersion(db, { artifactId: id, no: saved.no, actor: person })
    expect(version).toMatchObject({ label: null, named: false })
  })

  it('keeps the tools of plan 69 off a held block, and finishes a document a person wrote in', async () => {
    const { workspace, chat, apply } = await owner()
    const taskId = await chat()
    const document = await createChatDocument(db, {
      workspaceId: workspace.id,
      taskId,
      title: 'Аудит',
      view: 'text',
      sections: [{ key: 'one', intent: 'Первый' }],
    })
    // A person writes the section: the agent's tool waits for the lease to end.
    await apply(document.id, [
      { op: 'replace', block: 'one', ifRev: 0, content: 'Текст', props: { heading: 'Итоги' } },
    ])
    const write = () =>
      writeDocSection(db, {
        workspaceId: workspace.id,
        documentId: document.id,
        key: 'one',
        heading: 'Агент',
        markdown: 'Агент',
        taskId,
        turnNo: 1,
      })
    expect(await codeOf(write)).toBe('ARTIFACT_BLOCK_HELD')
    // The person's section counts as checked: the document gets its version.
    await requestDocFinish(db, {
      workspaceId: workspace.id,
      documentId: document.id,
      taskId,
      turnNo: 1,
    })
    const settled = await settleTurnSections(db, { taskId, turnNo: 1, sections: [] })
    expect(settled).toMatchObject([{ documentId: document.id, version: 1 }])
  })

  it('re-ranks a document of plan 69 by its positions until the operations of plan 88 write it', async () => {
    const { workspace, chat } = await owner()
    const taskId = await chat()
    const document = await createChatDocument(db, {
      workspaceId: workspace.id,
      taskId,
      title: 'Аудит',
      view: 'text',
      sections: [
        { key: 'one', intent: 'Первый' },
        { key: 'two', intent: 'Второй' },
      ],
    })
    // The code before moves by positions only.
    await db.artifactBlock.updateMany({
      where: { documentId: document.id, sectionKey: 'one' },
      data: { position: 5 },
    })
    await sweepArtifacts(db, new Date())
    const blocks = await db.artifactBlock.findMany({
      where: { documentId: document.id },
      orderBy: { rank: 'asc' },
    })
    expect(blocks.map((block) => block.sectionKey)).toEqual(['two', 'one'])
  })

  it('shows a claim’s intent once checked, forgets a refused one, and leaves one renewed meanwhile (88.4)', async () => {
    const { create, apply, chat } = await owner()
    const id = await create()
    const now = new Date()
    await apply(id, [section('a', 'Текст'), section('b', 'Ещё', 'a')], undefined, now)
    const later = new Date(now.getTime() + 40_000)
    const claimer = await chat()
    const claim = (block: string, intent: string) =>
      claimArtifactBlock(db, {
        artifactId: id,
        block,
        actor: { kind: 'agent', taskId: claimer, turnNo: 1 },
        intent,
        now: later,
      })
    await claim('a', 'Обновлю цены')
    await claim('b', 'Перепишу')
    const read = await pendingArtifactWrites(db, claimer)
    expect(
      read.map((each) => [each.sectionKey, each.leaseIntent, each.leaseIntentChecked]),
    ).toEqual([
      ['a', 'Обновлю цены', false],
      ['b', 'Перепишу', false],
    ])
    // The claim of b is renewed with another intent while the check runs.
    await claim('b', 'Перепишу иначе')
    await settleArtifactWrites(db, {
      taskId: claimer,
      blocks: [],
      claims: [
        { artifactId: id, block: 'a', intent: 'Обновлю цены', refusal: null },
        { artifactId: id, block: 'b', intent: 'Перепишу', refusal: null },
      ],
    })
    const after = await db.artifactBlock.findMany({
      where: { documentId: id },
      orderBy: { sectionKey: 'asc' },
      select: { sectionKey: true, leaseIntent: true, leaseIntentChecked: true },
    })
    expect(after).toEqual([
      { sectionKey: 'a', leaseIntent: 'Обновлю цены', leaseIntentChecked: true },
      { sectionKey: 'b', leaseIntent: 'Перепишу иначе', leaseIntentChecked: false },
    ])
    await settleArtifactWrites(db, {
      taskId: claimer,
      blocks: [],
      claims: [{ artifactId: id, block: 'b', intent: 'Перепишу иначе', refusal: 'turn_key' }],
    })
    expect(
      (await db.artifactBlock.findFirstOrThrow({ where: { documentId: id, sectionKey: 'b' } }))
        .leaseIntent,
    ).toBeNull()
    // A write under a claim refused: the intent the check read goes with it.
    await apply(
      id,
      [{ op: 'replace', block: 'a', ifRev: 1, content: 'Секрет' }],
      { kind: 'agent', taskId: claimer, turnNo: 1 },
      later,
    )
    await settleArtifactWrites(db, {
      taskId: claimer,
      blocks: [{ artifactId: id, block: 'a', rev: 2, refusal: 'turn_key', intent: 'Обновлю цены' }],
    })
    const a = await db.artifactBlock.findFirstOrThrow({
      where: { documentId: id, sectionKey: 'a' },
    })
    expect([a.leaseIntent, a.leaseIntentChecked, a.content]).toEqual([null, false, 'Текст'])
  })

  it('settles a title only as the check read it, and finds the chats whose writes are left (88.4)', async () => {
    const { create, apply, chat, agent } = await owner()
    const id = await create()
    const now = new Date()
    await apply(id, [section('a', 'Текст')], undefined, now)
    const later = new Date(now.getTime() + 40_000)
    const writer = await chat()
    await apply(id, [{ op: 'title', title: 'Первое' }], agent(writer), later)
    expect(await pendingArtifactTitles(db, writer)).toEqual([{ id, pendingTitle: 'Первое' }])
    await apply(id, [{ op: 'title', title: 'Второе' }], agent(writer), later)
    await settleArtifactWrites(db, {
      taskId: writer,
      blocks: [],
      titles: [{ artifactId: id, refusal: null, text: 'Первое' }],
    })
    const kept = await db.artifact.findUniqueOrThrow({ where: { id } })
    expect([kept.title, kept.pendingTitle]).toEqual(['Прайс', 'Второе'])
    await apply(
      id,
      [{ op: 'replace', block: 'a', ifRev: 1, content: 'Новый' }],
      agent(writer),
      later,
    )
    const hour = new Date(Date.now() + 3600_000)
    // The chat is still in its pass: left to the end of its turn.
    await db.task.update({ where: { id: writer }, data: { status: 'running' } })
    expect(await staleArtifactWriters(db, hour)).not.toContain(writer)
    await db.task.update({ where: { id: writer }, data: { status: 'failed' } })
    expect(await staleArtifactWriters(db, hour)).toContain(writer)
    expect(await staleArtifactWriters(db, new Date(Date.now() - 3600_000))).not.toContain(writer)
    // The collector's drop takes nothing while the pass runs, and only what was written before.
    await db.task.update({ where: { id: writer }, data: { status: 'running' } })
    expect(await dropStaleArtifactWrites(db, writer, hour)).toEqual([])
    await db.task.update({ where: { id: writer }, data: { status: 'failed' } })
    expect(await dropStaleArtifactWrites(db, writer, new Date(Date.now() - 3600_000))).toEqual([])
    expect((await pendingArtifactWrites(db, writer)).length).toBe(1)
    await dropStaleArtifactWrites(db, writer, hour)
    expect(await staleArtifactWriters(db, hour)).not.toContain(writer)
    expect((await db.artifact.findUniqueOrThrow({ where: { id } })).pendingTitle).toBeNull()
  })

  it('keeps a skeleton of the agent as placeholders that show their intent once checked (88.6)', async () => {
    const { workspace, chat, agent } = await owner()
    const writer = await chat()
    const id = (
      await createArtifact(db, {
        workspaceId: workspace.id,
        kind: 'document',
        title: 'План',
        view: 'page',
        actor: agent(writer),
      })
    ).id
    await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: 'skel',
        ops: [
          { op: 'insert', block: 'intro', after: null, kind: 'section', intent: 'Введение' },
          { op: 'insert', block: 'end', after: 'intro', kind: 'section', intent: 'Итог' },
        ],
      },
      actor: agent(writer),
    })
    expect(await artifactPlaceholders(db, id)).toBe(2)
    // Nobody else sees the intent before the check (Ар19).
    expect(
      (
        await readChatDocument(db, { workspaceId: workspace.id, documentId: id, reader: 'client' })
      ).sections.map((each) => each.intent),
    ).toEqual(['', ''])
    const writes = await pendingArtifactWrites(db, writer)
    await settleArtifactWrites(db, {
      taskId: writer,
      final: true,
      blocks: writes.map((each) => ({
        artifactId: each.documentId,
        block: each.sectionKey,
        rev: each.rev,
        intent: each.leaseIntent,
        refusal: null,
      })),
    })
    const doc = await readChatDocument(db, {
      workspaceId: workspace.id,
      documentId: id,
      reader: 'client',
    })
    expect(doc.view).toBe('page')
    expect(doc.sections.map((each) => [each.key, each.state, each.intent, each.markdown])).toEqual([
      ['intro', 'pending', 'Введение', null],
      ['end', 'pending', 'Итог', null],
    ])
    expect(await artifactPlaceholders(db, id)).toBe(2)
    // The chat fills one under the revision it last saw; then one placeholder is left.
    const rev = await chatLastRevOf(db, { taskId: writer, artifactId: id, block: 'intro' })
    expect(rev).toBe(1)
    await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: 'fill',
        ops: [
          {
            op: 'replace',
            block: 'intro',
            ifRev: rev!,
            content: 'Текст',
            props: { heading: 'Введение' },
          },
        ],
      },
      actor: agent(writer),
    })
    expect(await artifactPlaceholders(db, id)).toBe(1)
    // A refused write into a placeholder whose intent was never checked leaves a placeholder.
    const fresh = (
      await createArtifact(db, {
        workspaceId: workspace.id,
        kind: 'document',
        title: 'Ещё',
        actor: agent(writer),
      })
    ).id
    await applyArtifactOps(db, {
      batch: {
        artifactId: fresh,
        opId: 'skel-2',
        ops: [{ op: 'insert', block: 's', after: null, kind: 'section', intent: 'Шаги' }],
      },
      actor: agent(writer),
    })
    await applyArtifactOps(db, {
      batch: {
        artifactId: fresh,
        opId: 'fill-2',
        ops: [{ op: 'replace', block: 's', ifRev: 1, content: 'Плохо', props: { heading: 'Ш' } }],
      },
      actor: agent(writer),
    })
    const pending = (await pendingArtifactWrites(db, writer)).filter(
      (each) => each.documentId === fresh,
    )
    await settleArtifactWrites(db, {
      taskId: writer,
      blocks: pending.map((each) => ({
        artifactId: fresh,
        block: each.sectionKey,
        rev: each.rev,
        refusal: 'client_value',
      })),
    })
    const left = await readChatDocument(db, {
      workspaceId: workspace.id,
      documentId: fresh,
      reader: 'client',
    })
    expect(left.sections.map((each) => [each.key, each.state, each.intent])).toEqual([
      ['s', 'pending', 'Раздел'],
    ])
  })

  it('opens to a chat what it made, its project and the client’s own, and tells it what others changed (88.6, Ар21, Ар23)', async () => {
    const { workspace, chat, agent, create, apply, person } = await owner()
    const writer = await chat()
    const other = await chat()
    const mine = await create('document', 'Личное')
    const made = (
      await createArtifact(db, {
        workspaceId: workspace.id,
        kind: 'document',
        title: 'Чат',
        actor: agent(writer),
      })
    ).id
    expect(await chatArtifactAccess(db, { taskId: writer, artifactId: mine })).toMatchObject({
      role: 'owner',
      personal: true,
      linked: false,
    })
    expect(await chatArtifactAccess(db, { taskId: writer, artifactId: made })).toMatchObject({
      linked: true,
    })
    const listed = await listChatArtifacts(db, { taskId: writer })
    expect(listed.rows.map((row) => row.id).sort()).toEqual([made, mine].sort())
    expect(
      (await listChatArtifacts(db, { taskId: writer, scope: 'chat' })).rows.map((row) => row.id),
    ).toEqual([made])
    // An artifact of a project another chat is not in stays closed to it.
    const project = await db.project.create({
      data: {
        id: uuidv7(),
        workspaceId: workspace.id,
        name: 'Проект',
        createdById: (await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
          .createdById!,
      },
    })
    const inProject = (
      await createArtifact(db, {
        workspaceId: workspace.id,
        kind: 'document',
        title: 'Проект',
        projectId: project.id,
        actor: person,
      })
    ).id
    expect(await chatArtifactAccess(db, { taskId: writer, artifactId: inProject })).toBeNull()
    await db.task.update({ where: { id: other }, data: { projectId: project.id } })
    expect(await chatArtifactAccess(db, { taskId: other, artifactId: inProject })).toMatchObject({
      personal: false,
    })
    // News: a person's change since the read, and the chat's own write the check refused.
    await apply(mine, [section('a', 'Раз')])
    expect(
      (await artifactChatNews(db, { taskId: writer, artifactId: mine, read: true }))
        .changedSinceYourRead,
    ).toMatchObject({ count: 1, blocks: ['a'] })
    expect(
      (await artifactChatNews(db, { taskId: writer, artifactId: mine })).changedSinceYourRead.count,
    ).toBe(0)
    // A read opens nothing by itself.
    expect(
      (await listChatArtifacts(db, { taskId: writer, scope: 'chat' })).rows.map((row) => row.id),
    ).toEqual([made])
    await apply(
      mine,
      [
        {
          op: 'insert',
          block: 'b',
          after: 'a',
          kind: 'section',
          content: 'Два',
          props: { heading: 'Б' },
        },
      ],
      agent(writer),
      soon(),
    )
    const writes = await pendingArtifactWrites(db, writer)
    await settleArtifactWrites(db, {
      taskId: writer,
      blocks: writes.map((each) => ({
        artifactId: each.documentId,
        block: each.sectionKey,
        rev: each.rev,
        refusal: 'client_value',
      })),
    })
    const news = await artifactChatNews(db, { taskId: writer, artifactId: mine })
    expect(news.refusedSinceYourRead).toEqual(['b'])
    expect(news.changedSinceYourRead.count).toBe(0)
    const turns = await artifactsOfTurn(db, writer, 1)
    expect(turns.find((each) => each.artifactId === mine)).toMatchObject({
      refused: 1,
      created: false,
    })
    expect(turns.find((each) => each.artifactId === made)).toMatchObject({ created: true })
  })
})
