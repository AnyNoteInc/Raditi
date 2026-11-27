import type { PrismaClient } from '@repo/db'
import { crossBorderNotCleared, DomainError, llmPriceMissing, Money } from '@repo/domain'
import { quickEditLimits } from '@repo/domain/artifacts'
import {
  gatewayTransaction,
  lockSubscriptionPool,
  newQuickKey,
  QUICK_KEY_TTL_MS,
  quickKeySession,
  turnKeyHash,
} from '@repo/turn-keys'

// The key of one quick edit (docs/plan/98-quick-edits.md, БПр4): one transaction, no Vault, no
// lease. The profile is the enabled `quick` one on `zai-api` (БПр1, БПр3); the account is one of
// the driver `quick` of that provider, so the gateway admits the key nowhere else.

export const QUICK_DRIVER = 'quick'
export const QUICK_BACKEND = 'zai-api'
export const QUICK_REASONING_EFFORT = 'low'

export interface QuickKey {
  keyId: string
  /** The value, in memory only: never logged, never stored. */
  secret: string
  /** The model id the provider knows. */
  model: string
}

/** Why no key: the quick edits are off, or the client's data may not go to the provider. */
export const quickEditsOff = (): DomainError =>
  new DomainError('QUICK_EDITS_OFF', 'Quick edits are not available now', 503)

/**
 * The budget of a key: twice what one call may cost — the first and one retry — by the rates of
 * the profile, the input as the gateway estimates it (bytes / 3) plus the retry's longer prefix.
 */
export function quickKeyBudgetRub(
  estimatedInputTokens: number,
  price: { inputPer1m: { toString(): string }; outputPer1m: { toString(): string } },
  reserveOutputTokens: number = quickEditLimits.outputTokens,
): InstanceType<typeof Money> {
  const input = new Money(estimatedInputTokens + reserveOutputTokens).mul(
    price.inputPer1m.toString(),
  )
  const output = new Money(reserveOutputTokens).mul(price.outputPer1m.toString())
  return input.plus(output).div(1_000_000).mul(2).toDecimalPlaces(10, Money.ROUND_UP)
}

export async function issueQuickKey(
  prisma: Pick<PrismaClient, '$transaction'>,
  input: {
    taskId: string
    attempt: number
    quickEditId: string
    estimatedInputTokens: number
  },
): Promise<QuickKey> {
  return gatewayTransaction(prisma, async (tx) => {
    const [profile] = await tx.$queryRaw<
      {
        modelId: string
        providerId: string
        model: string
        reserveOutputTokens: number
        dataClass: string
      }[]
    >`
      SELECT m.id AS "modelId", p.id AS "providerId", m.provider_model_id AS model,
        m.reserve_output_tokens AS "reserveOutputTokens", w.data_class::text AS "dataClass"
      FROM llm_models m JOIN llm_providers p ON p.id = m.provider_id
      JOIN agent_drivers d ON d.id = ${QUICK_DRIVER} AND d.enabled
      JOIN tasks t ON t.id = ${input.taskId}::uuid AND t.kind = 'quick_edits'
      JOIN workspaces w ON w.id = t.workspace_id
      WHERE p.slug = ${QUICK_BACKEND} AND p.enabled AND m.enabled AND m.quick
        AND m.provider_model_id IS NOT NULL AND m.reserve_output_tokens > 0
      ORDER BY m.slug LIMIT 1
      FOR SHARE OF m, p, d`
    if (!profile) throw quickEditsOff()
    if (profile.dataClass === 'client') {
      const clearance = await tx.$queryRaw<{ id: string }[]>`
        SELECT c.id FROM cross_border_clearances c
        WHERE c.provider_id = ${profile.providerId}::uuid AND c.revoked_at IS NULL
          AND c.transfer_allowed_from <= (clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
        FOR SHARE OF c`
      if (!clearance[0]) throw crossBorderNotCleared()
    }
    const price = await tx.llmModelPrice.findFirst({
      where: { modelId: profile.modelId, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: 'desc' },
      select: { inputPer1m: true, outputPer1m: true },
    })
    if (!price) throw llmPriceMissing()
    await lockSubscriptionPool(tx, QUICK_BACKEND)
    // The least used account of the driver with no stop flag: no windows on the API (БПр16).
    const [account] = await tx.$queryRaw<{ id: string }[]>`
      SELECT a.id FROM subscription_accounts a
      WHERE a.provider_id = ${profile.providerId}::uuid AND a.driver_id = ${QUICK_DRIVER}
        AND a.enabled AND a.credential_version > 0 AND a.credentials_revoked_at IS NULL
        AND a.retire_requested_at IS NULL AND a.status = 'active' AND a.health = 'ok'
        AND (a.cooling_until IS NULL OR a.cooling_until <= clock_timestamp())
        AND (a.breaker_open_until IS NULL OR a.breaker_open_until <= clock_timestamp())
      ORDER BY a.last_used_at NULLS FIRST, a.id LIMIT 1`
    if (!account) throw quickEditsOff()
    const secret = newQuickKey()
    const expiresAt = new Date(Date.now() + QUICK_KEY_TTL_MS)
    const key = await tx.llmKey.create({
      data: {
        keyHash: turnKeyHash(secret),
        taskId: input.taskId,
        taskAttempt: input.attempt,
        sessionId: quickKeySession(input.quickEditId),
        turnNo: input.attempt,
        firstEpoch: 1,
        driverId: QUICK_DRIVER,
        modelId: profile.modelId,
        subscriptionAccountId: account.id,
        reasoningEffort: QUICK_REASONING_EFFORT,
        budgetRub: quickKeyBudgetRub(
          input.estimatedInputTokens,
          price,
          profile.reserveOutputTokens,
        ),
        expiresAt,
        validUntil: expiresAt,
      },
      select: { id: true },
    })
    await tx.subscriptionAccount.update({
      where: { id: account.id },
      data: { lastUsedAt: new Date() },
    })
    await tx.$executeRaw`
      UPDATE tasks SET status = 'running', updated_at = now()
      WHERE id = ${input.taskId}::uuid AND status = 'preparing' AND attempt = ${input.attempt}`
    return { keyId: key.id, secret, model: profile.model }
  })
}
