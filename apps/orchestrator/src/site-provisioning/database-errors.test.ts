import { Prisma } from '@repo/db'
import { describe, expect, it } from 'vitest'

import { isTransientDatabaseError } from './database-errors.ts'
import { refuse } from './import-failure.ts'

const known = (code: string, cause?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('synthetic database failure', {
    code,
    clientVersion: '7.10.0',
    ...(cause ? { meta: { driverAdapterError: { cause } } } : {}),
  })

describe('isTransientDatabaseError', () => {
  it.each([
    ['a pool or transaction wait', known('P2028')],
    ['a pool timeout', known('P2024')],
    ['a closed connection', known('P1017')],
    ['a deadlock', known('P2034', { originalCode: '40P01', kind: 'TransactionWriteConflict' })],
    ['a socket timeout under a raw query', known('P2010', { kind: 'SocketTimeout' })],
    ['a server shutting down', known('P2010', { originalCode: '57P01', kind: 'postgres' })],
    ['a connection exception', known('P2039', { originalCode: '08003', kind: 'postgres' })],
    ['no server at start', new Prisma.PrismaClientInitializationError('x', '7.10.0', 'P1001')],
  ])('names %s a hiccup', (_, error) => {
    expect(isTransientDatabaseError(error)).toBe(true)
  })

  it.each([
    ['a unique violation', known('P2002', { originalCode: '23505' })],
    ['a raw query with bad data', known('P2010', { originalCode: '22P02', kind: 'postgres' })],
    ['a missing table', known('P2021', { kind: 'TableDoesNotExist' })],
    ['refused credentials', new Prisma.PrismaClientInitializationError('x', '7.10.0', 'P1000')],
    [
      'an initialization error without a code',
      new Prisma.PrismaClientInitializationError('x', '7.10.0'),
    ],
    ['an error of the import itself', refuse('internal')],
    ['any other error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'P1001' })],
    ['nothing', undefined],
  ])('names %s an answer', (_, error) => {
    expect(isTransientDatabaseError(error)).toBe(false)
  })
})
