import { findPersonalWorkspace } from '@repo/db'
import {
  billingNoLiveSubscription,
  billingNothingToChange,
  conflict,
  isLiveSubscription,
  liveSubscriptionStatuses,
  type SubscriptionStatus,
} from '@repo/domain'
import { z } from 'zod'

import type { BillingTx } from './accounts.ts'
import { writeBillingAudit } from './audit.ts'
import type { BillingDeps } from './deps.ts'
import type { RenewalChargeState } from './dto.ts'
import { operatorActionSchema } from './refund.ts'
import { renewalChargeUnderWay } from './renewal-order.ts'

// Auto-renewal switched off on somebody's word. The offer lets a customer ask for it by letter:
// an operator then does here what the customer would do on «Тарифы». The saved payment method
// stays, so the customer can switch auto-renewal back on; the tariff works to the end of its
// period and is not charged again — except by a renewal charge that was started before the
// switch: that one is neither stopped nor returned, and the operator is told where it stands.

/** audit_log actions of auto-renewal switched off by a person; the target is the subscription. */
export const autoRenewalAuditActions = {
  /** An operator switched auto-renewal off at the customer's request. */
  operatorStop: 'billing.auto_renewal.operator_stop',
} as const

/**
 * Fixed refusals of `stopAutoRenewalByOperator` the operator can act on: the message of a
 * CONFLICT. The command shows each of them in Russian.
 */
export const stopRenewalRefusals = {
  /** Nobody is registered with this address. */
  userNotFound: 'No user has this email',
  /** More than one user has the address when the case of its letters is ignored. */
  userAmbiguous: 'More than one user has this email',
} as const

/** A subscription whose auto-renewal has just been switched off. */
export interface AutoRenewalSwitchedOff {
  subscriptionId: string
  workspaceId: string
  status: SubscriptionStatus
  /** The tariff works until this moment and is not charged again. */
  periodEnd: Date
  /** The method stays saved: with it auto-renewal can be switched on again. */
  paymentMethodSaved: boolean
}

/** What an operator's stop did, and what the operator has to know to answer the customer. */
export interface OperatorAutoRenewalStop extends AutoRenewalSwitchedOff {
  /**
   * Where the renewal charge of the current period stood when auto-renewal was switched off
   * (`renewalChargeUnderWay`): `at_bank` — it still renews the tariff if it succeeds;
   * `unanswered` — nobody knows yet whether it was made, and it is not repeated.
   */
  renewalCharge: RenewalChargeState
  /**
   * The address of the user the operator's one matched, as the database holds it; null when
   * the customer was named by the workspace.
   */
  userEmail: string | null
}

interface LockedSubscription {
  id: string
  workspaceId: string
  status: SubscriptionStatus
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  paymentMethodId: string | null
}

/**
 * Switches auto-renewal of a live subscription off, in the caller's transaction: the row is
 * locked, `cancel_at_period_end` becomes true and `cancelled_at` the moment of the switch.
 * Nothing else changes — the saved method, a binding under way and the notice mark stay; a
 * tariff that does not renew is neither announced nor charged. The caller writes its own
 * audit entry in the same transaction. The one update both the operator's command and the
 * customer's «Отключить автопродление» make.
 *
 * Throws BILLING_NO_LIVE_SUBSCRIPTION when the subscription is gone or over, and
 * BILLING_NOTHING_TO_CHANGE when auto-renewal is already off.
 */
export async function switchAutoRenewalOff(
  tx: Pick<BillingTx, '$queryRaw' | 'subscription'>,
  input: { subscriptionId: string; now: Date },
): Promise<AutoRenewalSwitchedOff> {
  const [subscription] = await tx.$queryRaw<LockedSubscription[]>`
    SELECT id, workspace_id AS "workspaceId", status::text AS status,
      current_period_end AS "currentPeriodEnd", cancel_at_period_end AS "cancelAtPeriodEnd",
      payment_method_id AS "paymentMethodId"
    FROM subscriptions WHERE id = ${input.subscriptionId}::uuid
    FOR NO KEY UPDATE
  `
  if (subscription === undefined || !isLiveSubscription(subscription.status)) {
    throw billingNoLiveSubscription()
  }
  if (subscription.cancelAtPeriodEnd) throw billingNothingToChange()
  await tx.subscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: true, cancelledAt: input.now },
  })
  return {
    subscriptionId: subscription.id,
    workspaceId: subscription.workspaceId,
    status: subscription.status,
    periodEnd: subscription.currentPeriodEnd,
    paymentMethodSaved: subscription.paymentMethodId !== null,
  }
}

const stopInputSchema = z
  .strictObject({
    /** The workspace whose tariff it is. */
    workspaceId: z.uuid().optional(),
    /** Or the address of its owner: the tariff of their personal workspace. */
    userEmail: z.email().max(255).optional(),
    ...operatorActionSchema.shape,
  })
  .refine((input) => (input.workspaceId === undefined) !== (input.userEmail === undefined), {
    message: 'Name the workspace or the email of its owner, one of the two',
  })
export type StopAutoRenewalInput = z.input<typeof stopInputSchema>

/**
 * Switches auto-renewal of a customer's tariff off on an operator's decision — the same effect
 * as the customer's own switch, with an audit entry that names the operator and the reason.
 * The customer is named by the workspace or by the email of the user whose personal workspace
 * it is. The address is compared for equality, without the case of its letters — never as a
 * pattern: `_` and `%` in it are ordinary characters. The answer carries the address that
 * matched and where a renewal charge that was started before stands; that charge is not
 * stopped (as after the customer's own switch, `cancelAutoRenew`).
 *
 * Refused with a CONFLICT whose message is one of `stopRenewalRefusals`, with
 * BILLING_NO_LIVE_SUBSCRIPTION (no workspace, or no tariff in trial, active or past_due) and
 * with BILLING_NOTHING_TO_CHANGE (auto-renewal is already off). A refusal changes nothing.
 */
export async function stopAutoRenewalByOperator(
  deps: Pick<BillingDeps, 'prisma' | 'appEnv' | 'now'>,
  input: StopAutoRenewalInput,
): Promise<OperatorAutoRenewalStop> {
  const request = stopInputSchema.parse(input)
  const { prisma, appEnv } = deps

  let workspaceId = request.workspaceId ?? null
  let userEmail: string | null = null
  if (request.userEmail !== undefined) {
    // Equality in SQL: Prisma's case-insensitive `equals` is ILIKE, which reads `_` and `%` of
    // the address as wildcards and would stop the auto-renewal of a look-alike address.
    const users = await prisma.$queryRaw<{ id: string; email: string }[]>`
      SELECT id, email FROM users WHERE lower(email) = lower(${request.userEmail})
      ORDER BY id LIMIT 2
    `
    const [user, ...others] = users
    if (user === undefined) throw conflict(stopRenewalRefusals.userNotFound)
    if (others.length > 0) throw conflict(stopRenewalRefusals.userAmbiguous)
    userEmail = user.email
    workspaceId = (await findPersonalWorkspace(prisma, { userId: user.id, appEnv }))?.id ?? null
  }
  if (workspaceId === null) throw billingNoLiveSubscription()
  // The status belongs to the key: the unique index on workspace_id covers live rows only.
  const found = await prisma.subscription.findFirst({
    where: { workspaceId, status: { in: [...liveSubscriptionStatuses] } },
    select: { id: true },
  })
  if (found === null) throw billingNoLiveSubscription()
  const now = deps.now?.() ?? new Date()

  return prisma.$transaction(
    async (tx) => {
      const stopped = await switchAutoRenewalOff(tx, { subscriptionId: found.id, now })
      // Under the lock the switch took, every charge that was started is seen.
      const renewalCharge = await renewalChargeUnderWay(tx, {
        id: stopped.subscriptionId,
        currentPeriodEnd: stopped.periodEnd,
      })
      await writeBillingAudit(tx, {
        actor: { type: 'operator', id: request.operator },
        workspaceId: stopped.workspaceId,
        action: autoRenewalAuditActions.operatorStop,
        target: { type: 'subscription', id: stopped.subscriptionId },
        meta: {
          reason: request.reason,
          // How the operator named the customer: the address itself is not kept here.
          namedBy: request.userEmail === undefined ? 'workspace' : 'email',
          status: stopped.status,
          periodEnd: stopped.periodEnd.toISOString(),
          paymentMethodSaved: stopped.paymentMethodSaved,
          renewalCharge,
        },
      })
      return { ...stopped, renewalCharge, userEmail }
    },
    { isolationLevel: 'ReadCommitted' },
  )
}
