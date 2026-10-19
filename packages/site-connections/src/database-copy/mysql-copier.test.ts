import { createServer, type AddressInfo } from 'node:net'

import type { DatabaseCopyInput, DatabaseCopyPolicy } from '@repo/domain'
import { DatabaseCopyError, SiteConnectionError } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { createMysqlDatabaseCopier } from './mysql-copier.ts'

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
