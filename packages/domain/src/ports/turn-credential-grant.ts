import { Decimal } from 'decimal.js'
import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { modelClassSchema } from '../llm/model-class.ts'
import { agentDriverIds } from './agent-driver.ts'
import { llmBackendIdSchema } from './llm-backend.ts'
import { MAX_SANDBOX_TURN_MS } from './sandbox-provider.ts'
import { TURN_FINALIZE_RESERVE_MS } from './turn-runner.ts'

/** Trusted issuance policy. Contains no subscription credential or per-turn key. */
export const turnCredentialGrantSchema = z
  .object({
    driverId: z.enum(agentDriverIds),
    backend: llmBackendIdSchema,
    modelSlug: z.string().min(1).max(128),
    modelClass: modelClassSchema,
    reasoningEffort: z.string().min(1).max(32).nullable(),
    ttlMs: z.number().int().positive().max(MAX_SANDBOX_TURN_MS),
    deadlineAt: z.date(),
    /**
     * Only the absolute range: a grant knows neither the plan nor the rates. The issuer has
     * to check the attempt ceiling and the first-call reserve with turnKeyBudgetVerdict.
     */
    budgetRub: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,2})\.\d{2}$/)
      .refine((value) => {
        if (!/^(?:0|[1-9]\d{0,2})\.\d{2}$/.test(value)) return false
        return new Decimal(value).gt(0) && new Decimal(value).lte(750)
      }),
    /** A runner VM's trusted source address; null is local execution only. */
    boundSource: z.union([z.ipv4(), z.ipv6()]).nullable(),
  })
  .strict()
export type TurnCredentialGrant = z.infer<typeof turnCredentialGrantSchema>

/** The supervisor supplies the persisted deadline and the claimed runner's source address. */
export const turnCredentialPolicySchema = turnCredentialGrantSchema.omit({
  deadlineAt: true,
  boundSource: true,
})
export type TurnCredentialPolicy = z.infer<typeof turnCredentialPolicySchema>

/**
 * P3 issuance/recovery must use the earlier of TTL and the agent deadline, leaving the
 * publication reserve intact. This policy is wired into TurnCredentialSource in B11/P12.
 */
export function turnCredentialExpiresAt(grant: TurnCredentialGrant, now: Date): Date {
  const result = turnCredentialGrantSchema.safeParse(grant)
  if (!result.success || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw badRequest('Invalid turn credential grant')
  }
  const expiresAt = Math.min(
    now.getTime() + result.data.ttlMs,
    result.data.deadlineAt.getTime() - TURN_FINALIZE_RESERVE_MS,
  )
  if (expiresAt <= now.getTime()) throw badRequest('Turn credential grant has no agent time left')
  return new Date(expiresAt)
}
