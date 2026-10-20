import { randomBytes } from 'node:crypto'

import type {
  DbAbsentState,
  DbContentUpdate,
  DbOperation,
  DbOptionState,
  DbTableState,
  PublishedContentState,
} from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { openOperationValue } from '../deploy-step/content.ts'
import { dbOperationValue, sealDbOperationValue } from './release-db-values.ts'

const RELEASE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const value = { key: 'previews/x/1.bin', sha256: 'f'.repeat(64), sizeBytes: 10 }
const operation: DbContentUpdate = {
  kind: 'content_update',
  objectRef: 'page:42',
  fields: ['content', 'title'],
  beforeHash: '3'.repeat(64),
  afterHash: '4'.repeat(64),
  before: value,
  after: value,
}
const state: PublishedContentState = {
  version: 1,
  objectRef: 'page:42',
  kind: 'page',
  title: 'Цены',
  content: '<p>Новые цены</p>',
  excerpt: 'не меняется',
  stateHash: '4'.repeat(64),
}
const ofKind = <Kind extends DbOperation['kind']>(
  kind: Kind,
  objectRef: string,
  fields: string[],
): DbOperation => ({ ...operation, kind, objectRef, fields }) as DbOperation
const plain = (buffer: Buffer) => JSON.parse(buffer.toString('utf8')) as unknown

describe('the values of a database plan for the deploy job', () => {
  it('keeps exactly the fields of the operation', () => {
    expect(plain(dbOperationValue({ after: state, before: null }, operation))).toEqual({
      v: 1,
      fields: { title: 'Цены', content: '<p>Новые цены</p>' },
    })
  })

  it('keeps of each other kind what its write needs, and nothing of another kind', () => {
    const option: DbOptionState = {
      version: 1,
      objectRef: 'option:blogname',
      value: 'Лавка',
      stateHash: '5'.repeat(64),
    }
    const setting = ofKind('option_update', 'option:blogname', ['value'])
    expect(plain(dbOperationValue({ after: option, before: null }, setting))).toEqual({
      v: 1,
      value: 'Лавка',
    })
    const created = { ...state, objectRef: 'page:1000000001', slug: 'prices', status: 'draft' }
    const creation = ofKind('post_create', 'page:1000000001', ['title', 'content', 'excerpt'])
    expect(
      plain(dbOperationValue({ after: created as PublishedContentState, before: null }, creation)),
    ).toEqual({
      v: 1,
      record: {
        status: 'draft',
        slug: 'prices',
        title: 'Цены',
        content: '<p>Новые цены</p>',
        excerpt: 'не меняется',
      },
    })
    const definition = {
      columns: [{ name: 'note', type: 'text' as const, nullable: true }],
      indexes: [],
    }
    const absent: DbTableState = {
      version: 1,
      objectRef: 'table:bookings',
      exists: false,
      managed: false,
      definition: null,
      stateHash: '6'.repeat(64),
    }
    const table: DbTableState = { ...absent, exists: true, managed: true, definition }
    const migration = ofKind('schema_migration', 'table:bookings', ['definition'])
    expect(plain(dbOperationValue({ after: table, before: absent }, migration))).toEqual({
      v: 1,
      before: { exists: false, managed: false, definition: null },
      definition,
    })
    // A side of another kind is broken data: nothing is sealed of it.
    const gone: DbAbsentState = {
      version: 1,
      objectRef: 'page:1000000001',
      absent: true,
      stateHash: '7'.repeat(64),
    }
    expect(() => dbOperationValue({ after: gone, before: null }, creation)).toThrow()
    expect(() => dbOperationValue({ after: table, before: null }, migration)).toThrow()
    expect(() => dbOperationValue({ after: state, before: null }, setting)).toThrow()
  })

  it('seals them so that the job opens them for this release and this object only', () => {
    const key = randomBytes(32)
    const sealed = sealDbOperationValue({ after: state, before: null }, operation, RELEASE, key)
    expect(openOperationValue(sealed, key, RELEASE, operation)).toEqual({
      v: 1,
      fields: { title: 'Цены', content: '<p>Новые цены</p>' },
    })
    expect(() =>
      openOperationValue(sealed, key, RELEASE, { ...operation, objectRef: 'page:43' }),
    ).toThrow()
    expect(() =>
      openOperationValue(sealed, key, '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62', operation),
    ).toThrow()
    expect(() => openOperationValue(sealed, randomBytes(32), RELEASE, operation)).toThrow()
    // Another set of fields does not pass for this operation.
    expect(() =>
      openOperationValue(sealed, key, RELEASE, { ...operation, fields: ['title'] }),
    ).toThrow()
  })
})
