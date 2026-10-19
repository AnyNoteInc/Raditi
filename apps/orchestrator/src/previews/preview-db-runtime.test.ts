import { DB_CREATED_ID_BASE, type SiteDbCapabilities } from '@repo/domain'
import { wordpressAdapter } from '@repo/site-adapters'
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

  it('keeps the text of records alone where a side cannot tell, or production is of version 1', () => {
    const textOnly = { kinds: ['content_update'], settings: [], createdIds: false }
    expect(previewDbRuntime(wordpressAdapter, site, null, everything)).toEqual(textOnly)
    expect(previewDbRuntime(wordpressAdapter, site, everything, null)).toEqual(textOnly)
    expect(
      previewDbRuntime(
        wordpressAdapter,
        site,
        { ...everything, plugin: 1, operations: ['content_update'], settings: [] },
        everything,
      ),
    ).toEqual(textOnly)
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
