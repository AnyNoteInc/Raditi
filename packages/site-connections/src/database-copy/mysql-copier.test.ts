import { createServer, type AddressInfo } from 'node:net'

import type { DatabaseCopyInput, DatabaseCopyPolicy } from '@repo/domain'
import { DatabaseCopyError, SiteConnectionError, suspectColumnNames } from '@repo/domain'
import type { FieldPacket } from 'mysql2'
import { describe, expect, it } from 'vitest'

import {
  checkedColumns,
  type Column,
  createMysqlDatabaseCopier,
  leavesRowsOut,
  suspectTreatment,
  TableRows,
  type TableInfo,
} from './mysql-copier.ts'

// What the copier refuses before it reads a row; the copy itself runs against MariaDB in
// mysql-copier.integration.test.ts.

const policy: DatabaseCopyPolicy = {
  engine: 'mysql',
  tables: [{ table: 'posts', where: [{ op: 'in', column: 'post_type', values: ['post'] }] }],
  overrides: [],
}
const input = (overrides: Partial<DatabaseCopyInput> = {}): DatabaseCopyInput => ({
  access: {
    v: '1',
    engine: 'mysql',
    host: '127.0.0.1',
    port: '3306',
    tls: 'plain',
    database: 'shop',
    username: 'shop',
    password: 'not-a-real-password',
  },
  tablePrefix: 'wp_',
  charset: 'utf8mb4',
  collation: null,
  policy,
  ...overrides,
})
const copier = (appEnv: 'test' | 'production' = 'test') =>
  createMysqlDatabaseCopier({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], appEnv })
const discard = async () => undefined

describe('the MySQL copier before the first row', () => {
  it('copies MySQL in an encoding a seed can be written in, by a policy it can follow', async () => {
    await expect(
      copier().copy(input({ access: { ...input().access, engine: 'postgres' } }), discard),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(copier().copy(input({ charset: 'sjis' }), discard)).rejects.toEqual(
      new DatabaseCopyError('encoding_unsupported'),
    )
    await expect(copier().copy(input({ tablePrefix: 'wp-' }), discard)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    const cycle: DatabaseCopyPolicy = {
      engine: 'mysql',
      overrides: [],
      tables: [
        { table: 'a', where: [{ op: 'inCopied', column: 'x', table: 'b', key: 'y' }] },
        { table: 'b', where: [{ op: 'inCopied', column: 'y', table: 'a', key: 'x' }] },
      ],
    }
    await expect(copier().copy(input({ policy: cycle }), discard)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('connects only where the rule of site addresses lets it', async () => {
    const production = input({ access: { ...input().access, host: '10.0.0.5' } })
    await expect(copier('production').copy(production, discard)).rejects.toEqual(
      new SiteConnectionError('address_not_allowed'),
    )
  })

  it('names a closed port and a server that answers nothing, never their text', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    await expect(
      copier().copy(input({ access: { ...input().access, port: String(port) } }), discard),
    ).rejects.toEqual(new SiteConnectionError('unreachable'))

    // A listener that never greets: the caller's signal ends the handshake.
    const silent = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    try {
      const reason = new Error('stopped by the caller')
      const controller = new AbortController()
      setTimeout(() => controller.abort(reason), 100)
      const access = { ...input().access, port: String((silent.address() as AddressInfo).port) }
      await expect(copier().copy(input({ access }), discard, controller.signal)).rejects.toBe(
        reason,
      )
    } finally {
      silent.close()
    }
  })
})

describe('the second line of unnamed columns', () => {
  const column = (name: string, type: string, rest: Partial<Column> = {}): Column => ({
    name,
    type,
    generated: false,
    nullable: false,
    unique: false,
    checked: false,
    ...rest,
  })
  const info: TableInfo = {
    columns: [
      column('id', 'int', { unique: true }),
      column('acme_phone', 'varchar'),
      column('title', 'varchar'),
      column('acme_note', 'longtext', { nullable: true, checked: true }),
    ],
    primaryKey: ['id'],
  }
  const fields = [
    { columnType: 0x03 },
    { columnType: 0xfd, characterSet: 45 },
    { columnType: 0xfd, characterSet: 45 },
    { columnType: 0xfc, characterSet: 45 },
  ] as FieldPacket[]
  const row = ['7', '+7 900 000-00-01', 'Контакты', 'заметка'].map((value) => Buffer.from(value))
  const rowsOf = (
    rule: DatabaseCopyPolicy['tables'][number],
    suspectColumns: DatabaseCopyPolicy['suspectColumns'],
    of: TableInfo = info,
  ) => {
    const rows = new TableRows(rule, [], of, new Set(), suspectColumns)
    rows.fields(fields.slice(0, of.columns.length))
    return {
      text: rows.tuple(row.slice(0, of.columns.length))!.toString('utf8'),
      emptied: rows.emptiedColumns,
    }
  }
  const rule = { table: 'acme_contacts', where: [] }

  it('copies an unnamed column with the name of people or a secret empty, once per column', () => {
    // NULL where the column takes it: a CHECK such as MariaDB's `json_valid` passes it.
    expect(rowsOf(rule, 'empty')).toEqual({ text: `(7,'','Контакты',NULL)`, emptied: 2 })
    // A column the adapter names passes as the adapter says, `keep` included.
    expect(
      rowsOf({ ...rule, columns: { acme_phone: 'keep', acme_note: 'keep' } }, 'empty'),
    ).toEqual({ text: `(7,'+7 900 000-00-01','Контакты','заметка')`, emptied: 0 })
    // Without the field every unnamed column is copied as it is: WordPress.
    expect(rowsOf(rule, undefined)).toEqual({
      text: `(7,'+7 900 000-00-01','Контакты','заметка')`,
      emptied: 0,
    })
  })

  it('writes NULL where the column takes it and an empty literal only where every row loads it', () => {
    const treat = (of: Column) => suspectTreatment(rule, of, 'empty')
    expect(treat(column('acme_phone', 'varchar'))).toBe('empty')
    expect(treat(column('billing_zip', 'int'))).toBe('empty')
    expect(treat(column('birthdate', 'date'))).toBe('empty')
    expect(treat(column('customer_type', 'enum'))).toBe('empty')
    // NULL takes a unique key, a CHECK, JSON and geometry alike.
    expect(treat(column('api_token', 'varchar', { nullable: true, unique: true }))).toBe('null')
    expect(treat(column('customer_data', 'longtext', { nullable: true, checked: true }))).toBe(
      'null',
    )
    expect(treat(column('address_point', 'point', { nullable: true }))).toBe('null')
    // Without NULL one value in every row breaks a key, a CHECK or a type without an empty one.
    expect(treat(column('client_id', 'int', { unique: true }))).toBe('unwritable')
    expect(treat(column('customer_data', 'longtext', { checked: true }))).toBe('unwritable')
    expect(treat(column('customer_data', 'json'))).toBe('unwritable')
    expect(treat(column('address_point', 'point'))).toBe('unwritable')
    expect(treat(column('ip_address', 'inet6'))).toBe('unwritable')
    // Not the second line's: a named column, a generated one, another name, no field.
    expect(
      suspectTreatment(
        { ...rule, columns: { client_id: 'keep' } },
        column('client_id', 'int', { unique: true }),
        'empty',
      ),
    ).toBeUndefined()
    expect(treat(column('acme_email', 'varchar', { generated: true }))).toBeUndefined()
    expect(treat(column('title', 'varchar'))).toBeUndefined()
    expect(suspectTreatment(rule, column('acme_phone', 'varchar'), undefined)).toBeUndefined()
  })

  it('takes a table out whole when an unnamed column of it holds neither empty nor NULL', () => {
    const keyed: TableInfo = {
      columns: [
        column('client_id', 'int', { unique: true }),
        column('id', 'int', { unique: true }),
      ],
      primaryKey: ['client_id', 'id'],
    }
    expect(leavesRowsOut(rule, keyed, 'empty')).toBe(true)
    expect(leavesRowsOut({ ...rule, columns: { client_id: 'keep' } }, keyed, 'empty')).toBe(false)
    expect(leavesRowsOut(rule, keyed, undefined)).toBe(false)
    expect(leavesRowsOut(rule, info, 'empty')).toBe(false)
    // The copy builds no rows of such a table.
    expect(() => new TableRows(rule, [], keyed, new Set(), 'empty')).toThrow()
  })

  it('reads a column named like a property of an object as unnamed', () => {
    const named: TableInfo = {
      columns: [column('id', 'int', { unique: true }), column('constructor', 'varchar')],
      primaryKey: ['id'],
    }
    const withRule = { ...rule, columns: { title: 'keep' as const } }
    for (const suspect of [undefined, 'empty'] as const)
      expect(rowsOf(withRule, suspect, named)).toEqual({
        text: `(7,'+7 900 000-00-01')`,
        emptied: 0,
      })
  })

  it('finds the columns a CHECK names, inline or as a constraint of the table', () => {
    const statement = Buffer.from(
      [
        'CREATE TABLE `acme` (',
        '  `id` int(11) NOT NULL,',
        '  `customer_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`customer_data`)),',
        '  `title` varchar(64) NOT NULL,',
        '  `Price` int NOT NULL,',
        '  PRIMARY KEY (`id`),',
        '  CONSTRAINT `price_positive` CHECK (`Price` > 0)',
        ') ENGINE=InnoDB',
      ].join('\n'),
    )
    expect([...checkedColumns(statement)].sort()).toEqual(['customer_data', 'price'])
  })

  it('takes names of people and secrets, and not the words inside other names', () => {
    for (const name of [
      'acme_phone',
      'acme_address',
      'acme_pwd',
      'billing_city',
      'zip',
      'client_id',
      'card_number',
      'inn',
      'license_key',
      'webhook_url',
      'birthdate',
      // One name for each word of the pattern, and names in any case.
      'user_email',
      'mail_to',
      'mobile',
      'fax',
      'user_password',
      'user_pass',
      'pass',
      'api_token',
      'client_secret',
      'apikey',
      'api_key',
      'auth_key',
      'ip_address',
      'ipaddr',
      'firstname',
      'lastname',
      'fio',
      'passport_no',
      'comment_text',
      'note',
      'message',
      'customer_group',
      'postcode',
      'dob',
      'contactPhone',
      'Email',
      'CARD',
    ])
      expect(suspectColumnNames.test(name), name).toBe(true)
    for (const name of [
      'bypass',
      'capacity',
      'gzip_level',
      'wildcard',
      'winner',
      'name',
      'title',
      'compass',
      'clientele',
      'postcodes',
      'dobby',
    ])
      expect(suspectColumnNames.test(name), name).toBe(false)
  })
})
