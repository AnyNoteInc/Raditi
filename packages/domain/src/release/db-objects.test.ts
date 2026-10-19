import { describe, expect, it } from 'vitest'

import { publishedContentHashMaterial } from '../ports/published-content.ts'
import {
  absentStateHashMaterial,
  additiveChange,
  DB_CREATED_ID_BASE,
  dbColumnSchema,
  dbColumnTypeText,
  dbHashFrames,
  dbObjectRefSchema,
  dbObjectStateSchema,
  dbSettingSchema,
  dbSettingValueAllowed,
  dbSlugSchema,
  dbStateTexts,
  isCreatedRef,
  mentionsCreatedId,
  normalizeTableDefinition,
  optionStateHashMaterial,
  tableDefinitionSchema,
  tableStateHashMaterial,
  type TableDefinition,
} from './db-objects.ts'

describe('references', () => {
  it('names records, settings and tables apart, never one as another', () => {
    for (const ref of ['page:42', 'post:1000000001', 'option:blogname', 'table:bookings'])
      expect(dbObjectRefSchema.safeParse(ref).success, ref).toBe(true)
    for (const ref of ['option:5', 'table:7', 'option:Blog', 'table:a-b', 'page:0', 'table:'])
      expect(dbObjectRefSchema.safeParse(ref).success, ref).toBe(false)
  })

  it('tells a created record by its id', () => {
    expect(isCreatedRef(`page:${DB_CREATED_ID_BASE}`)).toBe(true)
    expect(isCreatedRef('page:999999999')).toBe(false)
    expect(isCreatedRef('option:blogname')).toBe(false)
  })

  it('finds a created id only as a number of its own', () => {
    const ids = [1000000001]
    for (const text of ['.page-id-1000000001 a', '?page_id=1000000001', 'page-1000000001.php'])
      expect(mentionsCreatedId(text, ids), text).toBe(true)
    for (const text of ['10000000012', '21000000001', 'id 1000000002', ''])
      expect(mentionsCreatedId(text, ids), text).toBe(false)
    expect(mentionsCreatedId('1000000001', [])).toBe(false)
  })
})

describe('states', () => {
  it('frames values by their bytes, as the plugin does', () => {
    expect(dbHashFrames(['ab', 'щ', ''])).toBe('2:ab2:щ0:')
    expect(absentStateHashMaterial('page:1000000001')).toBe('6:absent15:page:1000000001')
    expect(optionStateHashMaterial({ objectRef: 'option:blogname', value: null })).toBe(
      '6:option15:option:blogname1:00:',
    )
  })

  it('keeps the hash a published record always had', () => {
    const record = {
      version: 1 as const,
      objectRef: 'page:42',
      kind: 'page' as const,
      title: 'Контакты',
      content: '<p>Адрес</p>',
      excerpt: '',
    }
    expect(publishedContentHashMaterial({ ...record, status: 'publish' })).toBe(
      publishedContentHashMaterial(record),
    )
    expect(publishedContentHashMaterial({ ...record, status: 'draft' })).not.toBe(
      publishedContentHashMaterial(record),
    )
  })

  it('reads every kind of state, each by its own shape', () => {
    const table = {
      version: 1,
      objectRef: 'table:bookings',
      exists: false,
      managed: false,
      definition: null,
      stateHash: 'a'.repeat(64),
    }
    for (const state of [
      { version: 1, objectRef: 'page:1000000001', absent: true, stateHash: 'a'.repeat(64) },
      { version: 1, objectRef: 'option:blogname', value: 'Цветы', stateHash: 'a'.repeat(64) },
      table,
    ])
      expect(dbObjectStateSchema.safeParse(state).success, JSON.stringify(state)).toBe(true)
    expect(dbObjectStateSchema.safeParse({ ...table, managed: true }).success).toBe(false)
  })

  it('lists every text a state writes or shows, addresses and names included', () => {
    const hash = 'a'.repeat(64)
    expect(
      dbStateTexts({
        version: 1,
        objectRef: 'page:1000000001',
        kind: 'page',
        title: 'Цены',
        content: '<p>От 500</p>',
        excerpt: 'Кратко',
        slug: 'prices',
        stateHash: hash,
      }),
    ).toEqual(['Цены', '<p>От 500</p>', 'Кратко', 'prices'])
    expect(
      dbStateTexts({ version: 1, objectRef: 'option:blogname', value: null, stateHash: hash }),
    ).toEqual([])
    expect(
      dbStateTexts({
        version: 1,
        objectRef: 'table:bookings',
        exists: true,
        managed: true,
        definition: bookings,
        stateHash: hash,
      }),
    ).toEqual(['bookings', 'name', 'starts_at', 'guests', '1', 'starts'])
    expect(
      dbStateTexts({ version: 1, objectRef: 'page:1000000001', absent: true, stateHash: hash }),
    ).toEqual([])
  })
})

const bookings: TableDefinition = {
  columns: [
    { name: 'name', type: 'string', length: 120, nullable: false },
    { name: 'starts_at', type: 'datetime', nullable: false, default: { now: true } },
    { name: 'guests', type: 'integer', nullable: false, default: { value: '1' } },
  ],
  indexes: [{ name: 'starts', columns: ['starts_at'], unique: false }],
}

describe('the dictionary of tables', () => {
  it('takes a definition in its one spelling', () => {
    expect(tableDefinitionSchema.safeParse(bookings).success).toBe(true)
    const unordered = {
      ...bookings,
      indexes: [
        { name: 'z', columns: ['name'], unique: false },
        { name: 'a', columns: ['guests'], unique: true },
      ],
    }
    expect(tableDefinitionSchema.safeParse(unordered).success).toBe(false)
    expect(tableDefinitionSchema.safeParse(normalizeTableDefinition(unordered)).success).toBe(true)
  })

  it('refuses names, types and defaults outside the dictionary', () => {
    const column = (extra: object) => ({ name: 'price', nullable: true, ...extra })
    for (const broken of [
      column({ name: 'id', type: 'integer' }),
      column({ name: 'Price', type: 'integer' }),
      column({ type: 'string' }),
      column({ type: 'string', length: 192 }),
      column({ type: 'integer', length: 10 }),
      column({ type: 'decimal', precision: 10 }),
      column({ type: 'decimal', precision: 10, scale: 2, default: { value: '1.5' } }),
      column({ type: 'decimal', precision: 4, scale: 2, default: { value: '123.00' } }),
      column({ type: 'decimal', precision: 4, scale: 2, default: { value: '-0.00' } }),
      column({ type: 'integer', default: { value: '01' } }),
      column({ type: 'integer', default: { value: '2147483648' } }),
      column({ type: 'unsigned_big_integer', default: { value: '-1' } }),
      column({ type: 'boolean', default: { value: 'true' } }),
      column({ type: 'text', default: { value: '' } }),
      column({ type: 'date', default: { value: '2026-02-30' } }),
      column({ type: 'string', length: 3, default: { value: 'four' } }),
      column({ type: 'string', length: 9, default: { value: 'a\nb' } }),
      column({ type: 'string', length: 9, default: { value: "д'Ар" } }),
      column({ type: 'string', length: 9, default: { value: 'a\\b' } }),
      column({ type: 'integer', default: { now: true } }),
      column({ type: 'integer', sql: 'DROP TABLE wp_users' }),
    ])
      expect(dbColumnSchema.safeParse(broken).success, JSON.stringify(broken)).toBe(false)
    for (const good of [
      column({ type: 'decimal', precision: 10, scale: 2, default: { value: '-1.50' } }),
      column({ type: 'decimal', precision: 2, scale: 2, default: { value: '0.25' } }),
      column({ type: 'unsigned_big_integer', default: { value: '18446744073709551615' } }),
      column({ type: 'string', length: 4, default: { value: 'дАр' } }),
      column({ type: 'datetime', default: { value: '2026-10-18 13:00:00' } }),
    ])
      expect(dbColumnSchema.safeParse(good).success, JSON.stringify(good)).toBe(true)
    expect(
      tableDefinitionSchema.safeParse({
        columns: [{ name: 'note', type: 'text', nullable: true }],
        indexes: [{ name: 'note', columns: ['note'], unique: false }],
      }).success,
    ).toBe(false)
  })

  it('says a table differently when it is the platform’s, and by every field', () => {
    const state = { objectRef: 'table:bookings', exists: true, managed: true, definition: bookings }
    const hashes = new Set(
      [
        state,
        { ...state, managed: false },
        { ...state, definition: { ...bookings, indexes: [] } },
        {
          ...state,
          definition: {
            ...bookings,
            columns: [{ ...bookings.columns[0]!, length: 121 }, ...bookings.columns.slice(1)],
          },
        },
        { objectRef: 'table:bookings', exists: false, managed: false, definition: null },
      ].map((given) => tableStateHashMaterial(given)),
    )
    expect(hashes.size).toBe(5)
  })

  it('allows only additions to a table that is there', () => {
    expect(additiveChange(null, bookings)).toBe('create')
    expect(additiveChange(bookings, bookings)).toBe('same')
    const note = { name: 'note', type: 'text' as const, nullable: true }
    const added = { ...bookings, columns: [...bookings.columns, note] }
    expect(additiveChange(bookings, added)).toBe('add')
    const indexed = {
      ...added,
      indexes: [...bookings.indexes, { name: 'tname', columns: ['name'], unique: false }],
    }
    expect(additiveChange(bookings, indexed)).toBe('add')
    for (const after of [
      { ...bookings, columns: bookings.columns.slice(1) },
      { ...bookings, columns: [note, ...bookings.columns] },
      { ...bookings, columns: [...bookings.columns, { ...note, nullable: false }] },
      {
        ...bookings,
        columns: [
          ...bookings.columns,
          {
            name: 'at',
            type: 'datetime' as const,
            nullable: false,
            default: { now: true as const },
          },
        ],
      },
      { ...bookings, indexes: [] },
      {
        ...bookings,
        indexes: [...bookings.indexes, { name: 'uname', columns: ['name'], unique: true }],
      },
      { ...bookings, indexes: [{ ...bookings.indexes[0]!, columns: ['name'] }] },
    ])
      expect(additiveChange(bookings, after), JSON.stringify(after)).toBeNull()
  })
})

describe('settings and addresses', () => {
  const title = dbSettingSchema.parse({
    option: 'blogname',
    setting: 'title',
    label: 'Название сайта',
    value: 'text',
    maxBytes: 200,
    display: 'html_text',
  })
  const perPage = dbSettingSchema.parse({
    option: 'posts_per_page',
    setting: 'posts_per_page',
    label: 'Записей на странице блога',
    value: 'integer',
    min: 1,
    max: 100,
    display: 'plain',
  })

  it('takes a value of its setting in its one spelling', () => {
    expect(dbSettingValueAllowed(title, 'Цветы у дома')).toBe(true)
    expect(dbSettingValueAllowed(title, 'щ'.repeat(101))).toBe(false)
    expect(dbSettingValueAllowed(title, 'a\u0000')).toBe(false)
    expect(dbSettingValueAllowed(perPage, '10')).toBe(true)
    for (const value of ['010', '0', '101', '1.5', ' 10', '-0'])
      expect(dbSettingValueAllowed(perPage, value), value).toBe(false)
  })

  it('takes an address of Latin letters, digits and single hyphens, not digits alone', () => {
    for (const slug of ['prices', 'price-list-2026', 'a1'])
      expect(dbSlugSchema.safeParse(slug).success, slug).toBe(true)
    for (const slug of ['2026', 'Prices', 'цены', 'a--b', '-a', 'a b', ''])
      expect(dbSlugSchema.safeParse(slug).success, slug).toBe(false)
  })
})

describe('the words of a type of a column', () => {
  it('agrees the noun with its number', () => {
    const string = (length: number) => dbColumnTypeText({ type: 'string', length })
    expect(string(191)).toBe('строка до 191 знака')
    expect(string(1)).toBe('строка до 1 знака')
    expect(string(11)).toBe('строка до 11 знаков')
    expect(string(120)).toBe('строка до 120 знаков')
    const decimal = (scale: number) => dbColumnTypeText({ type: 'decimal', scale })
    expect(decimal(2)).toBe('число с дробной частью (2 знака после запятой)')
    expect(decimal(1)).toBe('число с дробной частью (1 знак после запятой)')
    expect(decimal(5)).toBe('число с дробной частью (5 знаков после запятой)')
    expect(decimal(0)).toBe('число без дробной части')
  })
})
