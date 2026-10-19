import { createHash, randomUUID } from 'node:crypto'

import {
  absentStateHashMaterial,
  optionStateHashMaterial,
  publishedContentHashMaterial,
  tableStateHashMaterial,
  type DbObjectState,
  type DbSetting,
  type DbWriteRequest,
  type PublishedContentGateway,
  type SiteDbGateway,
  type TableDefinition,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { newTurnKeys } from '../llm/turn-key.ts'
import type { ContentPrivacy } from './content-privacy.ts'
import type { ContentSnapshotStorage } from './content-snapshots.ts'
import type { McpAccess } from './mcp-access.ts'
import { McpContentService, type McpPreviewContent } from './mcp-content.ts'
import type { McpCallReservation, PostgresMcpJournal } from './mcp-journal.ts'
import type { McpPreviewTarget } from './preview-content.ts'
import { previewDbValueKey } from './preview-db-values.ts'

// The kinds of a plan beyond the text of a record, written by the agent into the preview of the
// dialog (docs/plan/53-chat-preview-release.md, «Операции БД и миграции»): a created record, a
// setting of the list, a table of the platform, and the restore of each.

const HOST = 'site-0a1b2c3d-chat-0a1b2c.localhost'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const created = 'page:1000000003'
const settings: DbSetting[] = [
  {
    option: 'blogname',
    setting: 'title',
    label: 'Название сайта',
    value: 'text',
    maxBytes: 200,
    display: 'html_text',
  },
  {
    option: 'posts_per_page',
    setting: 'posts_per_page',
    label: 'Записей на странице блога',
    value: 'integer',
    min: 1,
    max: 100,
    display: 'plain',
  },
]
const absent = (objectRef: string): DbObjectState => ({
  version: 1,
  objectRef,
  absent: true,
  stateHash: sha(absentStateHashMaterial(objectRef)),
})
const option = (value: string | null): DbObjectState => ({
  version: 1,
  objectRef: 'option:blogname',
  value,
  stateHash: sha(optionStateHashMaterial({ objectRef: 'option:blogname', value })),
})
const table = (definition: TableDefinition | null): DbObjectState => {
  const state = {
    version: 1 as const,
    objectRef: 'table:bookings',
    exists: definition !== null,
    managed: definition !== null,
    definition,
  }
  return { ...state, stateHash: sha(tableStateHashMaterial(state)) }
}
const record = (fields: { title: string; status: 'publish' | 'draft'; slug: string }) => {
  const state = {
    version: 1 as const,
    objectRef: created,
    kind: 'page' as const,
    content: '',
    excerpt: '',
    ...fields,
  }
  return { ...state, stateHash: sha(publishedContentHashMaterial(state)) }
}
const bookings: TableDefinition = {
  columns: [{ name: 'name', type: 'string', length: 120, nullable: false }],
  indexes: [],
}

function writing(options: { kinds?: McpPreviewTarget['db'] } = {}) {
  const scope: McpAccess = {
    keyId: randomUUID(),
    taskId: randomUUID(),
    siteId: randomUUID(),
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    turn: 3,
    epoch: 7,
    firstEpoch: 1,
    stack: 'wordpress',
    url: 'https://site.example.test/',
    preview: {
      id: randomUUID(),
      status: 'ready',
      database: true,
      hostname: HOST,
      dbKinds: ['content_update', 'option_update', 'post_create', 'schema_migration'],
    },
  }
  const target: McpPreviewTarget = {
    previewId: scope.preview!.id,
    siteId: scope.siteId,
    workspaceId: scope.workspaceId,
    stack: 'wordpress',
    hostname: HOST,
    upstream: { host: '127.0.0.1', port: 41_234 },
    writeEpoch: 4,
    db: options.kinds ?? {
      kinds: ['content_update', 'option_update', 'post_create', 'schema_migration'],
      settings: ['blogname', 'posts_per_page'],
      createdIds: true,
    },
  }
  const callId = randomUUID()
  const snapshot = {
    id: randomUUID(),
    workspaceId: scope.workspaceId,
    siteId: scope.siteId,
    taskId: scope.taskId,
    objectRef: created,
    expiresAt: new Date(Date.now() + 60_000),
  }
  let reserved: McpCallReservation = {
    kind: 'claimed',
    callId,
    snapshot,
    preview: target,
    objectRef: created,
    createdIds: [1000000001, 1000000003],
  }
  const journal = {
    reserve: vi.fn<PostgresMcpJournal['reserve']>(async (_scope, command) => {
      if (reserved.kind === 'claimed' && !command.objectRef.endsWith(':new'))
        return { ...reserved, objectRef: command.objectRef }
      return reserved
    }),
    previewTarget: vi.fn<PostgresMcpJournal['previewTarget']>(async () => target),
    restoreSource: vi.fn<PostgresMcpJournal['restoreSource']>(),
    attachSnapshot: vi.fn<PostgresMcpJournal['attachSnapshot']>(async () => undefined),
    beginWrite: vi.fn<PostgresMcpJournal['beginWrite']>(async () => true),
    writeIntent: vi.fn<PostgresMcpJournal['writeIntent']>(async () => ({
      callId,
      requestHash: 'a'.repeat(64),
      objectRef: created,
      deadlineAt: 1_800_000_000_000,
      ttlMs: 12_345,
      snapshotId: snapshot.id,
      restoresSnapshotId: null,
      preview: { previewId: target.previewId, writeEpoch: target.writeEpoch },
    })),
    finish: vi.fn<PostgresMcpJournal['finish']>(async () => undefined),
    markAmbiguous: vi.fn<PostgresMcpJournal['markAmbiguous']>(async () => undefined),
  }
  const states = new Map<string, DbObjectState[]>()
  const db = {
    capabilities: vi.fn<SiteDbGateway['capabilities']>(async () => ({
      version: 1,
      kind: 'capabilities',
      plugin: 2,
      operations: ['content_update', 'option_update', 'post_create', 'schema_migration'],
      settings: ['blogname', 'posts_per_page'],
      maxRecordId: 1000000002,
      nextCreatedId: 1000000003,
    })),
    readObject: vi.fn<SiteDbGateway['readObject']>(async (ref) => {
      const queue = states.get(ref) ?? []
      const state = queue.length > 1 ? queue.shift()! : queue[0]
      if (!state) throw new Error(`no state of ${ref}`)
      return state
    }),
    slugTaken: vi.fn<SiteDbGateway['slugTaken']>(async () => false),
    operation: vi.fn<SiteDbGateway['operation']>(async () => null),
    reconcile: vi.fn<SiteDbGateway['reconcile']>(async () => ({
      version: 1 as const,
      kind: 'unknown' as const,
    })),
    writeObject: vi.fn<SiteDbGateway['writeObject']>(async (request: DbWriteRequest) => ({
      version: 1 as const,
      kind: 'committed' as const,
      callId: request.callId,
      siteId: request.siteId,
      epoch: request.epoch,
      requestHash: request.requestHash,
      objectRef: request.objectRef,
      stateHash: states.get(request.objectRef)!.at(-1)!.stateHash,
      ...(request.change.kind === 'post_create' ? { createdRef: request.objectRef } : {}),
    })),
    fence: vi.fn<SiteDbGateway['fence']>(async () => undefined),
  }
  const records: Record<string, ReturnType<typeof record>[]> = {}
  const preview = {
    read: vi.fn<PublishedContentGateway['read']>(async (ref) => {
      const queue = records[ref] ?? []
      const state = queue.length > 1 ? queue.shift()! : queue[0]
      if (!state) throw new Error(`no record ${ref}`)
      return state
    }),
    conditionalWrite: vi.fn(),
    operation: vi.fn(),
    reconcileOperation: vi.fn(),
    forgetOperation: vi.fn(),
    db,
  }
  const values = {
    save: vi.fn<McpPreviewContent['values']['save']>(async (ref) => ({
      key: previewDbValueKey(ref),
      sha256: ref.side === 'before' ? 'd'.repeat(64) : 'e'.repeat(64),
      sizeBytes: 300,
    })),
  }
  const snapshots = {
    save: vi.fn(async (reference: object) => ({
      ...reference,
      payloadSha256: 'c'.repeat(64),
      sizeBytes: 1,
    })),
    load: vi.fn(async (): Promise<Uint8Array> => Buffer.from('{}')),
  }
  const privacy = {
    mask: vi.fn(async (_scope: unknown, fields: Record<string, string>) => ({ ...fields })),
    rehydrate: vi.fn(async (_scope: unknown, patch: Record<string, string>) => ({ ...patch })),
  }
  const service = new McpContentService(
    journal as unknown as PostgresMcpJournal,
    snapshots as unknown as ContentSnapshotStorage,
    privacy as unknown as ContentPrivacy,
    async () => {
      throw new Error('The site must not be reached')
    },
    {
      previews: {
        resolve: async () => preview as unknown as PublishedContentGateway,
        values,
      },
      dbSettings: () => settings,
    },
  )
  return {
    scope,
    target,
    callId,
    journal,
    db,
    preview,
    records,
    states,
    values,
    snapshots,
    service,
    reserve: (next: McpCallReservation) => (reserved = next),
  }
}

describe('a new record of the dialog', () => {
  const body = { title: 'Цены', content: '<p>Букеты</p>', slug: 'prices', status: 'draft' }

  it('is created under the id the journal gives, with the mark of its call', async () => {
    const f = writing()
    f.states.set(created, [absent(created)])
    const after = record({ title: 'Цены', status: 'draft', slug: 'prices' })
    const stored = { ...after, content: '<p>Букеты</p>' }
    const stateHash = sha(publishedContentHashMaterial(stored))
    f.records[created] = [{ ...stored, stateHash }]
    f.db.writeObject.mockImplementationOnce(async (request) => ({
      version: 1,
      kind: 'committed',
      callId: request.callId,
      siteId: request.siteId,
      epoch: request.epoch,
      requestHash: request.requestHash,
      objectRef: request.objectRef,
      stateHash,
      createdRef: request.objectRef,
    }))
    const result = await f.service.wpRest(f.scope, {
      method: 'POST',
      route: '/wp/v2/pages',
      body,
      idempotencyKey: 'create-prices',
    })
    expect(result).toEqual({
      result: 'ok',
      appliedStateHash: stateHash,
      response: {
        objectRef: created,
        created: true,
        slug: 'prices',
        status: 'draft',
        snapshotId: expect.any(String),
      },
    })
    // The command names no id: the journal gives it, not lower than the preview's free one.
    expect(f.journal.reserve).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      expect.objectContaining({ objectRef: 'page:new', tool: 'wp_rest' }),
      undefined,
      false,
      { type: 'page', floor: 1000000003 },
    )
    expect(f.db.writeObject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        objectRef: created,
        mode: 'edit',
        siteId: f.target.previewId,
        epoch: f.target.writeEpoch,
        expectedStateHash: absent(created).stateHash,
        change: {
          kind: 'post_create',
          record: {
            title: 'Цены',
            content: '<p>Букеты</p>',
            excerpt: '',
            slug: 'prices',
            status: 'draft',
          },
          createCallId: f.callId,
        },
      }),
    )
    expect(f.journal.finish).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      f.callId,
      expect.objectContaining({ result: 'ok' }),
      expect.objectContaining({
        kind: 'post_create',
        fields: ['title', 'content', 'excerpt'],
        beforeHash: absent(created).stateHash,
        afterHash: stateHash,
      }),
    )
    expect(f.values.save.mock.calls.map(([, state]) => state)).toEqual([
      absent(created),
      { ...stored, stateHash },
    ])
  })

  it('is refused when a value names the id of a record of the dialog', async () => {
    const f = writing()
    f.states.set(created, [absent(created)])
    const result = await f.service.wpRest(f.scope, {
      method: 'POST',
      route: '/wp/v2/pages',
      body: { ...body, content: '<a href="/?page_id=1000000001">Цены</a>' },
      idempotencyKey: 'create-linked',
    })
    expect(result).toEqual({ result: 'error', response: { code: 'CONTENT_CREATED_ID' } })
    expect(f.db.writeObject).not.toHaveBeenCalled()
    expect(f.journal.beginWrite).not.toHaveBeenCalled()
  })

  it('is not offered where the build found no created records writable', async () => {
    const f = writing({ kinds: { kinds: ['content_update'], settings: [], createdIds: false } })
    await expect(
      f.service.wpRest(f.scope, {
        method: 'POST',
        route: '/wp/v2/pages',
        body,
        idempotencyKey: 'create-prices',
      }),
    ).rejects.toMatchObject({ code: 'DB_OPERATION_NOT_ALLOWED' })
    expect(f.journal.reserve).not.toHaveBeenCalled()
  })

  it('goes to the trash when the agent restores the snapshot its creation took', async () => {
    const f = writing()
    const current = record({ title: 'Цены', status: 'draft', slug: 'prices' })
    f.records[created] = [current]
    f.states.set(created, [absent(created)])
    const creation = randomUUID()
    const snapshotId = randomUUID()
    f.journal.restoreSource.mockResolvedValue({
      receipt: {
        id: snapshotId,
        workspaceId: f.scope.workspaceId,
        siteId: f.scope.siteId,
        taskId: f.scope.taskId,
        objectRef: created,
        expiresAt: new Date(Date.now() + 60_000),
        payloadSha256: 'c'.repeat(64),
        sizeBytes: 100,
      },
      expectedStateHash: current.stateHash,
      callId: creation,
    })
    f.snapshots.load.mockResolvedValue(Buffer.from(JSON.stringify(absent(created))))
    f.reserve({
      kind: 'claimed',
      callId: f.callId,
      snapshot: {
        id: randomUUID(),
        workspaceId: f.scope.workspaceId,
        siteId: f.scope.siteId,
        taskId: f.scope.taskId,
        objectRef: created,
        expiresAt: new Date(Date.now() + 60_000),
      },
      preview: f.target,
      objectRef: created,
      createdIds: [1000000003],
      restoreSource: {
        receipt: (await f.journal.restoreSource(f.scope, snapshotId)).receipt,
        expectedStateHash: current.stateHash,
        callId: creation,
      },
    })
    f.journal.writeIntent.mockResolvedValueOnce({
      callId: f.callId,
      requestHash: 'a'.repeat(64),
      objectRef: created,
      deadlineAt: 1_800_000_000_000,
      ttlMs: 12_345,
      snapshotId: randomUUID(),
      restoresSnapshotId: snapshotId,
      preview: { previewId: f.target.previewId, writeEpoch: f.target.writeEpoch },
    })
    const result = await f.service.restore(f.scope, { snapshotId, idempotencyKey: 'undo-create' })
    expect(result).toMatchObject({ result: 'ok', response: { restored: true, snapshotId } })
    expect(f.db.writeObject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        mode: 'restore',
        expectedStateHash: current.stateHash,
        change: { kind: 'post_trash', expectedSlug: 'prices', createCallId: creation },
      }),
    )
    expect(f.journal.finish).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      f.callId,
      expect.objectContaining({ result: 'ok' }),
      expect.objectContaining({
        kind: 'post_trash',
        fields: [],
        afterHash: absent(created).stateHash,
      }),
    )
  })
})

describe('a setting of the list', () => {
  it('is read by the names the agent knows, masked like any text', async () => {
    const f = writing()
    f.states.set('option:blogname', [option('Цветы у дома')])
    f.states.set('option:posts_per_page', [
      {
        version: 1,
        objectRef: 'option:posts_per_page',
        value: '10',
        stateHash: sha(
          optionStateHashMaterial({ objectRef: 'option:posts_per_page', value: '10' }),
        ),
      },
    ])
    expect(await f.service.wpRest(f.scope, { method: 'GET', route: '/wp/v2/settings' })).toEqual({
      result: 'ok',
      response: { settings: { title: 'Цветы у дома', posts_per_page: '10' } },
    })
  })

  it('is written as an operation of the plan, a number in its one spelling', async () => {
    const f = writing()
    f.states.set('option:blogname', [option('Цветы'), option('Цветы у дома')])
    f.reserve({
      kind: 'claimed',
      callId: f.callId,
      snapshot: {
        id: randomUUID(),
        workspaceId: f.scope.workspaceId,
        siteId: f.scope.siteId,
        taskId: f.scope.taskId,
        objectRef: 'option:blogname',
        expiresAt: new Date(Date.now() + 60_000),
      },
      preview: f.target,
      objectRef: 'option:blogname',
      createdIds: [],
    })
    f.journal.writeIntent.mockResolvedValueOnce({
      callId: f.callId,
      requestHash: 'a'.repeat(64),
      objectRef: 'option:blogname',
      deadlineAt: 1_800_000_000_000,
      ttlMs: 12_345,
      snapshotId: randomUUID(),
      restoresSnapshotId: null,
      preview: { previewId: f.target.previewId, writeEpoch: f.target.writeEpoch },
    })
    const result = await f.service.wpRest(f.scope, {
      method: 'POST',
      route: '/wp/v2/settings',
      body: { title: 'Цветы у дома' },
      idempotencyKey: 'rename',
    })
    expect(result).toMatchObject({ result: 'ok', response: { setting: 'title', updated: true } })
    expect(f.db.writeObject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        objectRef: 'option:blogname',
        mode: 'edit',
        change: { kind: 'option_update', value: 'Цветы у дома' },
      }),
    )
    expect(f.journal.finish).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      f.callId,
      expect.anything(),
      expect.objectContaining({ kind: 'option_update', fields: ['value'] }),
    )
  })

  it('refuses a setting outside the list and a value that does not fit it', async () => {
    const f = writing()
    for (const [body, code] of [
      [{ siteurl: 'https://evil.example' }, 'DB_SETTING_NOT_ALLOWED'],
      [{ posts_per_page: 0 }, 'DB_SETTING_INVALID'],
      [{ posts_per_page: '010' }, 'DB_SETTING_INVALID'],
      [{ title: 'ы'.repeat(101) }, 'DB_SETTING_INVALID'],
    ] as const)
      await expect(
        f.service.wpRest(f.scope, {
          method: 'POST',
          route: '/wp/v2/settings',
          body,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code })
    // A turn credential is no value of a public setting.
    const key = newTurnKeys().llmApiKey
    await expect(
      f.service.wpRest(f.scope, {
        method: 'POST',
        route: '/wp/v2/settings',
        body: { title: key },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_CREDENTIAL_REFUSED' })
    expect(f.journal.reserve).not.toHaveBeenCalled()
  })

  it('leaves the write unknown when the preview says it stored a turn credential', async () => {
    const f = writing()
    const key = newTurnKeys().llmApiKey
    f.states.set('option:blogname', [option('Цветы'), option(key)])
    f.reserve({
      kind: 'claimed',
      callId: f.callId,
      snapshot: {
        id: randomUUID(),
        workspaceId: f.scope.workspaceId,
        siteId: f.scope.siteId,
        taskId: f.scope.taskId,
        objectRef: 'option:blogname',
        expiresAt: new Date(Date.now() + 60_000),
      },
      preview: f.target,
      objectRef: 'option:blogname',
      createdIds: [],
    })
    f.journal.writeIntent.mockResolvedValueOnce({
      callId: f.callId,
      requestHash: 'a'.repeat(64),
      objectRef: 'option:blogname',
      deadlineAt: 1_800_000_000_000,
      ttlMs: 12_345,
      snapshotId: randomUUID(),
      restoresSnapshotId: null,
      preview: { previewId: f.target.previewId, writeEpoch: f.target.writeEpoch },
    })
    await expect(
      f.service.wpRest(f.scope, {
        method: 'POST',
        route: '/wp/v2/settings',
        body: { title: 'Цветы у дома' },
        idempotencyKey: 'rename',
      }),
    ).rejects.toMatchObject({ code: 'MCP_CALL_IN_FLIGHT' })
    expect(f.journal.markAmbiguous).toHaveBeenCalledOnce()
    expect(f.journal.finish).not.toHaveBeenCalled()
  })
})

describe('a table of the platform', () => {
  const reservedTable = (f: ReturnType<typeof writing>) => {
    f.reserve({
      kind: 'claimed',
      callId: f.callId,
      snapshot: {
        id: randomUUID(),
        workspaceId: f.scope.workspaceId,
        siteId: f.scope.siteId,
        taskId: f.scope.taskId,
        objectRef: 'table:bookings',
        expiresAt: new Date(Date.now() + 60_000),
      },
      preview: f.target,
      objectRef: 'table:bookings',
      createdIds: [],
    })
    f.journal.writeIntent.mockResolvedValueOnce({
      callId: f.callId,
      requestHash: 'a'.repeat(64),
      objectRef: 'table:bookings',
      deadlineAt: 1_800_000_000_000,
      ttlMs: 12_345,
      snapshotId: randomUUID(),
      restoresSnapshotId: null,
      preview: { previewId: f.target.previewId, writeEpoch: f.target.writeEpoch },
    })
  }

  it('is created by the dictionary and recorded as a migration', async () => {
    const f = writing()
    f.states.set('table:bookings', [table(null), table(bookings)])
    reservedTable(f)
    const result = await f.service.dbSchema(f.scope, {
      method: 'POST',
      table: 'bookings',
      create: { columns: bookings.columns },
      idempotencyKey: 'bookings',
    })
    expect(result).toMatchObject({ result: 'ok', response: { table: 'bookings', migrated: true } })
    expect(f.db.writeObject).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        change: {
          kind: 'schema_migration',
          before: { exists: false, managed: false, definition: null },
          definition: bookings,
        },
      }),
    )
    expect(f.journal.finish).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      f.callId,
      expect.anything(),
      expect.objectContaining({ kind: 'schema_migration', fields: ['definition'] }),
    )
  })

  it('takes only additions to a table of the platform, and a creation only of a new one', async () => {
    const f = writing()
    f.states.set('table:bookings', [table(bookings)])
    reservedTable(f)
    expect(
      await f.service.dbSchema(f.scope, {
        method: 'POST',
        table: 'bookings',
        add: { indexes: [{ name: 'by_name', columns: ['name'], unique: true }] },
        idempotencyKey: 'unique',
      }),
    ).toEqual({ result: 'error', response: { code: 'DB_SCHEMA_INVALID' } })
    reservedTable(f)
    expect(
      await f.service.dbSchema(f.scope, {
        method: 'POST',
        table: 'bookings',
        create: { columns: bookings.columns },
        idempotencyKey: 'again',
      }),
    ).toEqual({ result: 'error', response: { code: 'DB_SCHEMA_CONFLICT' } })
    expect(f.db.writeObject).not.toHaveBeenCalled()
    await expect(
      f.service.dbSchema(f.scope, { method: 'GET', table: 'Wp_Users' }),
    ).rejects.toMatchObject({ code: 'DB_SCHEMA_INVALID' })
  })

  it('reads a table as the dictionary says it', async () => {
    const f = writing()
    f.states.set('table:bookings', [table(bookings)])
    expect(await f.service.dbSchema(f.scope, { method: 'GET', table: 'bookings' })).toEqual({
      result: 'ok',
      response: { table: 'bookings', exists: true, managed: true, definition: bookings },
    })
  })
})
