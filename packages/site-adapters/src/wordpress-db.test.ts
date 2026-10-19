import { createHash, randomUUID } from 'node:crypto'

import {
  absentStateHashMaterial,
  dbOperationKinds,
  dbSettingSchema,
  optionStateHashMaterial,
  publishedContentHashMaterial,
  tableStateHashMaterial,
  type DbWriteRequest,
  type SiteHttpRequest,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { WordpressPublishedContentGateway } from './wordpress-content.ts'
import {
  wordpressDbOperationKinds,
  wordpressDbPlanGuide,
  wordpressDbSettings,
} from './wordpress-db.ts'
import { raditiContentPhp } from './wordpress-preview-files.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const siteId = randomUUID()
const connection = {
  origin: 'http://127.0.0.1:8099',
  siteId,
  username: 'synthetic',
  applicationPassword: 'synthetic',
  allowLoopbackHttp: true,
}
const json = (value: unknown, status = 200) => ({
  status,
  body: Buffer.from(JSON.stringify(value)),
})
const gateway = (answer: (request: SiteHttpRequest) => { status: number; body: Uint8Array }) => {
  const requests: SiteHttpRequest[] = []
  const site = new WordpressPublishedContentGateway(connection, async (request) => {
    requests.push(request)
    return answer(request)
  })
  return { db: site.db, requests }
}
const route = (request: SiteHttpRequest) => new URL(request.url).searchParams.get('rest_route')

describe('what a plan of WordPress may change', () => {
  it('declares every kind of a plan and settings of the closed list', () => {
    expect(wordpressDbOperationKinds()).toEqual([...dbOperationKinds])
    for (const setting of wordpressDbSettings())
      expect(dbSettingSchema.safeParse(setting).success).toBe(true)
    expect(wordpressDbSettings().map((setting) => setting.option)).toEqual([
      'blogname',
      'blogdescription',
      'date_format',
      'time_format',
      'start_of_week',
      'posts_per_page',
    ])
  })

  it('tells the agent the calls of each kind and the name of a table in code', () => {
    const guide = wordpressDbPlanGuide()
    for (const words of ['/wp/v2/pages', '/wp/v2/settings', '`db_schema`', "'raditi_'", 'dbDelta'])
      expect(guide).toContain(words)
    expect(
      guide
        .split('\n')
        .filter(Boolean)
        .every((line) => /^(- | {2})/.test(line)),
    ).toBe(true)
  })

  it('keeps the list the plugin keeps, setting by setting', () => {
    const body = raditiContentPhp.slice(
      raditiContentPhp.indexOf('function raditi_content_settings()'),
      raditiContentPhp.indexOf('function raditi_content_setting_allowed('),
    )
    const php = [
      ...body.matchAll(/'([a-z_]+)' => array\('(text|integer)', (\d+), ('([^']*)'|\d+)\)/g),
    ].map((match) =>
      match[2] === 'text'
        ? { option: match[1], value: 'text', maxBytes: Number(match[3]), forbidden: match[5] ?? '' }
        : { option: match[1], value: 'integer', min: Number(match[3]), max: Number(match[4]) },
    )
    expect(php).toEqual(
      wordpressDbSettings().map((setting) =>
        setting.value === 'text'
          ? {
              option: setting.option,
              value: 'text',
              maxBytes: setting.maxBytes,
              forbidden: setting.forbidden ?? '',
            }
          : { option: setting.option, value: 'integer', min: setting.min, max: setting.max },
      ),
    )
  })

  it('names the base of created ids the domain names', async () => {
    const { DB_CREATED_ID_BASE, DB_CREATED_ID_MAX } = await import('@repo/domain')
    expect(raditiContentPhp).toContain(`define('RADITI_CREATED_ID_BASE', ${DB_CREATED_ID_BASE})`)
    expect(raditiContentPhp).toContain(`define('RADITI_CREATED_ID_MAX', ${DB_CREATED_ID_MAX})`)
  })
})

describe('the objects of a plan through the plugin', () => {
  it('reads the capabilities, and those of a plugin before version 2', async () => {
    const capabilities = {
      version: 1,
      kind: 'capabilities',
      plugin: 2,
      operations: ['content_update', 'option_update'],
      settings: ['blogname'],
      maxRecordId: 12,
    }
    const current = gateway(() => json(capabilities))
    expect(await current.db.capabilities()).toEqual(capabilities)
    expect(route(current.requests[0]!)).toBe('/raditi/v1/capabilities')
    const legacy = gateway(() => json({ code: 'rest_no_route', data: { status: 404 } }, 404))
    expect(await legacy.db.capabilities()).toMatchObject({
      plugin: 1,
      operations: ['content_update'],
    })
    for (const answer of [json({ code: 'other' }, 404), json({ ...capabilities, plugin: 0 })])
      await expect(gateway(() => answer).db.capabilities()).rejects.toMatchObject({
        code: 'CONTENT_GATEWAY_UNAVAILABLE',
      })
  })

  it('reads each kind of object at its own route and checks its hash', async () => {
    const option = { version: 1, objectRef: 'option:blogname', value: 'Цветы' }
    const table = {
      version: 1,
      objectRef: 'table:bookings',
      exists: true,
      managed: true,
      definition: {
        columns: [{ name: 'name', type: 'string', length: 120, nullable: false }],
        indexes: [],
      },
    }
    const record = {
      version: 1,
      objectRef: 'page:1000000001',
      kind: 'page',
      status: 'draft',
      slug: 'prices',
      title: 'Цены',
      content: '',
      excerpt: '',
    }
    const states = {
      '/raditi/v1/settings/blogname': {
        ...option,
        stateHash: sha(optionStateHashMaterial(option as never)),
      },
      '/raditi/v1/tables/bookings': {
        ...table,
        stateHash: sha(tableStateHashMaterial(table as never)),
      },
      '/raditi/v1/records/page/1000000001': {
        ...record,
        stateHash: sha(publishedContentHashMaterial(record as never)),
      },
      '/raditi/v1/records/page/1000000002': {
        version: 1,
        objectRef: 'page:1000000002',
        absent: true,
        stateHash: sha(absentStateHashMaterial('page:1000000002')),
      },
    } as Record<string, unknown>
    const { db } = gateway((request) => json(states[route(request)!]))
    for (const [ref, path] of [
      ['option:blogname', '/raditi/v1/settings/blogname'],
      ['table:bookings', '/raditi/v1/tables/bookings'],
      ['page:1000000001', '/raditi/v1/records/page/1000000001'],
      ['page:1000000002', '/raditi/v1/records/page/1000000002'],
    ] as const)
      expect(await db.readObject(ref)).toEqual(states[path])
    // A state whose hash is not its fields', or another object's.
    for (const wrong of [
      { ...(states['/raditi/v1/settings/blogname'] as object), value: 'Другое' },
      { ...(states['/raditi/v1/tables/bookings'] as object), managed: false },
    ])
      await expect(gateway(() => json(wrong)).db.readObject('option:blogname')).rejects.toThrow()
    await expect(db.readObject('option:Blog')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('writes each kind at its own route and takes only the receipt of this call', async () => {
    const base = {
      callId: randomUUID(),
      siteId,
      epoch: 3,
      requestHash: 'a'.repeat(64),
      expectedStateHash: 'b'.repeat(64),
      deadlineAt: Date.now() + 10_000,
      ttlMs: 10_000,
      mode: 'edit' as const,
    }
    const writes: [DbWriteRequest, string, string | undefined][] = [
      [
        { ...base, objectRef: 'option:blogname', change: { kind: 'option_update', value: 'A' } },
        '/raditi/v1/settings/blogname',
        undefined,
      ],
      [
        {
          ...base,
          objectRef: 'page:1000000001',
          change: {
            kind: 'post_create',
            record: { status: 'publish', slug: 'prices', title: 'Цены', content: '', excerpt: '' },
            createCallId: base.callId,
          },
        },
        '/raditi/v1/records/page',
        'page:1000000001',
      ],
      [
        {
          ...base,
          mode: 'restore',
          objectRef: 'page:1000000001',
          change: { kind: 'post_trash', expectedSlug: 'prices', createCallId: base.callId },
        },
        '/raditi/v1/records/page/1000000001/trash',
        undefined,
      ],
      [
        {
          ...base,
          objectRef: 'table:bookings',
          change: {
            kind: 'schema_migration',
            before: { exists: false, managed: false, definition: null },
            definition: {
              columns: [{ name: 'name', type: 'string', length: 120, nullable: true }],
              indexes: [],
            },
          },
        },
        '/raditi/v1/tables/bookings',
        undefined,
      ],
    ]
    for (const [request, path, createdRef] of writes) {
      const receipt = {
        version: 1,
        kind: 'committed',
        callId: request.callId,
        siteId,
        epoch: request.epoch,
        requestHash: request.requestHash,
        objectRef: request.objectRef,
        stateHash: 'c'.repeat(64),
        ...(createdRef ? { createdRef } : {}),
      }
      const site = gateway(() => json(receipt))
      expect(await site.db.writeObject(request)).toEqual(receipt)
      const sent = site.requests[0]!
      expect([sent.method, route(sent)]).toEqual(['POST', path])
      expect(JSON.parse(sent.body!)).not.toHaveProperty('change')
      expect(JSON.parse(sent.body!)).not.toHaveProperty('kind')
      for (const wrong of [
        { ...receipt, callId: randomUUID() },
        { ...receipt, epoch: 4 },
        { ...receipt, objectRef: 'page:42' },
        createdRef ? { ...receipt, createdRef: undefined } : { ...receipt, createdRef: 'page:9' },
      ])
        await expect(gateway(() => json(wrong)).db.writeObject(request)).rejects.toMatchObject({
          code: 'CONTENT_GATEWAY_UNAVAILABLE',
        })
    }
    const refusal = { version: 1, kind: 'rejected', code: 'invalid', reason: 'slug' }
    expect(await gateway(() => json(refusal)).db.writeObject(writes[1]![0])).toEqual(refusal)
    // A kind sent to another kind's object never leaves the process.
    const site = gateway(() => json({}))
    await expect(
      site.db.writeObject({ ...writes[0]![0], objectRef: 'table:bookings' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      site.db.writeObject({ ...writes[0]![0], siteId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(site.requests).toEqual([])
  })

  it('reads the receipt of a write and reconciles it, any object of a plan', async () => {
    const callId = randomUUID()
    const receipt = {
      version: 1,
      kind: 'committed',
      callId,
      siteId,
      epoch: 3,
      requestHash: 'a'.repeat(64),
      objectRef: 'page:1000000001',
      createdRef: 'page:812',
      stateHash: 'c'.repeat(64),
    }
    const kept = gateway(() => json(receipt))
    expect(await kept.db.operation(callId)).toEqual(receipt)
    expect([kept.requests[0]!.method, route(kept.requests[0]!)]).toEqual([
      'GET',
      `/raditi/v1/operations/${callId}`,
    ])
    expect(
      await gateway(() => json({ version: 1, kind: 'unknown' })).db.operation(callId),
    ).toBeNull()
    await expect(
      gateway(() => json({ ...receipt, callId: randomUUID() })).db.operation(callId),
    ).rejects.toMatchObject({ code: 'CONTENT_GATEWAY_UNAVAILABLE' })
    await expect(gateway(() => json({})).db.operation('no')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })

    const request = {
      callId,
      siteId,
      epoch: 3,
      requestHash: 'a'.repeat(64),
      objectRef: 'option:blogname',
      deadlineAt: 1_800_000_000_000,
      ttlMs: -1,
    }
    const { ttlMs: _left, ...identity } = request
    const proof = { version: 1, kind: 'not_committed', ...identity }
    const asked = gateway(() => json(proof))
    expect(await asked.db.reconcile(request)).toEqual(proof)
    expect(route(asked.requests[0]!)).toBe(`/raditi/v1/operations/${callId}/reconcile`)
    expect(JSON.parse(asked.requests[0]!.body!)).toEqual(request)
    const { createdRef: _created, ...committed } = receipt
    const option = { ...committed, objectRef: 'option:blogname' }
    expect(await gateway(() => json(option)).db.reconcile(request)).toEqual(option)
    for (const wrong of [
      { ...proof, deadlineAt: 1 },
      { ...proof, objectRef: 'option:blogdescription' },
      { ...option, requestHash: 'f'.repeat(64) },
    ])
      await expect(gateway(() => json(wrong)).db.reconcile(request)).rejects.toMatchObject({
        code: 'CONTENT_GATEWAY_UNAVAILABLE',
      })
  })

  it('asks whether an address is free and moves the fence, nothing else', async () => {
    const free = gateway(() => json({ version: 1, kind: 'slug', taken: false }))
    expect(await free.db.slugTaken('page', 'prices')).toBe(false)
    expect(route(free.requests[0]!)).toBe('/raditi/v1/slugs/page/prices')
    await expect(free.db.slugTaken('page', 'Цены')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const fence = gateway(() => json({ version: 1, kind: 'fenced', epoch: 9 }))
    await fence.db.fence({ siteId, epoch: 9 })
    expect(JSON.parse(fence.requests[0]!.body!)).toEqual({ siteId, epoch: 9 })
    await expect(
      gateway(() => json({ version: 1, kind: 'fenced', epoch: 8 })).db.fence({ siteId, epoch: 9 }),
    ).rejects.toMatchObject({ code: 'CONTENT_GATEWAY_UNAVAILABLE' })
  })
})
