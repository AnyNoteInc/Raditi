import { ensurePersonalWorkspace, type PersonalWorkspaceOwner } from '@repo/db'

import type { BillingTx } from './accounts.ts'
import { grantSignupGift } from './ledger.ts'

/**
 * The user's personal workspace with the gift of the registration asked for: the workspace
 * `ensurePersonalWorkspace` of @repo/db finds or makes, then `grantSignupGift` for it. What a
 * transaction that may make the personal workspace calls instead of `ensurePersonalWorkspace` —
 * the first site (`project.create`) and the first payment (`startCheckout`) —, so a workspace
 * the product makes never stands without its gift.
 *
 * The gift is granted once per user, and the call is made whether or not the workspace is new:
 * a repeated call changes nothing, and a workspace that was made before the gift existed gets
 * it at the next site or checkout that commits — the gift is written by the caller's
 * transaction and is taken back with it. A user whose gift stands on another workspace of
 * theirs gets none here.
 *
 * Takes the lock of the user's row, as `ensurePersonalWorkspace` does, so concurrent callers of
 * one user end in one workspace with one gift; the transaction must be READ COMMITTED. Throws
 * UNAUTHORIZED when the user no longer exists.
 */
export async function ensurePersonalWorkspaceWithGift(
  tx: BillingTx,
  owner: PersonalWorkspaceOwner,
): Promise<{ id: string }> {
  const workspace = await ensurePersonalWorkspace(tx, owner)
  await grantSignupGift(tx, { userId: owner.userId, workspaceId: workspace.id })
  return workspace
}
