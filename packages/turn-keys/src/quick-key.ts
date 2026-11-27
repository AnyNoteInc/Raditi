import type { PrismaClient } from '@repo/db'
import { isDomainError, llmGatewayUnavailable } from '@repo/domain'

import { gatewayTransaction } from './call-ledger.ts'
import { newTurnKeys } from './turn-key.ts'

// The key of one quick edit of an artifact (docs/plan/98-quick-edits.md, БПр4): core issues it
// for one or two model calls of its own and holds its value in memory only; `llm_keys` keeps the
// hash. No Vault, no lease of a turn, so its revocation is a single transaction.

/** How long a quick key is valid: the edit's own limit of 25 s and room for a slow commit. */
export const QUICK_KEY_TTL_MS = 90_000

/** The session label of a quick key: no sandbox session, one label per edit. */
export const quickKeySession = (quickEditId: string): string => `quick-${quickEditId}`

/** A new value of a quick key, of the same form as a turn's (so the same filters catch it). */
export const newQuickKey = (): string => newTurnKeys().llmApiKey

/**
 * Closes a quick key: no new call is admitted, and its accounting closes at once when no call of
 * it is open (else the collector of the call ledger closes it after the last one). Any failure
 * but a domain refusal is an unavailable gateway.
 */
export async function revokeQuickKey(
  prisma: Pick<PrismaClient, '$transaction'>,
  keyId: string,
): Promise<void> {
  try {
    await gatewayTransaction(prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM llm_keys WHERE id = ${keyId}::uuid FOR UPDATE`
      await tx.$executeRaw`
        UPDATE llm_keys k SET
          revoke_requested_at = coalesce(k.revoke_requested_at, clock_timestamp()),
          revoked_at = coalesce(k.revoked_at, clock_timestamp()),
          usage_closed_at = CASE WHEN NOT EXISTS
            (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open')
            THEN coalesce(k.usage_closed_at, clock_timestamp()) ELSE k.usage_closed_at END
        WHERE k.id = ${keyId}::uuid`
    })
  } catch (error) {
    if (isDomainError(error)) throw error
    throw llmGatewayUnavailable()
  }
}

/** Whether the accounting of a key is closed: its calls are all settled. */
export async function quickKeyClosed(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  keyId: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ closed: boolean }[]>`
    SELECT usage_closed_at IS NOT NULL AS closed FROM llm_keys WHERE id = ${keyId}::uuid`
  return rows[0]?.closed === true
}
