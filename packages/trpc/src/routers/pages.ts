import { pageKinds, pageLimits, pageTitleSchema } from '@repo/domain'
import { z } from 'zod'

import {
  listCabinetPages,
  restoreCabinetPage,
  setCabinetPagePassword,
  takeDownCabinetPage,
} from '../services/pages.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Страницы» of the cabinet (docs/plan/69-pages.md, Ст13–Ст15, Ст30): the pages of the user's
// workspaces and what the client alone does with them — the password, taking a page down and
// putting it back. The agent has none of these (Ст20).

const pageOutput = z.strictObject({
  pageId: z.uuid(),
  workspaceId: z.uuid(),
  title: pageTitleSchema,
  url: z.url(),
  kind: z.enum(pageKinds),
  state: z.enum(['pending', 'live', 'taken_down']),
  version: z.number().int().min(0),
  hasPassword: z.boolean(),
  takenDownBy: z.enum(['client', 'operator']).nullable(),
  chat: z.strictObject({ id: z.uuid(), title: z.string().nullable() }).nullable(),
  canManage: z.boolean(),
  updatedAt: z.iso.datetime(),
})
const pageInput = z.strictObject({ pageId: z.uuid() })

export const pagesRouter = router({
  /** `enabled` false — PAGES_BASE_DOMAIN is unset here: no pages. */
  list: consentedProcedure
    .output(z.strictObject({ enabled: z.boolean(), pages: z.array(pageOutput) }))
    .query(async ({ ctx }) => {
      const address = ctx.chat?.pages ?? null
      if (address === null) return { enabled: false, pages: [] }
      return { enabled: true, pages: await listCabinetPages(ctx.prisma, address, ctx.user.id) }
    }),

  /** The password of a page; null clears it. A new one stops the viewers' former cookies. */
  setPassword: consentedProcedure
    .input(
      pageInput.extend({
        password: z
          .string()
          .min(pageLimits.passwordMinChars)
          // A bound on UTF-16 units only: the bounds in characters are pagePasswordProblem's.
          .max(pageLimits.passwordMaxChars * 2)
          .nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setCabinetPagePassword(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),

  takeDown: consentedProcedure
    .input(pageInput)
    .mutation(({ ctx, input }) =>
      takeDownCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),

  restore: consentedProcedure
    .input(pageInput)
    .mutation(({ ctx, input }) =>
      restoreCabinetPage(ctx.prisma, { ...input, userId: ctx.user.id }),
    ),
})
