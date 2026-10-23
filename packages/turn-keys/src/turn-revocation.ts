import type { PrismaClient } from '@repo/db'
import {
  isDomainError,
  llmGatewayUnavailable,
  type SecretStore,
  type TurnCredentialRef,
} from '@repo/domain'

import { gatewayTransaction } from './call-ledger.ts'
import { turnCredentialPath, turnCredentialRefSchema } from './turn-key.ts'

export interface TurnRevocationContext {
  prisma: Pick<PrismaClient, '$transaction'>
  /** The capability of `turns/`: the value of the key is deleted, then every version destroyed. */
  secrets: Pick<SecretStore, 'kvDelete' | 'kvDestroyAll'>
}

/**
 * Closes the key of one turn: core when the turn ends or its sweeper finds the key, the llm
 * role's operator command when an account is retired in an emergency. The durable marker and
 * `revoke_requested_at` are taken under the lock of the site's lease; the accounting of the
 * key closes only once no call of it is open. Any failure but a domain refusal is an
 * unavailable gateway.
 */
export async function revokeTurnCredentials(
  context: TurnRevocationContext,
  input: TurnCredentialRef,
): Promise<void> {
  const ref = turnCredentialRefSchema.parse(input)
  try {
    // This is the admission fence. Vault failure cannot leave the key accepting new calls.
    await gatewayTransaction(context.prisma, async (tx) => {
      await tx.$queryRaw`SELECT l.site_id FROM site_leases l JOIN tasks t ON t.site_id = l.site_id
          WHERE t.id = ${ref.taskId}::uuid FOR UPDATE OF l`
      await tx.$executeRaw`
        WITH marker AS (
          INSERT INTO task_events (task_id, type, payload, client_visible)
          SELECT t.id, 'llm.revoke_requested', ${JSON.stringify({
            sessionId: ref.sessionId,
            turn: ref.turn,
            firstEpoch: ref.epoch,
          })}::jsonb, false
          FROM tasks t
          WHERE t.id = ${ref.taskId}::uuid AND NOT EXISTS (
            SELECT 1 FROM task_events e WHERE e.task_id = t.id
              AND e.type = 'llm.revoke_requested' AND e.payload->>'sessionId' = ${ref.sessionId}
              AND e.payload->>'turn' = ${String(ref.turn)}
              AND e.payload->>'firstEpoch' = ${String(ref.epoch)})
          RETURNING id
        )
        UPDATE llm_keys SET revoke_requested_at = coalesce(revoke_requested_at, clock_timestamp())
        WHERE task_id = ${ref.taskId}::uuid AND session_id = ${ref.sessionId}
          AND turn_no = ${ref.turn} AND first_epoch = ${ref.epoch}`
    })
    const path = turnCredentialPath(ref)
    await context.secrets.kvDelete(path)
    await gatewayTransaction(context.prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM llm_keys
          WHERE task_id = ${ref.taskId}::uuid AND turn_no = ${ref.turn}
            AND first_epoch = ${ref.epoch} AND session_id = ${ref.sessionId} FOR UPDATE`
      await tx.$executeRaw`
          UPDATE llm_keys k SET revoked_at = coalesce(k.revoked_at, clock_timestamp()),
            usage_closed_at = CASE WHEN NOT EXISTS
              (SELECT 1 FROM llm_calls c WHERE c.key_id = k.id AND c.state = 'open')
              THEN coalesce(k.usage_closed_at, clock_timestamp()) ELSE k.usage_closed_at END
          WHERE k.task_id = ${ref.taskId}::uuid AND k.turn_no = ${ref.turn}
            AND k.first_epoch = ${ref.epoch} AND k.session_id = ${ref.sessionId}`
    })
    await context.secrets.kvDestroyAll(path)
  } catch (error) {
    if (isDomainError(error)) throw error
    throw llmGatewayUnavailable()
  }
}
