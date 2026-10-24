import { createHash, randomUUID } from 'node:crypto'

import { browserStreamTicketSchema } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import { closeBrowserSession, openBrowserSession } from './browser-sessions.ts'
import {
  browserViewerAllowed,
  consumeBrowserStreamTicket,
  issueBrowserStreamTicket,
} from './browser-stream-tickets.ts'
import type { PrismaClient } from './generated/prisma/client.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: tickets of the stream of a task’s browser', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'browser_tickets')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  const person = () =>
    db.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test` } })

  /** A member, a stranger and the open session of a browser task of the member's site. */
  async function watched() {
    const [member, stranger] = [await person(), await person()]
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic' },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: member.id } })
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Synthetic',
        url: `https://${randomUUID()}.example.test`,
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        needsRepository: false,
        needsBrowser: true,
      },
    })
    const session = await openBrowserSession(db, { taskId: task.id })
    return { member, stranger, workspace, site, task, session }
  }

  it('gives a member a ticket the database keeps only as a hash, spent once', async () => {
    const w = await watched()
    const viewer = { sessionId: w.session.id, userId: w.member.id }
    expect(await browserViewerAllowed(db, viewer)).toBe(true)

    const issued = (await issueBrowserStreamTicket(db, viewer))!
    expect(browserStreamTicketSchema.safeParse(issued.ticket).success).toBe(true)
    const [row] = await db.browserStreamTicket.findMany({ where: { sessionId: w.session.id } })
    expect(row).toMatchObject({
      userId: w.member.id,
      tokenHash: createHash('sha256').update(issued.ticket).digest('hex'),
      usedAt: null,
      expiresAt: issued.expiresAt,
    })
    expect(JSON.stringify(row)).not.toContain(issued.ticket)
    const lifetime = (issued.expiresAt.getTime() - row!.createdAt.getTime()) / 1000
    expect(lifetime).toBeGreaterThan(55)
    expect(lifetime).toBeLessThan(65)

    expect(await consumeBrowserStreamTicket(db, issued.ticket)).toEqual({
      sessionId: w.session.id,
      userId: w.member.id,
      taskId: w.task.id,
    })
    expect(await consumeBrowserStreamTicket(db, issued.ticket)).toBeNull()
    for (const wrong of ['', 'x'.repeat(43), `${issued.ticket}=`, issued.ticket.toUpperCase()])
      expect(await consumeBrowserStreamTicket(db, wrong)).toBeNull()
  })

  it('opens one connection for two at once with the same ticket', async () => {
    const w = await watched()
    const { ticket } = (await issueBrowserStreamTicket(db, {
      sessionId: w.session.id,
      userId: w.member.id,
    }))!
    const spent = await Promise.all([
      consumeBrowserStreamTicket(db, ticket),
      consumeBrowserStreamTicket(db, ticket),
    ])
    expect(spent.filter(Boolean)).toHaveLength(1)
  })

  it('refuses a ticket after its minute', async () => {
    const w = await watched()
    const { ticket } = (await issueBrowserStreamTicket(db, {
      sessionId: w.session.id,
      userId: w.member.id,
    }))!
    await db.$executeRaw`UPDATE browser_stream_tickets
      SET created_at = clock_timestamp() - interval '2 minutes',
          expires_at = clock_timestamp() - interval '1 minute'
      WHERE session_id = ${w.session.id}::uuid`
    expect(await consumeBrowserStreamTicket(db, ticket)).toBeNull()
  })

  it('lets only a member of the task’s workspace watch an open session of a site not closed', async () => {
    const w = await watched()
    const stranger = { sessionId: w.session.id, userId: w.stranger.id }
    expect(await browserViewerAllowed(db, stranger)).toBe(false)
    expect(await issueBrowserStreamTicket(db, stranger)).toBeNull()
    expect(await browserViewerAllowed(db, { sessionId: randomUUID(), userId: w.member.id })).toBe(
      false,
    )

    const member = { sessionId: w.session.id, userId: w.member.id }
    await db.site.update({ where: { id: w.site.id }, data: { status: 'paused' } })
    expect(await browserViewerAllowed(db, member)).toBe(false)
    expect(await issueBrowserStreamTicket(db, member)).toBeNull()
    await db.site.update({ where: { id: w.site.id }, data: { status: 'active' } })
    expect(await browserViewerAllowed(db, member)).toBe(true)

    // Past its hard deadline a session is not watched, even before the collector closes it.
    await db.$executeRaw`UPDATE browser_sessions
      SET created_at = clock_timestamp() - interval '5 hours',
          expires_at = clock_timestamp() - interval '1 hour'
      WHERE id = ${w.session.id}::uuid`
    expect(await browserViewerAllowed(db, member)).toBe(false)
    await db.$executeRaw`UPDATE browser_sessions
      SET expires_at = clock_timestamp() + interval '1 hour' WHERE id = ${w.session.id}::uuid`
    expect(await browserViewerAllowed(db, member)).toBe(true)

    await db.member.deleteMany({ where: { workspaceId: w.workspace.id, userId: w.member.id } })
    expect(await browserViewerAllowed(db, member)).toBe(false)
    await db.member.create({ data: { workspaceId: w.workspace.id, userId: w.member.id } })

    await closeBrowserSession(db, {
      sessionId: w.session.id,
      status: 'closed',
      reason: 'task_done',
    })
    expect(await browserViewerAllowed(db, member)).toBe(false)
    expect(await issueBrowserStreamTicket(db, member)).toBeNull()
    await expect(
      browserViewerAllowed(db, { sessionId: 'not-a-session', userId: w.member.id }),
    ).rejects.toThrow()
  })
})
