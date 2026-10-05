import { profileLastNameSchema, profileNameSchema } from '@repo/auth'
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
})
