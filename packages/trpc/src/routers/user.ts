import { protectedProcedure, router } from '../trpc.ts'

export const userRouter = router({
  me: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    emailVerified: ctx.user.emailVerified,
  })),
})
