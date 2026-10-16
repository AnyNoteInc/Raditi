import type { Prisma } from '@repo/db'
import { z } from 'zod'

/** Who acts on billing: a signed-in user, the platform itself (the scheduler) or an operator. */
export const billingAuditActorTypes = ['user', 'system', 'operator'] as const

/**
 * What a billing action is about. A `credit_rate` is a row of `credit_rates`: it belongs to the
 * platform, not to a workspace. A `task` is the task a charge is for: its credits may come from
 * several accounts, so the charge is about the task and not about one of them.
 */
export const billingAuditTargetTypes = [
  'subscription',
  'order',
  'billing_account',
  'credit_rate',
  'task',
] as const

// Flat and JSON-safe. Money is written as the string of its Decimal, "12900.00": a number is
// accepted only when it is a whole count (credits, days), and a Decimal object not at all.
const metaValueSchema = z.union([z.string().max(500), z.number().int(), z.boolean(), z.null()])

const actorOf = <const T extends readonly (typeof billingAuditActorTypes)[number][]>(types: T) =>
  z.strictObject({
    type: z.enum(types),
    /** The user's id, the service name or the operator's name. */
    id: z.string().min(1).max(128),
  })

const what = {
  /** A dotted verb in the billing namespace: `billing.auto_renewal.cancel`. */
  action: z
    .string()
    .max(128)
    .regex(/^billing(?:\.[a-z][a-z0-9_]*)+$/),
  target: z
    .strictObject({ type: z.enum(billingAuditTargetTypes), id: z.string().min(1).max(128) })
    .optional(),
  meta: z.record(z.string().min(1).max(64), metaValueSchema).optional(),
  /** The address the request came from; absent for the scheduler. */
  ip: z.union([z.ipv4(), z.ipv6()]).optional(),
}

const entrySchema = z.union([
  z.strictObject({ actor: actorOf(billingAuditActorTypes), workspaceId: z.uuid(), ...what }),
  // Only an operator acts on what belongs to the platform and to no workspace — the credit
  // rate —, and then names none: audit_log.workspace_id is nullable for this.
  z.strictObject({ actor: actorOf(['operator']), workspaceId: z.undefined().optional(), ...what }),
])

export type BillingAuditEntry = z.infer<typeof entrySchema>

/**
 * Writes one row of audit_log: who did what to which billing object and when, with the amounts
 * as strings. Call it with the transaction client of the change it describes, so the row
 * exists exactly when the change does.
 */
export async function writeBillingAudit(
  tx: Pick<Prisma.TransactionClient, 'auditLog'>,
  entry: BillingAuditEntry,
): Promise<void> {
  const { actor, workspaceId, action, target, meta, ip } = entrySchema.parse(entry)
  await tx.auditLog.create({
    data: {
      actorType: actor.type,
      actorId: actor.id,
      workspaceId,
      action,
      targetType: target?.type,
      targetId: target?.id,
      meta,
      ip,
    },
  })
}
