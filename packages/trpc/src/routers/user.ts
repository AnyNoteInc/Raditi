import { profileLastNameSchema, profileNameSchema } from '@repo/auth'
import { CLIENT_INSTRUCTIONS_LIMIT, DomainError, looksLikeSecret } from '@repo/domain'
import { z } from 'zod'

import { consentedProcedure, protectedProcedure, router } from '../trpc.ts'

const profileSelect = { id: true, name: true, lastName: true, image: true, email: true } as const

export const userRouter = router({
  me: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    lastName: ctx.user.lastName ?? null,
    image: ctx.user.image ?? null,
    emailVerified: ctx.user.emailVerified,
  })),

  updateProfile: consentedProcedure
    .input(z.strictObject({ name: profileNameSchema, lastName: profileLastNameSchema }))
    .mutation(({ ctx, input }) =>
      ctx.prisma.user.update({
        where: { id: ctx.user.id },
        data: input,
        select: profileSelect,
      }),
    ),

  /** The client's own instructions to the agent in every chat (docs/plan/76, И1). */
  agentInstructions: consentedProcedure
    .output(z.strictObject({ text: z.string() }))
    .query(async ({ ctx }) => {
      const row = await ctx.prisma.agentInstructions.findUnique({ where: { userId: ctx.user.id } })
      return { text: row?.text ?? '' }
    }),

  /**
   * Writes them; empty words remove them. A password or a key is refused, as in a message: the
   * words go to the model with every pass (И3).
   */
  setAgentInstructions: consentedProcedure
    .input(z.strictObject({ text: z.string().max(CLIENT_INSTRUCTIONS_LIMIT * 2) }))
    .output(z.strictObject({ text: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const text = input.text.trim()
      if (text.length > CLIENT_INSTRUCTIONS_LIMIT)
        throw new DomainError('AGENT_INSTRUCTIONS_TOO_LONG', 'The instructions are too long', 400)
      if (looksLikeSecret(text))
        throw new DomainError('AGENT_INSTRUCTIONS_SECRET', 'The instructions hold a secret', 400)
      if (text === '') {
        await ctx.prisma.agentInstructions.deleteMany({ where: { userId: ctx.user.id } })
        return { text: '' }
      }
      await ctx.prisma.agentInstructions.upsert({
        where: { userId: ctx.user.id },
        create: { userId: ctx.user.id, text },
        update: { text },
      })
      return { text }
    }),

  /**
   * «Агент запоминает важное» (docs/plan/84-projects.md, ПР18): off — the agent of the user's chats
   * has neither the tools of memory nor its section; the entries stay.
   */
  setAgentMemory: consentedProcedure
    .input(z.strictObject({ on: z.boolean() }))
    .output(z.strictObject({ on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.user.update({
        where: { id: ctx.user.id },
        data: { agentMemory: input.on },
        select: { id: true },
      })
      return { on: input.on }
    }),
})
