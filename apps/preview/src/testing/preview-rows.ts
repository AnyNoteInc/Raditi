// What the PostgreSQL suites of the preview app write to a disposable database: two users, a
// workspace of the first with an active site, previews of the site and their tickets; remove()
// deletes all of it. Only for *.test.ts files.
import { randomBytes, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'

import { previewTicketHash } from '../cookie/preview-cookie.ts'

export interface TicketOptions {
  kind?: 'user' | 'browser'
  /** Of a ticket of kind user; the owner's unless named. */
  userId?: string | null
  /** Milliseconds from now; a minute unless named. */
  expiresIn?: number
}

export interface PreviewRows {
  /** The owner of the workspace: a member. */
  owner: string
  /** A user of no workspace. */
  stranger: string
  workspaceId: string
  siteId: string
  /** A ready preview of the site on a task of its own; its upstream 127.0.0.1:1 answers nothing. */
  preview(): Promise<{ id: string; hostname: string }>
  /** A one-time ticket of the preview, as the cabinet issues one. */
  ticket(previewId: string, options?: TicketOptions): Promise<string>
  remove(): Promise<void>
}

export async function writePreviewRows(db: PrismaClient): Promise<PreviewRows> {
  const created = { users: [] as string[], workspaces: [] as string[], sites: [] as string[] }

  async function user(): Promise<string> {
    const row = await db.user.create({
      data: { name: 'Предпросмотр', email: `preview-${randomUUID()}@example.test` },
    })
    created.users.push(row.id)
    return row.id
  }

  const owner = await user()
  const stranger = await user()
  const workspace = await db.workspace.create({
    data: { name: 'Предпросмотры', dataClass: 'synthetic', createdById: owner },
  })
  const workspaceId = workspace.id
  created.workspaces.push(workspace.id)
  await db.member.create({ data: { workspaceId, userId: owner, role: 'owner' } })
  const site = await db.site.create({
    data: {
      workspaceId,
      name: 'Сайт',
      url: `https://${randomUUID()}.example.test`,
      stack: 'wordpress',
      status: 'active',
    },
  })
  const siteId = site.id
  created.sites.push(site.id)

  return {
    owner,
    stranger,
    workspaceId,
    siteId,

    async preview() {
      const task = await db.task.create({ data: { workspaceId, siteId } })
      const row = await db.previewEnvironment.create({
        data: {
          siteId,
          taskId: task.id,
          status: 'ready',
          hostname: `site-${site.alias}-chat-${task.alias}.localhost`,
          upstreamHost: '127.0.0.1',
          upstreamPort: 1,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      return { id: row.id, hostname: row.hostname }
    },

    async ticket(previewId, options = {}) {
      const token = randomBytes(32).toString('base64url')
      const kind = options.kind ?? 'user'
      await db.previewTicket.create({
        data: {
          previewId,
          kind,
          userId: kind === 'user' ? (options.userId ?? owner) : null,
          tokenHash: previewTicketHash(token),
          expiresAt: new Date(Date.now() + (options.expiresIn ?? 60_000)),
        },
      })
      return token
    },

    async remove() {
      await db.previewEnvironment.deleteMany({ where: { siteId: { in: created.sites } } })
      await db.task.deleteMany({ where: { siteId: { in: created.sites } } })
      await db.site.deleteMany({ where: { id: { in: created.sites } } })
      await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } })
      await db.user.deleteMany({ where: { id: { in: created.users } } })
    },
  }
}
