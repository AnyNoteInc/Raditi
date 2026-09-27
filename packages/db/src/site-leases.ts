import {
  badRequest,
  siteLeaseOperations,
  type SiteLeaseAuthority,
  type SiteLeaseFence,
  type SiteLeaseGrant,
  type SiteLeaseStore,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'

type LeaseDatabase = Pick<Prisma.TransactionClient, '$queryRaw'>
const id = z.uuid()
const fenceSchema = z.object({
  siteId: id,
  taskId: id,
  operation: z.enum(siteLeaseOperations),
  epoch: z.number().int().positive().max(2_147_483_647),
})
const ttlSchema = z
  .number()
  .int()
  .min(1_000)
  .max(30 * 60_000)
const rowsSchema = z.array(
  z.object({
    site_id: id,
    holder_task_id: id.nullable(),
    operation: z.enum(siteLeaseOperations).nullable(),
    epoch: z.number().int().nonnegative(),
    expires_at: z.coerce.date().nullable(),
    server_now: z.coerce.date(),
    held_for_operator: z.boolean(),
  }),
)

function authority(raw: unknown): SiteLeaseAuthority | null {
  const row = rowsSchema.parse(raw)[0]
  return row
    ? {
        siteId: row.site_id,
        taskId: row.holder_task_id,
        operation: row.operation,
        epoch: row.epoch,
        expiresAt: row.expires_at,
        serverNow: row.server_now,
        heldForOperator: row.held_for_operator,
      }
    : null
}

function grant(raw: unknown): SiteLeaseGrant | null {
  const row = authority(raw)
  if (!row) return null
  if (!row.taskId || !row.operation || !row.expiresAt || row.heldForOperator) {
    throw badRequest('Invalid lease grant returned by the database')
  }
  return {
    siteId: row.siteId,
    taskId: row.taskId,
    operation: row.operation,
    epoch: row.epoch,
    expiresAt: row.expiresAt,
    serverNow: row.serverNow,
  }
}

/** Durable site serialization. No JS wall clock participates in ownership decisions. */
export class PostgresSiteLeaseStore implements SiteLeaseStore {
  private readonly db: LeaseDatabase

  constructor(db: LeaseDatabase) {
    this.db = db
  }

  async acquire(
    input: Omit<SiteLeaseFence, 'epoch'> & { ttlMs: number },
  ): Promise<SiteLeaseGrant | null> {
    const parsed = fenceSchema.omit({ epoch: true }).extend({ ttlMs: ttlSchema }).parse(input)
    // The task/site match is checked here, not left to two independent foreign keys.
    return grant(
      await this.db.$queryRaw`
      WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS instant)
      INSERT INTO site_leases
        (site_id, holder_task_id, operation, epoch, acquired_at, expires_at, held_for_operator, updated_at)
      SELECT ${parsed.siteId}::uuid, t.id, ${parsed.operation}::"LeaseOperation", 1,
        c.instant, c.instant + ${parsed.ttlMs}::int * interval '1 millisecond', false, c.instant
      FROM tasks t CROSS JOIN lease_clock c
      WHERE t.id = ${parsed.taskId}::uuid AND t.site_id = ${parsed.siteId}::uuid
      ON CONFLICT (site_id) DO UPDATE SET
        holder_task_id = EXCLUDED.holder_task_id, operation = EXCLUDED.operation,
        epoch = site_leases.epoch + 1, acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at, held_for_operator = false, updated_at = EXCLUDED.updated_at
      WHERE NOT site_leases.held_for_operator
        AND (site_leases.holder_task_id IS NULL OR site_leases.expires_at <= (SELECT instant FROM lease_clock))
        AND site_leases.epoch < 2147483647
      RETURNING site_id, holder_task_id, operation, epoch, expires_at, held_for_operator,
        (SELECT instant FROM lease_clock) AS server_now`,
    )
  }

  /**
   * Not called by turns: their single grant covers the whole operation. Long deploy/revert
   * operations (P12, up to 45 minutes) will renew here instead of taking a longer first TTL.
   */
  async renew(input: SiteLeaseFence, ttlMs: number): Promise<SiteLeaseGrant | null> {
    const f = fenceSchema.parse(input)
    const ttl = ttlSchema.parse(ttlMs)
    return grant(
      await this.db.$queryRaw`
      WITH locked AS MATERIALIZED (
        SELECT site_id FROM site_leases
        WHERE site_id = ${f.siteId}::uuid AND holder_task_id = ${f.taskId}::uuid
          AND epoch = ${f.epoch} AND operation = ${f.operation}::"LeaseOperation"
        FOR UPDATE
      )
      UPDATE site_leases l SET
        expires_at = clock_timestamp() + ${ttl}::int * interval '1 millisecond',
        updated_at = clock_timestamp()
      FROM locked WHERE l.site_id = locked.site_id
        AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
      RETURNING l.site_id, l.holder_task_id, l.operation, l.epoch, l.expires_at, l.held_for_operator,
        clock_timestamp() AS server_now`,
    )
  }

  async assert(input: SiteLeaseFence): Promise<boolean> {
    const f = fenceSchema.parse(input)
    const rows = z.array(z.object({ valid: z.boolean() })).parse(
      await this.db.$queryRaw`
      SELECT EXISTS(SELECT 1 FROM site_leases
        WHERE site_id = ${f.siteId}::uuid AND holder_task_id = ${f.taskId}::uuid
          AND epoch = ${f.epoch} AND operation = ${f.operation}::"LeaseOperation"
          AND NOT held_for_operator AND expires_at > clock_timestamp()) AS valid`,
    )
    return rows[0]?.valid === true
  }

  async release(input: SiteLeaseFence): Promise<boolean> {
    const f = fenceSchema.parse(input)
    const rows = await this.db.$queryRaw<Array<{ site_id: string }>>`
      UPDATE site_leases SET holder_task_id = NULL, operation = NULL, acquired_at = NULL,
        expires_at = NULL, updated_at = clock_timestamp()
      WHERE site_id = ${f.siteId}::uuid AND holder_task_id = ${f.taskId}::uuid
        AND epoch = ${f.epoch} AND operation = ${f.operation}::"LeaseOperation"
        AND NOT held_for_operator AND expires_at > clock_timestamp()
      RETURNING site_id`
    return rows.length === 1
  }

  async inspect(siteId: string): Promise<SiteLeaseAuthority | null> {
    const checked = id.parse(siteId)
    return authority(
      await this.db.$queryRaw`
      SELECT site_id, holder_task_id, operation, epoch, expires_at, held_for_operator,
        clock_timestamp() AS server_now FROM site_leases WHERE site_id = ${checked}::uuid`,
    )
  }

  async holdForRecovery(input: SiteLeaseFence): Promise<boolean> {
    const f = fenceSchema.parse(input)
    // Even after expiry, preserve ambiguity if no newer owner has acquired the site.
    const rows = await this.db.$queryRaw<Array<{ site_id: string }>>`
      UPDATE site_leases SET held_for_operator = true, updated_at = clock_timestamp()
      WHERE site_id = ${f.siteId}::uuid AND holder_task_id = ${f.taskId}::uuid
        AND epoch = ${f.epoch} AND operation = ${f.operation}::"LeaseOperation"
      RETURNING site_id`
    return rows.length === 1
  }

  async reclaimForRecovery(input: SiteLeaseFence, ttlMs: number): Promise<SiteLeaseGrant | null> {
    const f = fenceSchema.parse(input)
    const ttl = ttlSchema.parse(ttlMs)
    return grant(
      await this.db.$queryRaw`
      WITH held AS MATERIALIZED (
        SELECT site_id FROM site_leases
        WHERE site_id = ${f.siteId}::uuid AND holder_task_id = ${f.taskId}::uuid
          AND epoch = ${f.epoch} AND operation = ${f.operation}::"LeaseOperation"
          AND held_for_operator AND epoch < 2147483647
        FOR UPDATE
      )
      UPDATE site_leases l SET epoch = l.epoch + 1, held_for_operator = false,
        acquired_at = clock_timestamp(), updated_at = clock_timestamp(),
        expires_at = clock_timestamp() + ${ttl}::int * interval '1 millisecond'
      FROM held WHERE l.site_id = held.site_id
      RETURNING l.site_id, l.holder_task_id, l.operation, l.epoch, l.expires_at, l.held_for_operator,
        clock_timestamp() AS server_now`,
    )
  }
}
