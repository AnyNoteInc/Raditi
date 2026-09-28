import { publicProcedure, router } from '../trpc.ts'

export const healthRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const })),
})
