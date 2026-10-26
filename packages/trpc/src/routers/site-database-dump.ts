import { clientIp } from '@repo/auth'
import { databaseDumpLimits } from '@repo/domain'
import { z } from 'zod'

import { readSiteDatabaseDump, setSiteDatabaseDump } from '../services/site-database-dump.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «База и бэкап»: the SQL dump on the site's file source a preview's database is copied from
// (services/site-database-dump.ts). The path is checked by databaseDumpPathSchema in the service.

const dumpOutput = z.strictObject({
  path: z.string().nullable(),
  updatedAt: z.date().nullable(),
  readable: z.boolean(),
  liveDatabase: z.boolean(),
})

export const siteDatabaseDumpRouter = router({
  get: consentedProcedure
    .input(z.strictObject({ siteId: z.uuid() }))
    .output(dumpOutput)
    .query(({ ctx, input }) => readSiteDatabaseDump(ctx.prisma, { ...input, userId: ctx.user.id })),

  set: consentedProcedure
    .input(
      z.strictObject({
        siteId: z.uuid(),
        path: z
          .string()
          .max(databaseDumpLimits.pathChars * 2)
          .nullable(),
      }),
    )
    .output(dumpOutput)
    .mutation(({ ctx, input }) =>
      setSiteDatabaseDump(ctx.prisma, {
        ...input,
        userId: ctx.user.id,
        ip: clientIp(ctx.headers),
      }),
    ),
})
