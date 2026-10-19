import { egressHostLimits, envVarLimits } from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { listSiteEnv, removeSiteEnv, setSiteEnv } from '../services/chat/site-env.ts'
import { consentedProcedure, router } from '../trpc.ts'

const variableOutput = z.strictObject({
  name: z.string(),
  hosts: z.array(z.string()),
  toAgent: z.boolean(),
  toPreview: z.boolean(),
  agentConsentAt: z.date().nullable(),
  keyVersion: z.number().int(),
  updatedAt: z.date(),
})

/** Bounds of the body; the rules of a name, a value and a host are checked with their own texts. */
const name = z.string().max(128)

export const siteEnvRouter = router({
  /**
   * The variables of a site: names, hosts and whom they go to — never a value (Р13); and whether
   * its workspace may give them to the agent at all (`agentAllowed`), so the form can say so
   * before the client saves.
   */
  list: consentedProcedure
    .input(z.strictObject({ siteId: z.uuid() }))
    .output(z.strictObject({ agentAllowed: z.boolean(), variables: z.array(variableOutput) }))
    .query(({ ctx, input }) => listSiteEnv(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** Adds or changes a variable: the value goes to Vault and never comes back. */
  set: consentedProcedure
    .input(
      z.strictObject({
        siteId: z.uuid(),
        name,
        value: z.string().max(envVarLimits.valueMaxBytes * 2),
        hosts: z
          .array(z.string().max(egressHostLimits.chars))
          .max(egressHostLimits.perVariable * 2),
        toPreview: z.boolean(),
        toAgent: z.boolean(),
        agentConsent: z.boolean(),
      }),
    )
    .output(variableOutput)
    .mutation(({ ctx, input }) =>
      setSiteEnv(ctx.prisma, chatContextOf(ctx).secrets, {
        ...input,
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),

  /** Removes a variable; one that is not there is removed already. */
  remove: consentedProcedure
    .input(z.strictObject({ siteId: z.uuid(), name }))
    .output(z.strictObject({ removed: z.boolean() }))
    .mutation(({ ctx, input }) =>
      removeSiteEnv(ctx.prisma, chatContextOf(ctx).secrets, {
        ...input,
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),
})
