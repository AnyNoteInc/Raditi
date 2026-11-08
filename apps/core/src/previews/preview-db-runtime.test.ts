import { DB_CREATED_ID_BASE, type SiteDbCapabilities } from '@repo/domain'
import { wordpressAdapter } from '@repo/site-adapters'
import { textOnlyDbRuntime } from '@repo/site-content'
import { describe, expect, it } from 'vitest'

import { previewDbRuntime } from './preview-builder.ts'

// What the agent may change in a preview's database (docs/plan/53, «Операции БД и миграции»):
// what the adapter, production's plugin and the preview's plugin all have, and no more.

const site = {
  stack: 'wordpress' as const,
  url: 'https://site.example.test/',
  docroot: '/',
  extras: {},
}
const everything: SiteDbCapabilities = {
  version: 1,
  kind: 'capabilities',
  plugin: 2,
  operations: ['content_update', 'option_update', 'post_create', 'schema_migration'],
  settings: ['blogname', 'blogdescription', 'posts_per_page'],
  maxRecordId: 812,
}

describe('previewDbRuntime', () => {
  it('takes what all three have', () => {
    expect(
      previewDbRuntime(wordpressAdapter, site, everything, {
        ...everything,
        operations: ['content_update', 'option_update', 'post_create'],
        settings: ['blogname', 'posts_per_page', 'siteurl'],
        nextCreatedId: DB_CREATED_ID_BASE,
      }),
    ).toEqual({
      kinds: ['content_update', 'option_update', 'post_create'],
      settings: ['blogname', 'posts_per_page'],
      createdIds: true,
    })
  })

  it('gives nothing a release could not carry where a side has no gateway (Т37)', () => {
    const none = { kinds: [], settings: [], createdIds: false }
    expect(previewDbRuntime(wordpressAdapter, site, null, everything)).toEqual(none)
    expect(previewDbRuntime(wordpressAdapter, site, everything, null)).toEqual(none)
  })

  it('keeps the text of records alone where production is of version 1', () => {
    expect(
      previewDbRuntime(
        wordpressAdapter,
        site,
        { ...everything, plugin: 1, operations: ['content_update'], settings: [] },
        everything,
      ),
    ).toEqual({ kinds: ['content_update'], settings: [], createdIds: false })
  })

  it('keeps the text of records alone where a gateway that is there did not answer', () => {
    expect(previewDbRuntime(wordpressAdapter, site, 'no_answer', everything)).toEqual(
      textOnlyDbRuntime,
    )
    expect(previewDbRuntime(wordpressAdapter, site, everything, 'no_answer')).toEqual(
      textOnlyDbRuntime,
    )
  })

  it('gives no kind at all to a stack whose adapter declares none, whatever the plugins say', () => {
    expect(
      previewDbRuntime({ ...wordpressAdapter, dbOperationKinds: () => [] }, site, everything, {
        ...everything,
        nextCreatedId: DB_CREATED_ID_BASE,
      }),
    ).toEqual({ kinds: [], settings: [], createdIds: false })
  })

  it('judges the text of records as every other kind: a side that does not name it narrows it out', () => {
    const settingsOnly = { ...everything, operations: ['option_update' as const] }
    expect(previewDbRuntime(wordpressAdapter, site, settingsOnly, everything).kinds).toEqual([
      'option_update',
    ])
    expect(previewDbRuntime(wordpressAdapter, site, everything, settingsOnly).kinds).toEqual([
      'option_update',
    ])
  })

  it('gives nothing where the adapter cannot say what the stack has', () => {
    const broken = {
      ...wordpressAdapter,
      dbSettings: () => {
        throw new Error('no settings')
      },
    }
    expect(previewDbRuntime(broken, site, everything, everything)).toEqual({
      kinds: [],
      settings: [],
      createdIds: false,
    })
  })

  it('gives no created records to a site whose own ids reach the base', () => {
    expect(
      previewDbRuntime(
        wordpressAdapter,
        site,
        { ...everything, maxRecordId: DB_CREATED_ID_BASE },
        everything,
      ).createdIds,
    ).toBe(false)
  })
})
