import { createHash, randomBytes } from 'node:crypto'

import { browserSessionTimings, browserStreamTicketSchema } from '@repo/domain'
import { z } from 'zod'

import { Prisma } from './generated/prisma/client.ts'
import { browserClosedSiteStatuses } from './browser-sessions.ts'
import { uuidv7 } from './uuidv7.ts'

// The way into the stream of a task's browser (docs/plan/57-browser-tasks.md, Б12): the cabinet
// asks for a ticket (`browser.streamTicket`), sends it as the first message of the WebSocket, and
// the gateway spends it once. The database keeps only its SHA-256; the gateway checks the viewer
// again at least every `recheckSeconds`.

type RawDb = Pick<Prisma.TransactionClient, '$queryRaw'>

const id = z.uuid()
const viewerSchema = z.strictObject({ sessionId: id, userId: id })

/** The column `browser_stream_tickets.token_hash`: SHA-256 of the ticket text, lower-case hex. */
const ticketHash = (ticket: string): string =>
  createHash('sha256').update(ticket, 'utf8').digest('hex')

/**
 * Who may watch and drive a session (Б12): it still holds a browser and its deadline has not
 * passed, the user is a member of the task's workspace, and the site is not closed.
 */
function viewerAllowed(sessionId: string, userId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM browser_sessions b
      JOIN tasks t ON t.id = b.task_id
      JOIN sites s ON s.id = b.site_id
      JOIN members m ON m.workspace_id = t.workspace_id AND m.user_id = ${userId}::uuid
     WHERE b.id = ${sessionId}::uuid
       AND b.status IN ('starting', 'ready') AND b.expires_at > clock_timestamp()
       AND s.status::text <> ALL (${[...browserClosedSiteStatuses]}::text[]))`
}

/** viewerAllowed() now: what the gateway asks after it spent a ticket, and at every recheck. */
export async function browserViewerAllowed(
  db: RawDb,
  input: { sessionId: string; userId: string },
): Promise<boolean> {
  const { sessionId, userId } = viewerSchema.parse(input)
  const [row] = await db.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT ${viewerAllowed(sessionId, userId)} AS allowed`
  return row?.allowed === true
}

export interface IssuedBrowserStreamTicket {
  /** 32 random bytes in base64url (43 characters): what the first message carries, never stored. */
  ticket: string
  expiresAt: Date
}

/**
 * A one-time ticket for the stream of a session, for a user who may watch it now: it lives
 * `ticketSeconds` (60) and opens one connection. null — the user may not watch this session.
 */
export async function issueBrowserStreamTicket(
  db: RawDb,
  input: { sessionId: string; userId: string },
): Promise<IssuedBrowserStreamTicket | null> {
  const { sessionId, userId } = viewerSchema.parse(input)
  const ticket = randomBytes(32).toString('base64url')
  const [row] = await db.$queryRaw<Array<{ expires_at: Date }>>`
    INSERT INTO browser_stream_tickets (id, session_id, user_id, token_hash, expires_at)
    SELECT ${uuidv7()}::uuid, ${sessionId}::uuid, ${userId}::uuid, ${ticketHash(ticket)},
           clock_timestamp() + ${browserSessionTimings.ticketSeconds}::int * interval '1 second'
     WHERE ${viewerAllowed(sessionId, userId)}
    RETURNING expires_at`
  return row ? { ticket, expiresAt: row.expires_at } : null
}

export interface SpentBrowserStreamTicket {
  sessionId: string
  userId: string
  taskId: string
}

/**
 * Spends a ticket in one statement: not used before, not expired. A second request with the same
 * ticket finds it used, whatever the first one ends with. The caller checks the viewer next
 * (browserViewerAllowed): the ticket says who, not that they still may.
 */
export async function consumeBrowserStreamTicket(
  db: RawDb,
  ticket: string,
): Promise<SpentBrowserStreamTicket | null> {
  if (!browserStreamTicketSchema.safeParse(ticket).success) return null
  const [row] = await db.$queryRaw<Array<{ session_id: string; user_id: string; task_id: string }>>`
    UPDATE browser_stream_tickets k SET used_at = clock_timestamp()
      FROM browser_sessions b
     WHERE k.token_hash = ${ticketHash(ticket)} AND k.used_at IS NULL
       AND k.expires_at > clock_timestamp() AND b.id = k.session_id
    RETURNING k.session_id, k.user_id, b.task_id`
  return row ? { sessionId: row.session_id, userId: row.user_id, taskId: row.task_id } : null
}
