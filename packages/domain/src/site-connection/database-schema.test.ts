import { describe, expect, it } from 'vitest'

import { databaseStructureSchema, type DatabaseStructure } from './database-schema.ts'
import { databaseSchemaLimits } from './limits.ts'

const column = {
  name: 'id',
  type: 'bigint',
  nullable: false,
  hasDefault: false,
  generated: false,
  autoIncrement: true,
}
const table = {
  schema: null,
  name: 'wp_posts',
  kind: 'table',
  columns: [
    column,
    { ...column, name: 'post_title', type: 'varchar(255)', autoIncrement: false },
    { ...column, name: 'post_status', type: 'enum', hasDefault: true, autoIncrement: false },
  ],
  primaryKey: ['id'],
  indexes: [
    { name: 'post_title', unique: false, columns: ['post_title'] },
    { name: 'lower_title', unique: true, columns: [null, 'id'] },
  ],
  foreignKeys: [
    {
      name: 'wp_posts_author',
      columns: ['post_author'],
      referencedSchema: null,
      referencedTable: 'wp_users',
      referencedColumns: ['ID'],
    },
  ],
} as const
const structure = { v: 1, engine: 'mysql', tables: [table], truncated: false } as const

const withTable = (change: Record<string, unknown>) => ({
  ...structure,
  tables: [{ ...table, ...change }],
})
const withColumn = (change: Record<string, unknown>) =>
  withTable({ columns: [{ ...column, ...change }] })

describe('databaseStructureSchema', () => {
  it('reads the structure of a MySQL and of a PostgreSQL database', () => {
    const parsed: DatabaseStructure = databaseStructureSchema.parse(structure)
    expect(parsed).toEqual(structure)
    const postgres = {
      v: 1,
      engine: 'postgres',
      tables: [
        { ...table, schema: 'public', name: 'orders', kind: 'partitioned_table' },
        { ...table, schema: 'public', name: 'orders_view', kind: 'view', primaryKey: [] },
        { ...table, schema: 'reports', name: 'totals', kind: 'materialized_view' },
        {
          ...table,
          schema: 'public',
          name: 'remote',
          kind: 'foreign_table',
          foreignKeys: [{ ...table.foreignKeys[0], referencedSchema: 'auth' }],
        },
      ],
      truncated: true,
    }
    expect(databaseStructureSchema.parse(postgres)).toEqual(postgres)
    expect(databaseStructureSchema.parse({ ...structure, tables: [] }).tables).toEqual([])
  })

  // Strict at every level: what is never stored cannot arrive as one more field.
  it.each([
    ['the document', { ...structure, serverVersion: '8.4.11' }],
    ['a table: its comment', withTable({ comment: 'Записи' })],
    ['a table: its row estimate', withTable({ rows: 120_000 })],
    ['a table: the text of a view', withTable({ definition: 'SELECT * FROM wp_users' })],
    ['a column: its default', withColumn({ default: "'publish'" })],
    ['a column: its enum values', withColumn({ values: ['draft', 'publish'] })],
    ['a column: its comment', withColumn({ comment: 'Телефон клиента' })],
    [
      'an index: its expression',
      withTable({
        indexes: [{ name: 'i', unique: false, columns: [null], expression: 'lower(x)' }],
      }),
    ],
    [
      'a foreign key: its actions',
      withTable({ foreignKeys: [{ ...table.foreignKeys[0], onDelete: 'CASCADE' }] }),
    ],
  ])('refuses an unknown field of %s', (_where, document) => {
    expect(databaseStructureSchema.safeParse(document).success).toBe(false)
  })

  it('accepts at most 1000 tables', () => {
    expect(databaseSchemaLimits.tables).toBe(1_000)
    const tables = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...table, name: `t${index}` }))
    expect(databaseStructureSchema.safeParse({ ...structure, tables: tables(1_000) }).success).toBe(
      true,
    )
    expect(databaseStructureSchema.safeParse({ ...structure, tables: tables(1_001) }).success).toBe(
      false,
    )
  })

  it('bounds every name: 128 characters, not empty, no control character', () => {
    expect(databaseSchemaLimits.identifierChars).toBe(128)
    const longest = 'я'.repeat(128)
    const names = (name: unknown) => [
      withTable({ name }),
      withTable({ schema: name }),
      withColumn({ name }),
      withTable({ primaryKey: [name] }),
      withTable({ indexes: [{ name, unique: false, columns: ['id'] }] }),
      withTable({ indexes: [{ name: 'i', unique: false, columns: [name] }] }),
      withTable({ foreignKeys: [{ ...table.foreignKeys[0], name }] }),
      withTable({ foreignKeys: [{ ...table.foreignKeys[0], columns: [name] }] }),
      withTable({ foreignKeys: [{ ...table.foreignKeys[0], referencedSchema: name }] }),
      withTable({ foreignKeys: [{ ...table.foreignKeys[0], referencedTable: name }] }),
      withTable({ foreignKeys: [{ ...table.foreignKeys[0], referencedColumns: [name] }] }),
    ]
    for (const document of names(longest))
      expect(databaseStructureSchema.safeParse(document).success).toBe(true)
    for (const name of [`${longest}я`, '', 'wp\u0000posts', 'wp\nposts', 'wp\u007f', 7])
      for (const [index, document] of names(name).entries())
        expect(databaseStructureSchema.safeParse(document).success, `${index}: ${name}`).toBe(false)
  })

  it('bounds a type name: 128 characters, not empty', () => {
    expect(databaseSchemaLimits.typeChars).toBe(128)
    expect(databaseStructureSchema.safeParse(withColumn({ type: 'x'.repeat(128) })).success).toBe(
      true,
    )
    for (const type of ['x'.repeat(129), '', null, ['int']])
      expect(databaseStructureSchema.safeParse(withColumn({ type })).success).toBe(false)
  })

  it('lets only an index column be an expression', () => {
    const expression = withTable({ indexes: [{ name: 'i', unique: false, columns: [null] }] })
    expect(databaseStructureSchema.safeParse(expression).success).toBe(true)
    expect(databaseStructureSchema.safeParse(withTable({ primaryKey: [null] })).success).toBe(false)
    expect(databaseStructureSchema.safeParse(withTable({ name: null })).success).toBe(false)
    expect(
      databaseStructureSchema.safeParse(
        withTable({ foreignKeys: [{ ...table.foreignKeys[0], columns: [null] }] }),
      ).success,
    ).toBe(false)
  })

  it('refuses another version, engine or kind of table and a missing flag', () => {
    for (const change of [
      { v: 2 },
      { v: '1' },
      { engine: 'mariadb' },
      { engine: 'sqlite' },
      { truncated: undefined },
      { truncated: 'no' },
      { tables: undefined },
    ])
      expect(databaseStructureSchema.safeParse({ ...structure, ...change }).success).toBe(false)
    for (const kind of ['sequence', 'index', 'TABLE', ''])
      expect(databaseStructureSchema.safeParse(withTable({ kind })).success).toBe(false)
    for (const flag of ['nullable', 'hasDefault', 'generated', 'autoIncrement'])
      for (const value of [undefined, 'YES', 1])
        expect(databaseStructureSchema.safeParse(withColumn({ [flag]: value })).success).toBe(false)
  })
})
