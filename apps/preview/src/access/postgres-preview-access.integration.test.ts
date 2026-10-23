import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { previewCookieValue, previewTicketHash } from '../cookie/preview-cookie.ts'
import { writePreviewRows, type PreviewRows, type TicketOptions } from '../testing/preview-rows.ts'
import { PostgresPreviewAccess } from './postgres-preview-access.ts'
import { PREVIEW_SESSION_HOURS } from './preview-access.ts'

// Users, workspaces, sites and tasks of its own, removed at the end; run by verify:db's disposable
// database (or any throwaway one) with RADITI_GATEWAY_DB_TESTS=1.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('PostgresPreviewAccess', () => {
  let db: PrismaClient
  let access: PostgresPreviewAccess
  let rows: PreviewRows
  let owner: string
  let stranger: string
  let workspaceId: string
  let siteId: string
  let preview: { id: string; hostname: string }
  let other: { id: string; hostname: string }

  const ticket = (previewId: string, options?: TicketOptions) => rows.ticket(previewId, options)
  const enter = (previewId: string, token: string, kind: 'user' | 'browser' = 'user') =>
    access.enter({ previewId, tokenHash: previewTicketHash(token), kind })

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl! })
    access = new PostgresPreviewAccess(db)
    rows = await writePreviewRows(db)
    ;({ owner, stranger, workspaceId, siteId } = rows)
    preview = await rows.preview()
    other = await rows.preview()
  })

  beforeEach(async () => {
    await db.site.update({ where: { id: siteId }, data: { status: 'active' } })
    await db.member.upsert({
      where: { workspaceId_userId: { workspaceId, userId: owner } },
      create: { workspaceId, userId: owner, role: 'owner' },
      update: {},
    })
  })

  afterAll(async () => {
    if (!db) return
    await rows?.remove()
    await db.$disconnect()
  })

  it('finds a preview by its exact hostname only, never a destroyed one', async () => {
    const route = await access.route(preview.hostname)
    expect(route).toMatchObject({
      id: preview.id,
      siteId,
      hostname: preview.hostname,
      status: 'ready',
      revision: 0,
      accessEpoch: 0,
      upstream: { host: '127.0.0.1', port: 1 },
    })
    expect(await access.route(preview.hostname.toUpperCase())).toBeNull()
    expect(await access.route(`x${preview.hostname}`)).toBeNull()
    const gone = await rows.preview()
    await db.previewEnvironment.update({ where: { id: gone.id }, data: { status: 'destroyed' } })
    expect(await access.route(gone.hostname)).toBeNull()
  })

  it('spends a ticket once, even when it arrives several times at once', async () => {
    const token = await ticket(preview.id)
    const sessions = await Promise.all([1, 2, 3, 4, 5].map(() => enter(preview.id, token)))
    const opened = sessions.filter((session) => session !== null)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      previewId: preview.id,
      userId: owner,
      kind: 'user',
      accessEpoch: 0,
      revokedAt: null,
    })
    const hours = (opened[0]!.expiresAt.getTime() - opened[0]!.checkedAt!.getTime()) / 3_600_000
    expect(hours).toBe(PREVIEW_SESSION_HOURS)
    expect(await enter(preview.id, token)).toBeNull()
    const row = await db.previewTicket.findUniqueOrThrow({
      where: { tokenHash: previewTicketHash(token) },
    })
    expect(row.usedAt).not.toBeNull()
  })

  it('takes a ticket only for its own preview and kind, within its minute', async () => {
    const token = await ticket(preview.id)
    // Of another preview or as the browser's: not spent, still good where it belongs.
    expect(await enter(other.id, token)).toBeNull()
    expect(await enter(preview.id, token, 'browser')).toBeNull()
    expect(await enter(preview.id, token)).not.toBeNull()
    const late = await ticket(preview.id, { expiresIn: -1 })
    expect(await enter(preview.id, late)).toBeNull()
    const browser = await ticket(preview.id, { kind: 'browser' })
    expect(await enter(preview.id, browser, 'browser')).toMatchObject({
      kind: 'browser',
      userId: null,
    })
  })

  it('opens nothing for a stranger or a closed site, and the ticket stays spent', async () => {
    const foreign = await ticket(preview.id, { userId: stranger })
    expect(await enter(preview.id, foreign)).toBeNull()
    expect(
      (
        await db.previewTicket.findUniqueOrThrow({
          where: { tokenHash: previewTicketHash(foreign) },
        })
      ).usedAt,
    ).not.toBeNull()
    for (const status of ['paused', 'disconnected', 'archived'] as const) {
      await db.site.update({ where: { id: siteId }, data: { status } })
      expect(await enter(preview.id, await ticket(preview.id)), status).toBeNull()
    }
  })

  it('reads a session back with the expiry its cookie was signed with', async () => {
    const session = (await enter(preview.id, await ticket(preview.id)))!
    const read = (await access.session(session.id))!
    expect(read).toEqual(session)
    const secret = 'x'.repeat(48)
    expect(previewCookieValue(secret, read, preview.hostname)).toBe(
      previewCookieValue(secret, session, preview.hostname),
    )
    expect(await access.session(randomUUID())).toBeNull()
  })

  it('checks membership, the site and the access epoch again, and revokes for good', async () => {
    const session = (await enter(preview.id, await ticket(preview.id)))!
    const checked = await access.recheck(session.id)
    expect(checked?.checkedAt.getTime()).toBeGreaterThanOrEqual(session.checkedAt!.getTime())

    await db.member.delete({ where: { workspaceId_userId: { workspaceId, userId: owner } } })
    expect(await access.recheck(session.id)).toBeNull()
    expect((await access.session(session.id))?.revokedAt).not.toBeNull()
    await db.member.create({ data: { workspaceId, userId: owner, role: 'owner' } })
    expect(await access.recheck(session.id)).toBeNull()

    const archived = (await enter(preview.id, await ticket(preview.id)))!
    await db.site.update({ where: { id: siteId }, data: { status: 'archived' } })
    expect(await access.recheck(archived.id)).toBeNull()
    await db.site.update({ where: { id: siteId }, data: { status: 'active' } })

    const browser = (await enter(other.id, await ticket(other.id, { kind: 'browser' }), 'browser'))!
    expect(await access.recheck(browser.id)).not.toBeNull()
    await db.previewEnvironment.update({
      where: { id: other.id },
      data: { accessEpoch: { increment: 1 } },
    })
    expect(await access.recheck(browser.id)).toBeNull()
  })
})
