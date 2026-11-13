import { pageLimits } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import {
  admitInWindow,
  hashPagePassword,
  pagePasswordProblem,
  verifyPagePassword,
} from './page-passwords.ts'

describe('the password of a page (plan 69, Ст13)', () => {
  it('keeps a salted scrypt hash and checks a password by it', async () => {
    const hash = await hashPagePassword('секрет-1')
    expect(hash).toMatch(/^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    expect(hash).not.toContain('секрет')
    expect(await hashPagePassword('секрет-1')).not.toBe(hash)
    expect(await verifyPagePassword('секрет-1', hash)).toBe(true)
    expect(await verifyPagePassword('секрет-2', hash)).toBe(false)
    // The same letters in another Unicode form are the same password.
    expect(await verifyPagePassword('секрет-1'.normalize('NFD'), hash)).toBe(true)
  })

  it('never matches a hash of another form or other parameters', async () => {
    const hash = await hashPagePassword('пароль')
    expect(await verifyPagePassword('пароль', hash.replace('scrypt$15$', 'scrypt$20$'))).toBe(false)
    expect(await verifyPagePassword('пароль', hash.replace('$8$1$', '$16$1$'))).toBe(false)
    expect(await verifyPagePassword('пароль', 'пароль')).toBe(false)
    expect(await verifyPagePassword('x'.repeat(pageLimits.passwordMaxChars + 1), hash)).toBe(false)
  })

  it('bounds a password', async () => {
    expect(pagePasswordProblem('abc')).toBe('too_short')
    expect(pagePasswordProblem('a'.repeat(pageLimits.passwordMaxChars + 1))).toBe('too_long')
    expect(pagePasswordProblem('абвг')).toBeNull()
    await expect(hashPagePassword('abc')).rejects.toThrow()
  })
})

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: the attempts of a window', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'page_passwords')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  it('admits the limit, refuses the next and opens again after the window', async () => {
    const window = { key: `page-password:${crypto.randomUUID()}`, limit: 2, windowMs: 1000 }
    expect(await admitInWindow(db, { ...window, now: 0 })).toBe(true)
    expect(await admitInWindow(db, { ...window, now: 10 })).toBe(true)
    expect(await admitInWindow(db, { ...window, now: 20 })).toBe(false)
    expect(await admitInWindow(db, { ...window, now: 1000 })).toBe(true)
  })

  it('does not let parallel attempts pass the limit together', async () => {
    const window = {
      key: `page-password:${crypto.randomUUID()}`,
      limit: 3,
      windowMs: 60_000,
      now: 0,
    }
    const admitted = await Promise.all(Array.from({ length: 8 }, () => admitInWindow(db, window)))
    expect(admitted.filter(Boolean)).toHaveLength(3)
  })
})
