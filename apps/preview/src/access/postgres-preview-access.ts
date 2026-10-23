import { Inject, Injectable } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import {
  previewSessionKinds,
  previewStatuses,
  type PreviewSessionKind,
  type PreviewStatus,
} from '@repo/domain'
import { PRISMA } from '@repo/service-runtime/tokens'

import {
  CLOSED_SITE_STATUSES,
  PREVIEW_SESSION_HOURS,
  type EnterInput,
  type PreviewAccessStore,
  type PreviewRoute,
  type PreviewSessionRecord,
} from './preview-access.ts'

type Database = Pick<PrismaClient, '$queryRaw' | '$transaction'>

interface RouteRow {
  id: string
  site_id: string
  hostname: string
  status: string
  revision: number
  access_epoch: number
  upstream_host: string | null
  upstream_port: number | null
}

interface SessionRow {
  id: string
  preview_id: string
  user_id: string | null
  kind: string
  access_epoch: number
  expires_at: Date
  revoked_at: Date | null
  checked_at: Date | null
}

const isStatus = (value: string): value is PreviewStatus =>
  (previewStatuses as readonly string[]).includes(value)
const isKind = (value: string): value is PreviewSessionKind =>
  (previewSessionKinds as readonly string[]).includes(value)

function sessionRecord(row: SessionRow): PreviewSessionRecord | null {
  if (!isKind(row.kind)) return null
  return {
    id: row.id,
    previewId: row.preview_id,
    userId: row.user_id,
    kind: row.kind,
    accessEpoch: row.access_epoch,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    checkedAt: row.checked_at,
  }
}

const closedSites = CLOSED_SITE_STATUSES.join(',')

/**
 * The store of the gateway on PostgreSQL (preview_environments, preview_tickets,
 * preview_sessions, with the sites and members they check): the app's one client.
 */
@Injectable()
export class PostgresPreviewAccess implements PreviewAccessStore {
  private readonly db: Database

  constructor(@Inject(PRISMA) db: Database) {
    this.db = db
  }

  async route(hostname: string): Promise<PreviewRoute | null> {
    const [row] = await this.db.$queryRaw<RouteRow[]>`
      SELECT id, site_id, hostname, status::text AS status, revision, access_epoch,
             upstream_host, upstream_port
        FROM preview_environments
       WHERE hostname = ${hostname} AND status <> 'destroyed'`
    if (!row || !isStatus(row.status)) return null
    return {
      id: row.id,
      siteId: row.site_id,
      hostname: row.hostname,
      status: row.status,
      revision: row.revision,
      accessEpoch: row.access_epoch,
      upstream:
        row.upstream_host === null || row.upstream_port === null
          ? null
          : { host: row.upstream_host, port: row.upstream_port },
    }
  }

  async enter(input: EnterInput): Promise<PreviewSessionRecord | null> {
    return this.db.$transaction(async (tx) => {
      // Spent before anything else is looked at: a second request with the same ticket finds
      // it used, whatever the first one ends with.
      const [ticket] = await tx.$queryRaw<
        { user_id: string | null; kind: string; now: Date }[]
      >`UPDATE preview_tickets SET used_at = clock_timestamp()
         WHERE token_hash = ${input.tokenHash}
           AND preview_id = ${input.previewId}::uuid
           AND kind = ${input.kind}
           AND used_at IS NULL
           AND expires_at > clock_timestamp()
        RETURNING user_id, kind, clock_timestamp() AS now`
      if (!ticket || !isKind(ticket.kind)) return null
      const [preview] = await tx.$queryRaw<{ access_epoch: number }[]>`
        SELECT p.access_epoch
          FROM preview_environments p
          JOIN sites s ON s.id = p.site_id
         WHERE p.id = ${input.previewId}::uuid
           AND p.status <> 'destroyed'
           AND s.status::text <> ALL (string_to_array(${closedSites}, ','))
           AND (${ticket.kind} = 'browser' OR EXISTS (
                 SELECT 1 FROM members m
                  WHERE m.workspace_id = s.workspace_id AND m.user_id = ${ticket.user_id}::uuid))
         FOR SHARE OF p`
      if (!preview) return null
      // Milliseconds only: the cookie's MAC covers the expiry as the row gives it back.
      const expiresAt = new Date(ticket.now.getTime() + PREVIEW_SESSION_HOURS * 3_600_000)
      const created = await tx.previewSession.create({
        data: {
          previewId: input.previewId,
          userId: ticket.user_id,
          kind: ticket.kind,
          accessEpoch: preview.access_epoch,
          expiresAt,
          checkedAt: ticket.now,
        },
      })
      return {
        id: created.id,
        previewId: created.previewId,
        userId: created.userId,
        kind: ticket.kind,
        accessEpoch: created.accessEpoch,
        expiresAt: created.expiresAt,
        revokedAt: created.revokedAt,
        checkedAt: created.checkedAt,
      }
    })
  }

  async session(id: string): Promise<PreviewSessionRecord | null> {
    const [row] = await this.db.$queryRaw<SessionRow[]>`
      SELECT id, preview_id, user_id, kind, access_epoch, expires_at, revoked_at, checked_at
        FROM preview_sessions
       WHERE id = ${id}::uuid`
    return row ? sessionRecord(row) : null
  }

  async recheck(sessionId: string): Promise<{ checkedAt: Date } | null> {
    const [checked] = await this.db.$queryRaw<{ checked_at: Date }[]>`
      UPDATE preview_sessions ps SET checked_at = clock_timestamp()
        FROM preview_environments p
        JOIN sites s ON s.id = p.site_id
       WHERE ps.id = ${sessionId}::uuid
         AND p.id = ps.preview_id
         AND ps.revoked_at IS NULL
         AND ps.expires_at > clock_timestamp()
         AND ps.access_epoch = p.access_epoch
         AND p.status <> 'destroyed'
         AND s.status::text <> ALL (string_to_array(${closedSites}, ','))
         AND (ps.kind = 'browser' OR EXISTS (
               SELECT 1 FROM members m
                WHERE m.workspace_id = s.workspace_id AND m.user_id = ps.user_id))
      RETURNING ps.checked_at`
    if (checked) return { checkedAt: checked.checked_at }
    await this.db.$queryRaw`
      UPDATE preview_sessions SET revoked_at = clock_timestamp()
       WHERE id = ${sessionId}::uuid AND revoked_at IS NULL`
    return null
  }
}
