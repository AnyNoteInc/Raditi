import { requestMeta } from '@repo/auth'
import { z } from 'zod'

import { acceptRequiredConsents, listConsents, setMarketingConsent } from '../services/consents.ts'
import { protectedProcedure, router } from '../trpc.ts'

export const consentRouter = router({
  /** Every document that takes a consent, with the user's standing answer. */
  list: protectedProcedure.query(({ ctx }) => listConsents(ctx.prisma, ctx.user.id)),

  /**
   * Onboarding and new editions: the server itself requires both checkboxes, the terms and
   * the separate consent to personal data processing (152-FZ).
   */
  acceptRequired: protectedProcedure
    .input(
      z.object({
        acceptTerms: z.literal(true),
        acceptPersonalData: z.literal(true),
        marketing: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const written = await acceptRequiredConsents(ctx.prisma, {
        userId: ctx.user.id,
        marketing: input.marketing,
        ...requestMeta(ctx.headers),
      })
      return { written }
    }),

  setMarketing: protectedProcedure
    .input(z.object({ granted: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const changed = await setMarketingConsent(ctx.prisma, {
        userId: ctx.user.id,
        granted: input.granted,
        ...requestMeta(ctx.headers),
      })
      return { changed }
    }),
})
