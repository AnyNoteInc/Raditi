import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const databaseUrl = process.env.DATABASE_URL

// The migration runs only against a temporary legacy table in this connection.
// Both the temporary table and its changes disappear when the transaction rolls back.
describe.skipIf(!databaseUrl)('additive surname migration', () => {
  const db = new Client({ connectionString: databaseUrl })
  let connected = false
  const userId = randomUUID()

  beforeAll(async () => {
    await db.connect()
    connected = true
    await db.query('BEGIN')
    await db.query(`CREATE TEMP TABLE users (
      id UUID PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      image VARCHAR(1024)
    ) ON COMMIT DROP`)
    await db.query(
      `INSERT INTO users (id, name, email, image) VALUES ($1, 'Анна', 'legacy@example.ru', '/avatar/legacy')`,
      [userId],
    )
    await db.query(
      await readFile(
        new URL('./migrations/20260930140000_user_last_name/migration.sql', import.meta.url),
        'utf8',
      ),
    )
  })

  afterAll(async () => {
    if (!connected) return
    try {
      await db.query('ROLLBACK')
    } finally {
      await db.end()
    }
  })

  it('preserves an existing account and keeps the surname optional for older writers', async () => {
    expect((await db.query('SELECT * FROM users WHERE id = $1', [userId])).rows).toEqual([
      {
        id: userId,
        name: 'Анна',
        email: 'legacy@example.ru',
        image: '/avatar/legacy',
        last_name: null,
      },
    ])
    const created = await db.query(
      `INSERT INTO users (id, name, email) VALUES ($1, 'Мария', 'new@example.ru') RETURNING last_name`,
      [randomUUID()],
    )
    expect(created.rows).toEqual([{ last_name: null }])
    await db.query('UPDATE users SET last_name = $1 WHERE id = $2', ['Иванова', userId])
    expect((await db.query('SELECT last_name FROM users WHERE id = $1', [userId])).rows).toEqual([
      { last_name: 'Иванова' },
    ])
  })
})
