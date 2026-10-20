import type {
  ContentWriteOutcome,
  ContentWriteRequest,
  DbObjectState,
  DbPlan,
  DbWriteRequest,
  SiteDbGateway,
  PreviewExecInput,
  PublishedContentGateway,
  PublishedContentState,
} from '@repo/domain'
import { wordpressContentAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import {
  previewContentAccess,
  previewContentObjects,
  replayDbPlan,
  seedMismatches,
} from '@repo/site-content'
import type { DbPlanValueReader } from '@repo/site-content'
import { recordValues } from '../testing/previews.ts'

const signal = new AbortController().signal
const previewId = '00000000-0000-4000-8000-0000000000a1'
const origin = 'http://site-0f3a9c1b-chat-a1b2c3.localhost:8090'
const hash = (c: string) => c.repeat(64)

const state = (objectRef: string, stateHash: string, title = 'T'): PublishedContentState => ({
  version: 1,
  objectRef,
  kind: objectRef.startsWith('page') ? 'page' : 'post',
  title,
  content: 'C',
  excerpt: '',
  stateHash,
})

function gateway(states: Record<string, string | null>, writes: ContentWriteRequest[] = []) {
  return {
    async read(ref: string) {
      const found = states[ref]
      if (found === null || found === undefined) throw new Error('unavailable')
      return state(ref, found)
    },
    async conditionalWrite(request: ContentWriteRequest): Promise<ContentWriteOutcome> {
      writes.push(request)
      if (states[request.objectRef] !== request.expectedStateHash)
        return { version: 1, kind: 'rejected', code: 'conflict' }
      return {
        version: 1,
        kind: 'committed',
        callId: request.callId,
        siteId: request.siteId,
        epoch: request.epoch,
        requestHash: request.requestHash,
        objectRef: request.objectRef,
        stateHash: hash('e'),
      }
    },
  } as unknown as PublishedContentGateway
}

function runtime(stdout: string, code = 0) {
  const calls: PreviewExecInput[] = []
  return {
    calls,
    async exec(_id: string, input: PreviewExecInput) {
      calls.push(input)
      return { code, stdout: Buffer.from(stdout), stderr: new Uint8Array() }
    },
  }
}

describe('the content of a preview through the stack plugin', () => {
  it('makes the account of the platform and adds the origin of the preview', async () => {
    const cli = runtime(
      '{"v":"1","username":"raditi-platform","applicationPassword":"abcd efgh"}\n',
    )
    const access = await previewContentAccess(
      {
        runtime: cli,
        previewId,
        recipe: { access: ['wp', 'eval', 'x'], objects: ['wp'], pages: {} },
        adapter: wordpressContentAdapter,
        origin,
      },
      signal,
    )
    expect(access).toEqual({
      v: '1',
      username: 'raditi-platform',
      applicationPassword: 'abcd efgh',
      origin,
    })
    expect(cli.calls[0]?.argv).toEqual(['wp', 'eval', 'x'])
  })

  it('refuses an account the stack printed with an origin, or not at all', async () => {
    const recipe = { access: ['wp'], objects: ['wp'], pages: {} }
    for (const out of [
      '{"v":"1","username":"u","applicationPassword":"p","origin":"http://x"}',
      'nope',
    ])
      await expect(
        previewContentAccess(
          { runtime: runtime(out), previewId, recipe, adapter: wordpressContentAdapter, origin },
          signal,
        ),
      ).rejects.toMatchObject({ code: 'PREVIEW_CONTENT_FAILED' })
    await expect(
      previewContentObjects({ runtime: runtime('[]', 1), previewId, recipe }, signal),
    ).rejects.toMatchObject({ code: 'PREVIEW_CONTENT_FAILED' })
    expect(
      await previewContentObjects(
        { runtime: runtime('["post:1","page:2","post:1"]'), previewId, recipe },
        signal,
      ),
    ).toEqual(['post:1', 'page:2'])
  })

  it('counts an object as differing when its hashes differ or one side cannot answer', async () => {
    const production = gateway({ 'post:1': hash('a'), 'post:2': hash('b'), 'page:3': null })
    const preview = gateway({
      'post:1': hash('a'),
      'post:2': hash('c'),
      'page:3': hash('d'),
      'page:4': hash('e'),
    })
    expect(
      await seedMismatches(
        { production, preview, objects: ['post:1', 'post:2', 'page:3', 'page:4'] },
        signal,
      ),
    ).toEqual(['page:3', 'page:4', 'post:2'])
  })

  it('replays the plan from the state it starts at, in the exact-bytes mode', async () => {
    const writes: ContentWriteRequest[] = []
    const preview = gateway({ 'post:42': hash('a') }, writes)
    const value = { key: 'tasks/t/db/c/after.json', sha256: hash('f'), sizeBytes: 10 }
    const plan = [
      {
        kind: 'content_update',
        objectRef: 'post:42',
        fields: ['title'],
        beforeHash: hash('a'),
        afterHash: hash('e'),
        before: value,
        after: value,
      },
    ] as DbPlan
    const values = recordValues(async (_owner, ref, side) => {
      expect(side).toBe('after')
      return state(ref, hash('e'), 'Новый заголовок')
    })
    await replayDbPlan(
      {
        gateway: preview,
        plan,
        values,
        owner: { workspaceId: 'w', taskId: 't' },
        previewId,
        epoch: 4,
      },
      signal,
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      siteId: previewId,
      epoch: 4,
      objectRef: 'post:42',
      expectedStateHash: hash('a'),
      mode: 'restore',
      fields: { title: 'Новый заголовок' },
    })

    const conflicted = gateway({ 'post:42': hash('9') })
    await expect(
      replayDbPlan(
        {
          gateway: conflicted,
          plan,
          values,
          owner: { workspaceId: 'w', taskId: 't' },
          previewId,
          epoch: 4,
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'PREVIEW_CONTENT_FAILED', details: { code: 'plan_conflict' } })
  })
})

describe('the other kinds of a plan in a preview (docs/plan/53, «Операции БД и миграции»)', () => {
  const definition = {
    columns: [{ name: 'name', type: 'string' as const, length: 120, nullable: false }],
    indexes: [],
  }
  const side = (name: string) => ({
    key: `tasks/t/db/${name}.json`,
    sha256: hash('f'),
    sizeBytes: 10,
  })
  const plan = [
    {
      kind: 'schema_migration',
      objectRef: 'table:bookings',
      fields: ['definition'],
      beforeHash: hash('1'),
      afterHash: hash('2'),
      before: side('t/before'),
      after: side('t/after'),
    },
    {
      kind: 'option_update',
      objectRef: 'option:blogname',
      fields: ['value'],
      beforeHash: hash('3'),
      afterHash: hash('4'),
      before: side('o/before'),
      after: side('o/after'),
    },
    {
      kind: 'post_create',
      objectRef: 'page:1000000001',
      fields: ['title', 'content', 'excerpt'],
      beforeHash: hash('5'),
      afterHash: hash('6'),
      before: side('p/before'),
      after: side('p/after'),
    },
  ] as DbPlan
  const values: Record<string, DbObjectState> = {
    'table:bookings/before': {
      version: 1,
      objectRef: 'table:bookings',
      exists: false,
      managed: false,
      definition: null,
      stateHash: hash('1'),
    },
    'table:bookings/after': {
      version: 1,
      objectRef: 'table:bookings',
      exists: true,
      managed: true,
      definition,
      stateHash: hash('2'),
    },
    'option:blogname/after': {
      version: 1,
      objectRef: 'option:blogname',
      value: 'Цветы у дома',
      stateHash: hash('4'),
    },
    'option:blogname/before': {
      version: 1,
      objectRef: 'option:blogname',
      value: 'Цветы',
      stateHash: hash('3'),
    },
    'page:1000000001/before': {
      version: 1,
      objectRef: 'page:1000000001',
      absent: true,
      stateHash: hash('5'),
    },
    'page:1000000001/after': {
      version: 1,
      objectRef: 'page:1000000001',
      kind: 'page',
      status: 'draft',
      slug: 'prices',
      title: 'Цены',
      content: '',
      excerpt: '',
      stateHash: hash('6'),
    },
  }
  const creation = '00000000-0000-4000-8000-0000000000c1'
  const reader: DbPlanValueReader = {
    read: () => Promise.reject(new Error('records alone')),
    readState: async (_owner, objectRef, which) => ({
      state: values[`${objectRef}/${which}`]!,
      callId: objectRef.startsWith('page') ? creation : '00000000-0000-4000-8000-0000000000c2',
    }),
  }
  const site = (answers: Record<string, string>) => {
    const writes: DbWriteRequest[] = []
    const db: Partial<SiteDbGateway> = {
      writeObject: async (request) => {
        writes.push(request)
        return {
          version: 1,
          kind: 'committed',
          callId: request.callId,
          siteId: request.siteId,
          epoch: request.epoch,
          requestHash: request.requestHash,
          objectRef: request.objectRef,
          stateHash: answers[request.objectRef]!,
          ...(request.change.kind === 'post_create' ? { createdRef: request.objectRef } : {}),
        }
      },
    }
    return { gateway: { ...gateway({}), db } as unknown as PublishedContentGateway, writes }
  }

  it('replays a table, a setting and a creation in the order of the plan, in the mode restore', async () => {
    const { gateway: preview, writes } = site({
      'table:bookings': hash('2'),
      'option:blogname': hash('4'),
      'page:1000000001': hash('6'),
    })
    await replayDbPlan(
      {
        gateway: preview,
        plan,
        values: reader,
        owner: { workspaceId: 'w', taskId: 't' },
        previewId,
        epoch: 4,
      },
      signal,
    )
    expect(
      writes.map((write) => [write.objectRef, write.mode, write.expectedStateHash, write.change]),
    ).toEqual([
      [
        'table:bookings',
        'restore',
        hash('1'),
        {
          kind: 'schema_migration',
          before: { exists: false, managed: false, definition: null },
          definition,
        },
      ],
      ['option:blogname', 'restore', hash('3'), { kind: 'option_update', value: 'Цветы у дома' }],
      [
        'page:1000000001',
        'restore',
        hash('5'),
        {
          kind: 'post_create',
          record: { status: 'draft', slug: 'prices', title: 'Цены', content: '', excerpt: '' },
          // The mark of the record is the call that created it, over every rebuild.
          createCallId: creation,
        },
      ],
    ])
    expect(writes.every((write) => write.siteId === previewId && write.epoch === 4)).toBe(true)
  })

  it('stops at a receipt of another state, or a site without the objects of a plan', async () => {
    const { gateway: wrong } = site({
      'table:bookings': hash('2'),
      'option:blogname': hash('9'),
      'page:1000000001': hash('6'),
    })
    await expect(
      replayDbPlan(
        {
          gateway: wrong,
          plan,
          values: reader,
          owner: { workspaceId: 'w', taskId: 't' },
          previewId,
          epoch: 4,
        },
        signal,
      ),
    ).rejects.toMatchObject({ details: { code: 'plan_conflict' } })
    await expect(
      replayDbPlan(
        {
          gateway: gateway({}),
          plan,
          values: reader,
          owner: { workspaceId: 'w', taskId: 't' },
          previewId,
          epoch: 4,
        },
        signal,
      ),
    ).rejects.toMatchObject({ details: { code: 'plan_conflict' } })
  })

  it('compares the settings of the seed with production through the objects of a plan', async () => {
    const option = (value: string) => ({
      version: 1 as const,
      objectRef: 'option:blogname',
      value,
      stateHash: hash(value === 'A' ? 'a' : 'b'),
    })
    const withOption = (value: string) =>
      ({
        ...gateway({}),
        db: { readObject: async () => option(value) },
      }) as unknown as PublishedContentGateway
    expect(
      await seedMismatches(
        { production: withOption('A'), preview: withOption('B'), objects: ['option:blogname'] },
        signal,
      ),
    ).toEqual(['option:blogname'])
    expect(
      await seedMismatches(
        { production: withOption('A'), preview: withOption('A'), objects: ['option:blogname'] },
        signal,
      ),
    ).toEqual([])
    // A plugin without the objects of a plan answers nothing for a setting: not known equal.
    expect(
      await seedMismatches(
        { production: gateway({}), preview: withOption('A'), objects: ['option:blogname'] },
        signal,
      ),
    ).toEqual(['option:blogname'])
  })
})
