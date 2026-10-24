import { randomBytes } from 'node:crypto'
import { request } from 'node:http'

import { BROWSER_STREAM_PATH, type BrowserStreamStore } from '@repo/browser-link'
import type { PrismaClient } from '@repo/db'
import { afterEach, describe, expect, it } from 'vitest'

import { BrowserStreamListener, PostgresBrowserStreamStore } from './browser-stream.ts'

const TOKEN = 'worker-token-0123456789abcdef0123456789abcdef'
const sessionId = '0196abcd-0000-7000-8000-000000000001'
const userId = '0196abcd-0000-7000-8000-000000000005'
const taskId = '0196abcd-0000-7000-8000-000000000002'

/** A database whose every raw query answers `rows`, recording the values it was given. */
function rawDb(rows: unknown[]) {
  const values: unknown[][] = []
  const db = {
    $queryRaw: (_strings: TemplateStringsArray, ...given: unknown[]) => {
      values.push(given)
      return Promise.resolve(rows)
    },
  }
  return { db: db as unknown as Pick<PrismaClient, '$queryRaw'>, values }
}

describe('PostgresBrowserStreamStore', () => {
  it('spends a ticket into the session and the user it was issued for', async () => {
    const { db, values } = rawDb([{ session_id: sessionId, user_id: userId, task_id: taskId }])
    const store = new PostgresBrowserStreamStore(db)
    const ticket = randomBytes(32).toString('base64url')
    expect(await store.consumeTicket(ticket)).toEqual({ sessionId, userId })
    // The database is asked about the ticket's hash, never the ticket.
    expect(values.flat()).not.toContain(ticket)
  })

  it('answers null for a ticket the database does not know, and asks nothing for a malformed one', async () => {
    const { db, values } = rawDb([])
    const store = new PostgresBrowserStreamStore(db)
    expect(await store.consumeTicket(randomBytes(32).toString('base64url'))).toBeNull()
    expect(await store.consumeTicket('not a ticket')).toBeNull()
    expect(values).toHaveLength(1)
  })

  it('asks the database whether the user may still watch', async () => {
    const store = new PostgresBrowserStreamStore(rawDb([{ allowed: true }]).db)
    expect(await store.viewerAllowed({ sessionId, userId })).toBe(true)
    const refusing = new PostgresBrowserStreamStore(rawDb([{ allowed: false }]).db)
    expect(await refusing.viewerAllowed({ sessionId, userId })).toBe(false)
  })
})

/** The status of a WebSocket handshake on the stream path: 101, or the refusal's status. */
function handshake(port: number, origin: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port,
      path: BROWSER_STREAM_PATH,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...(origin === undefined ? {} : { origin }),
      },
    })
    outgoing.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve(101)
    })
    outgoing.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

describe('BrowserStreamListener', () => {
  let listener: BrowserStreamListener | undefined

  afterEach(async () => {
    await listener?.close()
    listener = undefined
  })

  it('opens a stream for exactly the origin of APP_URL and nothing else', async () => {
    const store: BrowserStreamStore = {
      consumeTicket: () => Promise.resolve(null),
      viewerAllowed: () => Promise.resolve(false),
    }
    listener = new BrowserStreamListener({
      config: {
        port: 0,
        host: '127.0.0.1',
        workerUrl: 'http://127.0.0.1:8086',
        workerToken: TOKEN,
      },
      appUrl: 'http://localhost:3000/cabinet',
      store,
    })
    const { port, address } = await listener.listen(0, '127.0.0.1')
    expect(address).toBe('127.0.0.1')
    expect(await handshake(port, 'http://localhost:3000')).toBe(101)
    expect(await handshake(port, 'http://localhost:3000/cabinet')).toBe(403)
    expect(await handshake(port, 'http://127.0.0.1:3000')).toBe(403)
    expect(await handshake(port, undefined)).toBe(403)
    expect((await fetch(`http://127.0.0.1:${port}/__raditi/health`)).status).toBe(404)
    await listener.close()
    expect(listener.address()).toBeNull()
  })
})
