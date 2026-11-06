import { siteFilePathSchema } from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { listSiteFiles, readSiteFile } from '../services/site-files.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The section «Терминал» of a project (owner's request of 06.11.2026): the files of the version the
// site has and one of them to read (services/site-files.ts). Read only.

const siteInput = z.strictObject({ siteId: z.uuid() })

export const siteFilesRouter = router({
  /** The files of the version the site has; `preparing` — core is reading them, ask again. */
  list: consentedProcedure
    .input(siteInput)
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({ state: z.enum(['none', 'preparing']) }),
        z.strictObject({
          state: z.literal('ready'),
          version: z.string().nullable(),
          truncated: z.boolean(),
          files: z.array(z.strictObject({ path: z.string(), size: z.number().int().min(0) })),
        }),
      ]),
    )
    .query(({ ctx, input }) =>
      listSiteFiles(ctx.prisma, chatContextOf(ctx).storage(), { ...input, userId: ctx.user.id }),
    ),

  /** One file of that version: its text, or why it is not shown. */
  read: consentedProcedure
    .input(siteInput.extend({ path: siteFilePathSchema }))
    .output(
      z.discriminatedUnion('state', [
        z.strictObject({
          state: z.enum(['none', 'preparing', 'missing', 'binary', 'too_large']),
        }),
        z.strictObject({ state: z.literal('ready'), text: z.string() }),
      ]),
    )
    .query(({ ctx, input }) =>
      readSiteFile(ctx.prisma, chatContextOf(ctx).storage(), { ...input, userId: ctx.user.id }),
    ),
})
