import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  carryBrowserChecks,
  createPrismaClient,
  recordCandidate,
  type PrismaClient,
} from '@repo/db'
import {
  absentStateHashMaterial,
  compactDbPlan,
  conflict,
  DB_CREATED_ID_BASE,
  dbPlanEntryFromJournal,
  optionStateHashMaterial,
  tableStateHashMaterial,
  type DbObjectState,
  type DbWriteRequest,
  type SiteDbGateway,
  type TableDefinition,
  previewBrowserDedupeKey,
  publishedContentHashMaterial,
  type ContentWriteProof,
  type KvSecret,
  type PublishedContentGateway,
  type PublishedContentState,
} from '@repo/domain'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { memoryStorage, memoryTransit } from '@repo/snapshots/testing'
import { PreviewDbValueStorage, previewDbValueKey } from '@repo/site-content'
import { ContentPrivacy } from '../privacy/content-privacy.ts'
import { ContentSnapshotStorage } from './content-snapshots.ts'
import { PostgresMcpAccess, type McpAccess } from '../access/mcp-access.ts'
import {
  BROWSER_CHECKS_EVENT,
  BROWSER_SCREENSHOT_EVENT,
  browserScreenshotKey,
  PostgresMcpBrowserStore,
} from '../browser/mcp-browser-store.ts'
import { McpContentMaintenance } from './mcp-content-maintenance.ts'
import { McpContentService } from './mcp-content.ts'
import { PostgresMcpJournal } from './mcp-journal.ts'

// Content writes into the preview of a dialog and the agent's browser on PostgreSQL
// (docs/plan/53-chat-preview-release.md, Р3, Р21–Р24): the admission carries the dialog's
// preview, a write into it is journalled with its own target and never touches the barrier of
// the site, its values are an operation of the plan, and the requests core answers are rows.

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** A started write whose deadline has passed. */
const pastDeadline = () => ({
  writeStartedAt: new Date(Date.now() - 20_000),
  writeDeadlineAt: new Date(Date.now() - 1_000),
})
const hashed = (fields: Omit<PublishedContentState, 'stateHash'>): PublishedContentState => ({
  ...fields,
  stateHash: hash(publishedContentHashMaterial(fields)),
})

describe.skipIf(!enabled)('MCP on the preview of a dialog with PostgreSQL', () => {
  let db: PrismaClient
  let fixture: {
    workspaceId: string
    siteId: string
    taskId: string
    driverId: string
    providerId: string
    modelId: string
    credentialId: string
    accountId: string
    keyId: string
    assignmentId: string
    previewId: string
    hostname: string
    token: string
  }
  const tracked: (typeof fixture)[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  beforeEach(async () => {
    const suffix = randomBytes(8).toString('hex')
    const token = `mcp_${randomBytes(32).toString('hex')}`
    fixture = await db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: 'Synthetic preview MCP', dataClass: 'synthetic' },
      })
      const site = await tx.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic preview MCP',
          url: `https://${suffix}.example.test`,
          stack: 'wordpress',
          status: 'active',
        },
      })
      const task = await tx.task.create({
        data: { workspaceId: workspace.id, siteId: site.id, status: 'running' },
      })
      const driver = await tx.agentDriver.create({
        data: {
          id: `mcp-${suffix}`,
          image: `synthetic@sha256:${'a'.repeat(64)}`,
          capabilities: {},
          enabled: true,
        },
      })
      const provider = await tx.llmProvider.create({
        data: { slug: `mcp-${suffix}`, name: 'Synthetic', kind: 'subscription' },
      })
      const model = await tx.llmModel.create({
        data: {
          providerId: provider.id,
          slug: `mcp-${suffix}`,
          name: 'Synthetic',
          modelClass: 'standard',
          reserveOutputTokens: 1024,
        },
      })
      const credential = await tx.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/synthetic/${suffix}` },
      })
      const account = await tx.subscriptionAccount.create({
        data: {
          providerId: provider.id,
          driverId: driver.id,
          label: `mcp-${suffix}`,
          plan: 'synthetic',
          credentialRefId: credential.id,
          maxConcurrentTurns: 1,
          maxConcurrentRequests: 1,
        },
      })
      const key = await tx.llmKey.create({
        data: {
          keyHash: hash(randomUUID()),
          mcpTokenHash: hash(token),
          taskId: task.id,
          taskAttempt: 1,
          sessionId: suffix,
          turnNo: 1,
          firstEpoch: 1,
          driverId: driver.id,
          modelId: model.id,
          subscriptionAccountId: account.id,
          budgetRub: '100',
          issuedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 300_000),
          validUntil: new Date(Date.now() + 600_000),
        },
      })
      const assignment = await tx.turnAssignment.create({
        data: {
          taskId: task.id,
          siteId: site.id,
          sessionId: suffix,
          turnNo: 1,
          executor: 'local',
          plan: {},
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(Date.now() + 600_000),
        },
      })
      await tx.siteLease.create({
        data: {
          siteId: site.id,
          holderTaskId: task.id,
          epoch: 1,
          operation: 'turn',
          expiresAt: new Date(Date.now() + 600_000),
        },
      })
      await tx.taskTurn.create({
        data: {
          taskId: task.id,
          turnNo: 1,
          status: 'running',
          driverId: driver.id,
          modelId: model.id,
          image: `synthetic@sha256:${'a'.repeat(64)}`,
        },
      })
      const hostname = `site-${suffix.slice(0, 8)}-chat-${suffix.slice(8, 14)}.localhost`
      // A built preview with its database copy, as the manager of previews leaves it (R5c).
      const preview = await tx.previewEnvironment.create({
        data: {
          siteId: site.id,
          taskId: task.id,
          status: 'ready',
          dbMode: 'copy',
          hostname,
          revision: 1,
          upstreamHost: '127.0.0.1',
          upstreamPort: 41_234,
          writeEpoch: 1,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      return {
        workspaceId: workspace.id,
        siteId: site.id,
        taskId: task.id,
        driverId: driver.id,
        providerId: provider.id,
        modelId: model.id,
        credentialId: credential.id,
        accountId: account.id,
        keyId: key.id,
        assignmentId: assignment.id,
        previewId: preview.id,
        hostname,
        token,
      }
    })
    tracked.push(fixture)
  })

  afterEach(async () => {
    const fixture = tracked.pop()
    if (!fixture) return
    await db.outboxEvent.deleteMany({ where: { dedupeKey: { contains: fixture.previewId } } })
    await db.taskEvent.deleteMany({ where: { taskId: fixture.taskId } })
    await db.previewDbOperation.deleteMany({ where: { taskId: fixture.taskId } })
    await db.previewSyncRequest.deleteMany({ where: { previewId: fixture.previewId } })
    await db.previewBrowserRequest.deleteMany({ where: { previewId: fixture.previewId } })
    await db.previewSeedMismatch.deleteMany({ where: { previewId: fixture.previewId } })
    await db.llmKey.deleteMany({ where: { taskId: fixture.taskId } })
    await db.siteLease.deleteMany({ where: { siteId: fixture.siteId } })
    await db.mcpCall.deleteMany({ where: { turn: { taskId: fixture.taskId } } })
    await db.snapshot.deleteMany({ where: { taskId: fixture.taskId } })
    await db.taskCandidate.deleteMany({ where: { taskId: fixture.taskId } })
    await db.previewEnvironment.deleteMany({ where: { taskId: fixture.taskId } })
    await db.taskTurn.deleteMany({ where: { taskId: fixture.taskId } })
    await db.turnAssignment.deleteMany({ where: { taskId: fixture.taskId } })
    await db.task.delete({ where: { id: fixture.taskId } })
    await db.site.delete({ where: { id: fixture.siteId } })
    await db.workspace.delete({ where: { id: fixture.workspaceId } })
    await db.subscriptionAccount.delete({ where: { id: fixture.accountId } })
    await db.credentialRef.delete({ where: { id: fixture.credentialId } })
    await db.llmModel.delete({ where: { id: fixture.modelId } })
    await db.llmProvider.delete({ where: { id: fixture.providerId } })
    await db.agentDriver.delete({ where: { id: fixture.driverId } })
  })

  async function admitted(): Promise<McpAccess> {
    const scope = await new PostgresMcpAccess(db).authenticate(fixture.token)
    expect(scope).not.toBeNull()
    return scope!
  }

  /** The content profile on the preview: a WordPress copy kept in memory, real journal and storage. */
  async function previewFixture() {
    const scope = await admitted()
    const memory = memoryStorage()
    const transit = memoryTransit()
    const records = new Map<string, KvSecret>()
    const secrets = {
      ...transit.secrets,
      kvRead: vi.fn(async (path: string) => records.get(path) ?? null),
      kvWrite: vi.fn(
        async (path: string, data: Record<string, string>, options?: { cas?: number }) => {
          const version = records.get(path)?.version ?? 0
          if (options?.cas !== version) throw conflict('Synthetic CAS mismatch')
          records.set(path, { data, version: version + 1 })
          return { version: version + 1 }
        },
      ),
    }
    const initial = (objectRef: string) =>
      hashed({
        version: 1,
        objectRef,
        kind: 'post',
        title: 'До',
        content: '<p>Текст</p>',
        excerpt: '',
      })
    const states = new Map<string, PublishedContentState>()
    const stateOf = (objectRef: string) => states.get(objectRef) ?? initial(objectRef)
    const sent: Array<{ siteId: string; epoch: number }> = []
    let loseAcknowledgement = false
    const preview: PublishedContentGateway = {
      read: vi.fn(async (objectRef: string) => ({ ...stateOf(objectRef) })),
      conditionalWrite: vi.fn<PublishedContentGateway['conditionalWrite']>(async (input) => {
        // A write into the preview never holds the site (Р24).
        const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
        expect(lease.inflightMcpCallId).toBeNull()
        const call = await db.mcpCall.findUniqueOrThrow({ where: { id: input.callId } })
        expect(call.writeStartedAt).not.toBeNull()
        // Its durable mark instead, before anything is sent: whatever becomes of this process,
        // the preview no longer shows its revision and the next rebuild closes the call.
        expect(
          await db.previewEnvironment.findUniqueOrThrow({ where: { id: fixture.previewId } }),
        ).toMatchObject({ dirty: true })
        sent.push({ siteId: input.siteId, epoch: input.epoch })
        const current = stateOf(input.objectRef)
        if (current.stateHash !== input.expectedStateHash)
          return { version: 1, kind: 'rejected', code: 'conflict' }
        const state = hashed({ ...current, ...input.fields })
        states.set(input.objectRef, state)
        const proof: ContentWriteProof = {
          version: 1,
          kind: 'committed',
          callId: input.callId,
          siteId: input.siteId,
          epoch: input.epoch,
          requestHash: input.requestHash,
          objectRef: input.objectRef,
          stateHash: state.stateHash,
        }
        if (loseAcknowledgement) throw new Error('Synthetic lost preview acknowledgement')
        return proof
      }),
      operation: vi.fn(async () => null),
      reconcileOperation: vi.fn(),
      forgetOperation: vi.fn(),
    }
    const values = new PreviewDbValueStorage(memory.storage, transit.secrets)
    const site = vi.fn(async (): Promise<PublishedContentGateway> => {
      throw new Error('The site must not be reached')
    })
    const service = new McpContentService(
      new PostgresMcpJournal(db),
      new ContentSnapshotStorage(memory.storage, transit.secrets),
      new ContentPrivacy(secrets),
      site,
      {
        siteContent: false,
        previews: { resolve: async () => preview, values },
        dbSettings: () => [
          {
            option: 'blogname',
            setting: 'title',
            label: 'Название сайта',
            value: 'text',
            maxBytes: 200,
            display: 'html_text',
          },
        ],
      },
    )
    const edit = (key: string, fields: Record<string, string> = { title: key }, post = 42) =>
      service.wpRest(scope, {
        method: 'POST',
        route: `/wp/v2/posts/${post}`,
        body: fields,
        idempotencyKey: key,
      })
    return {
      scope,
      memory,
      transit,
      preview,
      values,
      site,
      service,
      edit,
      sent,
      stateOf,
      loseAcknowledgement: (lose = true) => {
        loseAcknowledgement = lose
      },
    }
  }

  it('admits the turn with the preview of its dialog, never one of another', async () => {
    const scope = await admitted()
    expect(scope.preview).toEqual({
      id: fixture.previewId,
      status: 'ready',
      database: true,
      hostname: fixture.hostname,
    })
    await db.previewEnvironment.update({
      where: { id: fixture.previewId },
      data: { status: 'unavailable', unavailableReason: 'no_database', dbMode: 'none' },
    })
    expect((await admitted()).preview).toMatchObject({ status: 'unavailable', database: false })
    await db.previewEnvironment.delete({ where: { id: fixture.previewId } })
    expect((await admitted()).preview).toBeNull()
  })

  it('writes into the preview under its own target and leaves the site barrier alone', async () => {
    const f = await previewFixture()
    const outcome = await f.edit('first', { title: 'После' })
    expect(outcome).toMatchObject({ result: 'ok' })
    // The plugin of the copy is bound to the preview and fenced by its write epoch.
    expect(f.sent).toEqual([{ siteId: fixture.previewId, epoch: 1 }])
    expect(f.site).not.toHaveBeenCalled()
    const call = await db.mcpCall.findFirstOrThrow({
      where: { turn: { taskId: fixture.taskId } },
      include: { snapshot: true },
    })
    expect(call).toMatchObject({
      previewId: fixture.previewId,
      previewWriteEpoch: 1,
      result: 'ok',
      objectRef: 'post:42',
    })
    expect(call.snapshot?.previewId).toBe(fixture.previewId)
    const lease = await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } })
    expect(lease).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
  })

  it('records each write as an operation of the plan with both states sealed', async () => {
    const f = await previewFixture()
    await f.edit('title', { title: 'После' })
    await f.edit('text', { content: '<p>Новый</p>', title: 'Ещё' })
    const rows = await db.previewDbOperation.findMany({
      where: { taskId: fixture.taskId },
      orderBy: { id: 'asc' },
    })
    expect(
      rows.map((row) => [row.kind, row.objectRef, row.fields, row.turnNo, row.excluded]),
    ).toEqual([
      ['content_update', 'post:42', ['title'], 1, false],
      ['content_update', 'post:42', ['title', 'content'], 1, false],
    ])
    // The second write starts where the first left the object.
    expect(rows[1]!.beforeHash).toBe(rows[0]!.afterHash)
    expect(rows[1]!.afterHash).toBe(f.stateOf('post:42').stateHash)
    for (const row of rows) {
      const entry = dbPlanEntryFromJournal(row)
      expect(entry.operation.kind).toBe('content_update')
      for (const side of ['before', 'after'] as const) {
        const value = entry.operation[side]
        expect(value.key).toBe(
          previewDbValueKey({ taskId: fixture.taskId, callId: row.mcpCallId, side }),
        )
        const state = await f.values.load(
          {
            workspaceId: fixture.workspaceId,
            taskId: fixture.taskId,
            previewId: fixture.previewId,
            callId: row.mcpCallId,
            side,
            objectRef: 'post:42',
          },
          value,
        )
        expect(state.stateHash).toBe(side === 'before' ? row.beforeHash : row.afterHash)
      }
    }
    // A repeated key replays and adds no operation.
    await f.edit('title', { title: 'После' })
    expect(await db.previewDbOperation.count({ where: { taskId: fixture.taskId } })).toBe(2)
  })

  it('gives created records ids of their own and keeps a plan of every kind', async () => {
    const f = await previewFixture()
    await db.previewEnvironment.update({
      where: { id: fixture.previewId },
      data: {
        runtime: {
          v: 1,
          database: null,
          web: null,
          seedChecked: true,
          sync: null,
          db: {
            kinds: ['content_update', 'option_update', 'post_create', 'schema_migration'],
            settings: ['blogname'],
            createdIds: true,
          },
        },
      },
    })
    const scope = await admitted()
    expect(scope.preview?.dbKinds).toContain('schema_migration')
    // The database of the preview in memory: settings and tables beside the records.
    const options = new Map<string, string | null>([['option:blogname', 'Цветы']])
    const tables = new Map<string, TableDefinition>()
    const optionState = (objectRef: string): DbObjectState => {
      const value = options.get(objectRef) ?? null
      return {
        version: 1,
        objectRef,
        value,
        stateHash: hash(optionStateHashMaterial({ objectRef, value })),
      }
    }
    const tableState = (objectRef: string): DbObjectState => {
      const definition = tables.get(objectRef) ?? null
      const state = {
        version: 1 as const,
        objectRef,
        exists: definition !== null,
        managed: definition !== null,
        definition,
      }
      return { ...state, stateHash: hash(tableStateHashMaterial(state)) }
    }
    const created = new Map<string, PublishedContentState>()
    const recordState = (objectRef: string): DbObjectState =>
      created.get(objectRef) ?? {
        version: 1,
        objectRef,
        absent: true,
        stateHash: hash(absentStateHashMaterial(objectRef)),
      }
    const readObject = async (objectRef: string): Promise<DbObjectState> =>
      objectRef.startsWith('option:')
        ? optionState(objectRef)
        : objectRef.startsWith('table:')
          ? tableState(objectRef)
          : recordState(objectRef)
    const committed = (input: DbWriteRequest, stateHash: string) => ({
      version: 1 as const,
      kind: 'committed' as const,
      callId: input.callId,
      siteId: input.siteId,
      epoch: input.epoch,
      requestHash: input.requestHash,
      objectRef: input.objectRef,
      stateHash,
      ...(input.change.kind === 'post_create' ? { createdRef: input.objectRef } : {}),
    })
    const preview = f.preview as {
      db?: SiteDbGateway
      read: PublishedContentGateway['read']
      conditionalWrite: PublishedContentGateway['conditionalWrite']
    }
    const read = preview.read
    const conditionalWrite = preview.conditionalWrite
    preview.read = async (objectRef) => created.get(objectRef) ?? read(objectRef)
    preview.conditionalWrite = async (input) => {
      const record = created.get(input.objectRef)
      if (!record) return conditionalWrite(input)
      if (record.stateHash !== input.expectedStateHash)
        return { version: 1, kind: 'rejected', code: 'conflict' }
      const state = hashed({ ...record, ...input.fields })
      created.set(input.objectRef, state)
      return {
        ...committed({ ...input, change: { kind: 'option_update', value: '' } }, state.stateHash),
      }
    }
    preview.db = {
      capabilities: async () => ({
        version: 1,
        kind: 'capabilities',
        plugin: 2,
        operations: ['content_update', 'option_update', 'post_create', 'schema_migration'],
        settings: ['blogname'],
        maxRecordId: 50,
        nextCreatedId: DB_CREATED_ID_BASE,
      }),
      readObject,
      slugTaken: async () => false,
      dependents: async () => 0,
      operation: async () => null,
      reconcile: async () => ({ version: 1, kind: 'unknown' }),
      fence: async () => undefined,
      writeObject: async (input) => {
        const current = await readObject(input.objectRef)
        if (current.stateHash !== input.expectedStateHash)
          return { version: 1, kind: 'rejected', code: 'conflict' }
        const change = input.change
        if (change.kind === 'option_update') options.set(input.objectRef, change.value)
        else if (change.kind === 'schema_migration') {
          if (change.definition) tables.set(input.objectRef, change.definition)
          else tables.delete(input.objectRef)
        } else if (change.kind === 'post_create')
          created.set(
            input.objectRef,
            hashed({
              version: 1,
              objectRef: input.objectRef,
              kind: 'page',
              status: change.record.status,
              slug: change.record.slug,
              title: change.record.title,
              content: change.record.content,
              excerpt: change.record.excerpt,
            }),
          )
        else created.delete(input.objectRef)
        return committed(input, (await readObject(input.objectRef)).stateHash)
      },
    }
    const create = (key: string, slug: string) =>
      f.service.wpRest(scope, {
        method: 'POST',
        route: '/wp/v2/pages',
        body: { title: slug, slug, status: 'publish' },
        idempotencyKey: key,
      })
    const first = await create('prices', 'prices')
    expect(first).toMatchObject({
      result: 'ok',
      response: { objectRef: `page:${DB_CREATED_ID_BASE}` },
    })
    // A repeat of the key is the same call and the same record.
    expect(await create('prices', 'prices')).toEqual(first)
    const second = await create('team', 'team')
    expect(second).toMatchObject({ response: { objectRef: `page:${DB_CREATED_ID_BASE + 1}` } })
    // The later edit of a created record, a setting, a table.
    expect(
      await f.service.wpRest(scope, {
        method: 'POST',
        route: `/wp/v2/pages/${DB_CREATED_ID_BASE}`,
        body: { content: '<p>Букеты</p>' },
        idempotencyKey: 'prices-text',
      }),
    ).toMatchObject({ result: 'ok' })
    // A record above the base that no creation of the dialog made — the preview's own, published
    // past a created id — is not on production: its change is refused at once.
    preview.read = async (objectRef) =>
      objectRef === `page:${DB_CREATED_ID_BASE + 5}`
        ? hashed({ ...created.get(`page:${DB_CREATED_ID_BASE}`)!, objectRef })
        : (created.get(objectRef) ?? read(objectRef))
    await expect(
      f.service.wpRest(scope, {
        method: 'POST',
        route: `/wp/v2/pages/${DB_CREATED_ID_BASE + 5}`,
        body: { title: 'Черновик предпросмотра' },
        idempotencyKey: 'native',
      }),
    ).rejects.toMatchObject({ code: 'DB_OPERATION_NOT_ALLOWED' })
    expect(
      await f.service.wpRest(scope, {
        method: 'POST',
        route: '/wp/v2/settings',
        body: { title: 'Цветы у дома' },
        idempotencyKey: 'rename',
      }),
    ).toMatchObject({ result: 'ok', response: { setting: 'title' } })
    expect(
      await f.service.dbSchema(scope, {
        method: 'POST',
        table: 'bookings',
        create: { columns: [{ name: 'name', type: 'string', length: 120, nullable: false }] },
        idempotencyKey: 'bookings',
      }),
    ).toMatchObject({ result: 'ok' })
    // The second page goes to the trash: the restore of the snapshot its creation took.
    const creation = await db.mcpCall.findFirstOrThrow({
      where: { objectRef: `page:${DB_CREATED_ID_BASE + 1}`, tool: 'wp_rest' },
    })
    expect(
      await f.service.restore(scope, {
        snapshotId: creation.snapshotId!,
        idempotencyKey: 'undo-team',
      }),
    ).toMatchObject({ result: 'ok', response: { restored: true } })
    // A value naming a created id is refused once the journal knows it.
    expect(
      await f.service.wpRest(scope, {
        method: 'POST',
        route: '/wp/v2/posts/42',
        body: { content: `<a href="/?page_id=${DB_CREATED_ID_BASE}">Цены</a>` },
        idempotencyKey: 'linked',
      }),
    ).toEqual({ result: 'error', response: { code: 'CONTENT_CREATED_ID' } })
    const rows = await db.previewDbOperation.findMany({
      where: { taskId: fixture.taskId },
      orderBy: { id: 'asc' },
    })
    expect(rows.map((row) => [row.kind, row.objectRef, row.fields])).toEqual([
      ['post_create', `page:${DB_CREATED_ID_BASE}`, ['title', 'content', 'excerpt']],
      ['post_create', `page:${DB_CREATED_ID_BASE + 1}`, ['title', 'content', 'excerpt']],
      ['content_update', `page:${DB_CREATED_ID_BASE}`, ['content']],
      ['option_update', 'option:blogname', ['value']],
      ['schema_migration', 'table:bookings', ['definition']],
      ['post_trash', `page:${DB_CREATED_ID_BASE + 1}`, []],
    ])
    const plan = compactDbPlan(rows.map((row) => dbPlanEntryFromJournal(row)))
    expect(plan.map((operation) => [operation.kind, operation.objectRef])).toEqual([
      ['schema_migration', 'table:bookings'],
      ['option_update', 'option:blogname'],
      ['post_create', `page:${DB_CREATED_ID_BASE}`],
    ])
    // The creation carries the text written after it; both sides open as their states.
    const value = (row: (typeof rows)[number], side: 'before' | 'after') =>
      f.values.loadState(
        {
          workspaceId: fixture.workspaceId,
          taskId: fixture.taskId,
          previewId: fixture.previewId,
          callId: row.mcpCallId,
          side,
          objectRef: row.objectRef,
        },
        dbPlanEntryFromJournal(row).operation[side],
      )
    expect(await value(rows[0]!, 'before')).toMatchObject({ absent: true })
    expect(await value(rows[2]!, 'after')).toMatchObject({
      content: '<p>Букеты</p>',
      slug: 'prices',
    })
    // A failed turn leaves its rows excluded; a new creation still gets an id no turn used.
    await db.previewDbOperation.updateMany({
      where: { taskId: fixture.taskId },
      data: { excluded: true },
    })
    expect(await create('again', 'again')).toMatchObject({
      response: { objectRef: `page:${DB_CREATED_ID_BASE + 2}` },
    })
  })

  it('refuses an object the seed did not find equal to production', async () => {
    const f = await previewFixture()
    await db.previewSeedMismatch.create({
      data: { previewId: fixture.previewId, objectRef: 'post:42' },
    })
    await expect(f.edit('mismatch')).rejects.toMatchObject({ code: 'CONTENT_OBJECT_UNAVAILABLE' })
    expect(await f.edit('other', { title: 'После' }, 43)).toMatchObject({ result: 'ok' })
  })

  it('takes no content while the preview is built, or without its database', async () => {
    const f = await previewFixture()
    await db.previewEnvironment.update({
      where: { id: fixture.previewId },
      data: { status: 'building', upstreamHost: null, upstreamPort: null },
    })
    await expect(f.edit('building')).rejects.toMatchObject({ code: 'CONTENT_PREVIEW_NOT_READY' })
    await expect(
      f.service.wpRest(f.scope, { method: 'GET', route: '/wp/v2/posts/42' }),
    ).rejects.toMatchObject({ code: 'CONTENT_PREVIEW_NOT_READY' })
    await db.previewEnvironment.update({
      where: { id: fixture.previewId },
      data: { status: 'ready', upstreamHost: '127.0.0.1', upstreamPort: 41_234, dbMode: 'none' },
    })
    await expect(f.edit('none')).rejects.toMatchObject({ code: 'CONTENT_PREVIEW_UNAVAILABLE' })
    expect(await db.mcpCall.count({ where: { turn: { taskId: fixture.taskId } } })).toBe(0)
  })

  it('keeps a write of unknown outcome open and the preview dirty until a reset replaces its database', async () => {
    const f = await previewFixture()
    f.loseAcknowledgement()
    await expect(f.edit('lost')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const open = await db.mcpCall.findFirstOrThrow({ where: { turn: { taskId: fixture.taskId } } })
    expect(open).toMatchObject({ result: null, previewId: fixture.previewId })
    expect(open.writeStartedAt).not.toBeNull()
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: fixture.previewId } }),
    ).toMatchObject({ dirty: true })
    // The site is not held for it: neither its barrier nor the operator.
    expect(
      await db.siteLease.findUniqueOrThrow({ where: { siteId: fixture.siteId } }),
    ).toMatchObject({ inflightMcpCallId: null, heldForOperator: false })
    // No other write enters the preview meanwhile.
    f.loseAcknowledgement(false)
    await expect(f.edit('blocked', { title: 'X' }, 43)).rejects.toMatchObject({
      code: 'MCP_CALL_IN_FLIGHT',
    })
    // A reset (R5c) moves the write epoch and waits for the deadline of the open write.
    await db.mcpCall.update({ where: { id: open.id }, data: pastDeadline() })
    await db.previewEnvironment.update({
      where: { id: fixture.previewId },
      data: { writeEpoch: 2, dirty: false },
    })
    expect(await f.edit('after reset', { title: 'X' }, 43)).toMatchObject({ result: 'ok' })
    expect(await db.mcpCall.findUniqueOrThrow({ where: { id: open.id } })).toMatchObject({
      result: 'error',
      response: { code: 'CONTENT_PREVIEW_RESET' },
    })
    expect(f.sent.at(-1)).toEqual({ siteId: fixture.previewId, epoch: 2 })
    // The lost write left no operation of the plan.
    expect(
      await db.previewDbOperation.findMany({ where: { taskId: fixture.taskId } }),
    ).toHaveLength(1)
  })

  it('leaves a write its process never finished open, its preview dirty, until a rebuild', async () => {
    const f = await previewFixture()
    // The process is gone right after it sent the write: neither its finish nor its mark of
    // an unknown outcome reach the journal.
    vi.mocked(f.preview.conditionalWrite).mockImplementationOnce(async () => {
      throw new Error('Synthetic end of the process')
    })
    const journal = PostgresMcpJournal.prototype
    const finish = vi.spyOn(journal, 'finish').mockRejectedValueOnce(new Error('gone'))
    const ambiguous = vi.spyOn(journal, 'markAmbiguous').mockRejectedValueOnce(new Error('gone'))
    await expect(f.edit('gone')).rejects.toBeDefined()
    finish.mockRestore()
    ambiguous.mockRestore()
    const open = await db.mcpCall.findFirstOrThrow({ where: { turn: { taskId: fixture.taskId } } })
    expect(open).toMatchObject({ result: null, previewId: fixture.previewId })
    expect(open.writeStartedAt).not.toBeNull()
    // Dirty: R5c rebuilds it once the turn is over (a write may have landed in its database).
    expect(
      await db.previewEnvironment.findUniqueOrThrow({ where: { id: fixture.previewId } }),
    ).toMatchObject({ dirty: true })
    await expect(f.edit('blocked', { title: 'X' }, 43)).rejects.toMatchObject({
      code: 'MCP_CALL_IN_FLIGHT',
    })
    // The rebuild under a new epoch waited for the deadline; the next write closes the call.
    await db.mcpCall.update({ where: { id: open.id }, data: pastDeadline() })
    await db.previewEnvironment.update({
      where: { id: fixture.previewId },
      data: { writeEpoch: 2, dirty: false },
    })
    expect(await f.edit('after rebuild', { title: 'X' }, 43)).toMatchObject({ result: 'ok' })
    expect(await db.mcpCall.findUniqueOrThrow({ where: { id: open.id } })).toMatchObject({
      result: 'error',
      response: { code: 'CONTENT_PREVIEW_RESET' },
    })
  })

  it('closes calls of a replaced preview database from maintenance, and nothing else', async () => {
    const f = await previewFixture()
    f.loseAcknowledgement()
    await expect(f.edit('lost')).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    const maintenance = new McpContentMaintenance(
      db,
      f.memory.storage,
      f.transit.secrets as never,
      vi.fn(),
    )
    // The epoch did not move: the call stays open.
    expect(await maintenance.closePreviewWrites({ siteId: fixture.siteId })).toEqual({
      closed: 0,
      more: false,
    })
    await db.previewEnvironment.update({
      where: { id: fixture.previewId },
      data: { writeEpoch: 2 },
    })
    // Moved, but the deadline of the write is still ahead: still open.
    expect((await maintenance.closePreviewWrites({ siteId: fixture.siteId })).closed).toBe(0)
    await db.mcpCall.updateMany({
      where: { turn: { taskId: fixture.taskId } },
      data: pastDeadline(),
    })
    expect((await maintenance.closePreviewWrites({ siteId: fixture.siteId })).closed).toBe(1)
    // The site's own recovery never sees a write into a preview.
    expect((await maintenance.recoverWrites({ siteId: fixture.siteId })).visited).toBe(0)
  })

  it('removes the screenshots and the values of the plan with the masks once the task is over', async () => {
    const f = await previewFixture()
    await f.edit('edit', { title: 'После' })
    const store = new PostgresMcpBrowserStore(db)
    const admission = await store.admit(f.scope)
    const shot = randomUUID()
    await store.recordScreenshot(admission, fixture.taskId, shot, randomUUID())
    await f.memory.storage.put(
      'artifacts',
      browserScreenshotKey(fixture.taskId, shot),
      new Uint8Array(8),
    )
    const operation = await db.previewDbOperation.findFirstOrThrow({
      where: { taskId: fixture.taskId },
    })
    const keys = [
      browserScreenshotKey(fixture.taskId, shot),
      operation.beforeObjectKey,
      operation.afterObjectKey,
    ]
    for (const key of keys) expect(f.memory.objects.has(key), key).toBe(true)
    // An object of another task is never in the list.
    const foreign = `tasks/${randomUUID()}/screenshots/${randomUUID()}.png`
    await f.memory.storage.put('artifacts', foreign, new Uint8Array(8))
    const maintenance = new McpContentMaintenance(
      db,
      f.memory.storage,
      { kvDestroyAll: vi.fn(async () => undefined) },
      vi.fn(),
    )
    // The description of the plan, its values in clear, goes with the values.
    await db.taskCandidate.create({
      data: {
        taskId: fixture.taskId,
        revision: 1,
        turnNo: 1,
        status: 'released',
        baseSha: 'a'.repeat(40),
        baseTree: 'b'.repeat(40),
        headSha: 'c'.repeat(40),
        dbPlanSha256: 'd'.repeat(64),
        proposedBump: 'patch',
        proposedVersion: 'v1.0.1',
        facts: {},
        dbView: { v: 1, operations: [] },
        dbViewSha256: 'e'.repeat(64),
      },
    })
    // While the dialog runs, nothing goes.
    expect(await maintenance.sweepMasks({ siteId: fixture.siteId })).toMatchObject({ purged: 0 })
    for (const key of keys) expect(f.memory.objects.has(key), key).toBe(true)

    // The dialog closed longer ago than the undo window, its turn and its key are over.
    await db.turnAssignment.update({
      where: { id: fixture.assignmentId },
      data: { finishedAt: new Date(), outcome: 'completed' },
    })
    await db.siteLease.delete({ where: { siteId: fixture.siteId } })
    await db.llmKey.update({
      where: { id: fixture.keyId },
      data: { revokeRequestedAt: new Date() },
    })
    await db.snapshot.updateMany({
      where: { taskId: fixture.taskId },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    })
    await db.mcpCall.updateMany({
      where: { turn: { taskId: fixture.taskId } },
      data: pastDeadline(),
    })
    await db.task.update({
      where: { id: fixture.taskId },
      data: { status: 'done', finishedAt: new Date(Date.now() - 8 * 86_400_000) },
    })
    // The snapshots of the preview's edits go first; the masks wait for them.
    expect(await maintenance.sweepSnapshots({ siteId: fixture.siteId })).toMatchObject({
      purged: 1,
      failed: 0,
    })
    expect(await maintenance.sweepMasks({ siteId: fixture.siteId })).toMatchObject({
      purged: 1,
      failed: 0,
    })
    for (const key of keys) expect(f.memory.objects.has(key), key).toBe(false)
    expect(f.memory.objects.has(foreign)).toBe(true)
    expect(
      (await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).contentMasksPurgedAt,
    ).not.toBeNull()
    expect(
      await db.taskCandidate.findFirstOrThrow({
        where: { taskId: fixture.taskId },
        select: { dbView: true, dbViewSha256: true },
      }),
    ).toEqual({ dbView: null, dbViewSha256: null })
  })

  it('never returns writes into a preview through the trusted undo of the site', async () => {
    const f = await previewFixture()
    await f.edit('edit', { title: 'После' })
    const journal = new PostgresMcpJournal(db)
    const fence = {
      siteId: fixture.siteId,
      taskId: fixture.taskId,
      operation: 'turn' as const,
      epoch: 1,
    }
    const host = await journal.hostScope(fence, fixture.taskId)
    expect(await journal.taskSnapshots(host)).toEqual([])
    expect(await journal.turnSnapshots(host, 1)).toEqual([])
    expect(await f.service.undoTask({ fence, targetTaskId: fixture.taskId })).toEqual({
      restored: 0,
    })
    expect(f.site).not.toHaveBeenCalled()
  })

  it('restores an edit of the turn into the preview it was made in', async () => {
    const f = await previewFixture()
    const edited = await f.edit('edit', { title: 'После' })
    const snapshotId = (edited.response as { snapshotId: string }).snapshotId
    expect(await f.service.restore(f.scope, { snapshotId, idempotencyKey: 'undo' })).toMatchObject({
      result: 'ok',
      response: { restored: true, snapshotId },
    })
    expect(f.stateOf('post:42').title).toBe('До')
    expect(f.sent).toHaveLength(2)
    // The restore is an operation too: the plan compacts the object back to its start.
    const rows = await db.previewDbOperation.findMany({ where: { taskId: fixture.taskId } })
    expect(rows.map((row) => row.fields)).toEqual([['title'], ['title']])
    expect(rows[1]!.afterHash).toBe(rows[0]!.beforeHash)
  })

  describe('the browser store', () => {
    it('admits a browser call with its turn and its preview, and marks content as accessed', async () => {
      const store = new PostgresMcpBrowserStore(db)
      const admission = await store.admit(await admitted())
      expect(admission).toMatchObject({
        assignmentId: fixture.assignmentId,
        turnNo: 1,
        preview: {
          id: fixture.previewId,
          status: 'ready',
          hostname: fixture.hostname,
          database: true,
          revision: 1,
        },
      })
      expect(admission.turnId).not.toBeNull()
      expect(
        (await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).contentAccessedAt,
      ).not.toBeNull()
      await db.turnAssignment.update({
        where: { id: fixture.assignmentId },
        data: { finishedAt: new Date(), outcome: 'completed' },
      })
      await expect(store.admit(await admittedOrNull())).rejects.toMatchObject({
        code: 'LEASE_LOST',
      })
    })

    async function admittedOrNull() {
      // The token's scope from before the turn ended: what a late request still carries.
      return {
        keyId: fixture.keyId,
        taskId: fixture.taskId,
        workspaceId: fixture.workspaceId,
        siteId: fixture.siteId,
        sessionId: (await db.llmKey.findUniqueOrThrow({ where: { id: fixture.keyId } })).sessionId,
        turn: 1,
        firstEpoch: 1,
        epoch: 1,
        stack: 'wordpress' as const,
        url: `https://site.example.test`,
        preview: {
          id: fixture.previewId,
          status: 'ready' as const,
          database: true,
          hostname: fixture.hostname,
        },
      }
    }

    it('asks core for a sync and for a browser by rows, the browser with its job', async () => {
      const store = new PostgresMcpBrowserStore(db)
      const admission = await store.admit(await admitted())
      const sync = await store.requestSync(admission)
      expect(await store.syncState(sync)).toEqual({ id: sync, done: false, errorCode: null })
      await db.previewSyncRequest.update({
        where: { id: sync },
        data: { completedAt: new Date(), filesDigest: 'f'.repeat(64) },
      })
      expect(await store.syncState(sync)).toEqual({ id: sync, done: true, errorCode: null })
      expect(await db.previewSyncRequest.findUniqueOrThrow({ where: { id: sync } })).toMatchObject({
        previewId: fixture.previewId,
        assignmentId: fixture.assignmentId,
      })

      const first = await store.requestBrowser(admission, false)
      // The open request of the turn is reused; a fresh one is a new row with its own job.
      expect(await store.requestBrowser(admission, false)).toBe(first)
      const jobs = await db.outboxEvent.findMany({
        where: {
          dedupeKey: previewBrowserDedupeKey({ previewId: fixture.previewId, requestId: first }),
        },
      })
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({
        topic: 'previews',
        type: 'preview.browser',
        payload: { previewId: fixture.previewId, requestId: first },
      })
      expect(await store.browserState(first)).toEqual({ id: first, done: false, errorCode: null })
      await db.previewBrowserRequest.update({ where: { id: first }, data: { readyAt: new Date() } })
      expect(await store.browserState(first)).toEqual({ id: first, done: true, errorCode: null })
      // Core stopped an idle browser: that request no longer serves.
      await db.previewBrowserRequest.update({
        where: { id: first },
        data: { stoppedAt: new Date() },
      })
      expect(await store.browserState(first)).toEqual({
        id: first,
        done: true,
        errorCode: 'stopped',
      })
      const second = await store.requestBrowser(admission, false)
      expect(second).not.toBe(first)
      const third = await store.requestBrowser(admission, true)
      expect(third).not.toBe(second)
      expect(
        await db.outboxEvent.count({ where: { dedupeKey: { contains: fixture.previewId } } }),
      ).toBe(3)
    })

    it('records a run with the sync it looked at, and the pass of the turn carries it', async () => {
      const f = await previewFixture()
      const store = new PostgresMcpBrowserStore(db)
      const admission = await store.admit(f.scope)
      /** A sync as core answers it (R5c): the working tree on the preview, which is dirty. */
      const synced = async (files: string) => {
        const id = await store.requestSync(admission)
        await db.previewSyncRequest.update({
          where: { id },
          data: { completedAt: new Date(), filesDigest: files },
        })
        await db.previewEnvironment.update({
          where: { id: fixture.previewId },
          data: { dirty: true },
        })
        return id
      }
      const run = async (sync: string, counts = { total: 2, passed: 1, failed: 1 }) => {
        await store.recordChecks(admission, fixture.taskId, counts, sync)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      /** What the pass of the turn does (R3): records the candidate, then carries the run. */
      const settle = (revision: number) =>
        db.$transaction(async (tx) => {
          const recorded = await recordCandidate(tx, {
            taskId: fixture.taskId,
            revision,
            turnNo: 1,
            baseSha: 'a'.repeat(40),
            baseTree: 'b'.repeat(40),
            baseVersion: null,
            headSha: 'c'.repeat(40),
            files: [],
            media: [],
            dbPlan: [],
            dbPlanSha256: hash('[]'),
            proposedBump: 'patch',
            proposedVersion: 'v0.0.1',
            facts: {
              changeType: 'content',
              risk: 'low',
              addedFiles: 0,
              modifiedFiles: 0,
              deletedFiles: 0,
              mediaFiles: 0,
              dbObjects: 1,
              newFunctionality: false,
            },
            checks: ['preview_smoke'],
            installed: null,
          })
          const carried = await carryBrowserChecks(tx, {
            taskId: fixture.taskId,
            candidateId: recorded.id,
            turnNo: 1,
          })
          return { ...recorded, carried }
        })

      // The preview shows the turn's working state: a run names no candidate.
      const tree = await synced('a'.repeat(64))
      await run(tree)
      await run(tree, { total: 3, passed: 3, failed: 0 })
      const events = await db.taskEvent.findMany({
        where: { taskId: fixture.taskId, type: BROWSER_CHECKS_EVENT },
        orderBy: { id: 'asc' },
      })
      expect(events.map((event) => [event.clientVisible, event.payload])).toEqual([
        [
          false,
          {
            v: 1,
            turn: 1,
            total: 2,
            passed: 1,
            failed: 1,
            previewId: fixture.previewId,
            syncRequestId: tree,
          },
        ],
        [
          false,
          {
            v: 1,
            turn: 1,
            total: 3,
            passed: 3,
            failed: 0,
            previewId: fixture.previewId,
            syncRequestId: tree,
          },
        ],
      ])
      expect(
        await db.candidateCheck.count({ where: { candidate: { taskId: fixture.taskId } } }),
      ).toBe(0)
      // A screenshot after the run is a later look at the same tree.
      await synced('a'.repeat(64))
      const first = await settle(1)
      expect(first.carried).toBe(true)
      expect(
        await db.candidateCheck.findMany({
          where: { candidateId: first.id },
          orderBy: { kind: 'asc' },
          select: { kind: true, revision: true, status: true, summary: true },
        }),
      ).toEqual([
        {
          kind: 'agent_browser',
          revision: 1,
          status: 'passed',
          summary: { v: 1, turn: 1, total: 3, passed: 3, failed: 0 },
        },
        { kind: 'preview_smoke', revision: 1, status: 'pending', summary: null },
      ])

      // Another tree reached the preview after the run: not the run of the next revision.
      await run(await synced('b'.repeat(64)))
      await synced('c'.repeat(64))
      expect((await settle(2)).carried).toBe(false)
      // Nor a run a content write into the preview followed.
      await run(await synced('c'.repeat(64)))
      await f.edit('after the checks', { title: 'Позже' })
      expect((await settle(3)).carried).toBe(false)
      await expect(
        store.recordChecks(
          admission,
          fixture.taskId,
          { total: 2, passed: 2, failed: 1 },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })

    it('marks the preview dirty before an action of the page', async () => {
      const store = new PostgresMcpBrowserStore(db)
      const admission = await store.admit(await admitted())
      await store.markDirty(admission, fixture.taskId)
      expect(
        await db.previewEnvironment.findUniqueOrThrow({ where: { id: fixture.previewId } }),
      ).toMatchObject({ dirty: true })
      const syncRequestId = randomUUID()
      await store.recordScreenshot(
        admission,
        fixture.taskId,
        '01960000-0000-7000-8000-00000000000a',
        syncRequestId,
      )
      expect(
        await db.taskEvent.findFirstOrThrow({
          where: { taskId: fixture.taskId, type: BROWSER_SCREENSHOT_EVENT },
        }),
      ).toMatchObject({
        clientVisible: false,
        // What it looked at, for the check of the candidate (carryBrowserChecks).
        payload: {
          v: 1,
          id: '01960000-0000-7000-8000-00000000000a',
          turn: admission.turnNo,
          previewId: fixture.previewId,
          syncRequestId,
        },
      })
    })

    it('tells which turns still hold their lease', async () => {
      const store = new PostgresMcpBrowserStore(db)
      const gone = randomUUID()
      expect(await store.liveAssignments([fixture.assignmentId, gone, 'not-a-uuid'])).toEqual(
        new Set([fixture.assignmentId]),
      )
      await db.siteLease.update({
        where: { siteId: fixture.siteId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      })
      expect(await store.liveAssignments([fixture.assignmentId])).toEqual(new Set())
    })

    it('closes the context of a turn whose key was revoked', async () => {
      const store = new PostgresMcpBrowserStore(db)
      expect(await store.liveAssignments([fixture.assignmentId])).toEqual(
        new Set([fixture.assignmentId]),
      )
      await db.llmKey.update({
        where: { id: fixture.keyId },
        data: { revokeRequestedAt: new Date() },
      })
      expect(await store.liveAssignments([fixture.assignmentId])).toEqual(new Set())
    })
  })
})
