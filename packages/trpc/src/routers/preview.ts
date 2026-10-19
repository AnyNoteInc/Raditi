import { previewPathLimit } from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { openPreview, resetPreview } from '../services/chat/previews.ts'
import { consentedProcedure, router } from '../trpc.ts'

export const previewRouter = router({
  /**
   * The ticket URL of the dialog's preview (Р19, Р20): what the iframe opens. One-time, for a
   * minute; `to` — the page of the preview to land on.
   */
  ticket: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), to: z.string().max(previewPathLimit).optional() }))
    .output(z.strictObject({ url: z.string(), expiresAt: z.date() }))
    .mutation(({ ctx, input }) =>
      openPreview(ctx.prisma, chatContextOf(ctx).preview?.address ?? null, {
        userId: ctx.user.id,
        target: { taskId: input.taskId },
        to: input.to,
      }),
    ),

  /**
   * `/reset`: the preview is built again to the candidate of the dialog. `requestId` — the
   * press of the browser, shown in the feed; a repeat writes nothing.
   */
  reset: consentedProcedure
    .input(
      z.strictObject({
        taskId: z.uuid(),
        requestId: z
          .uuid()
          .transform((id) => id.toLowerCase())
          .optional(),
      }),
    )
    .output(z.strictObject({ requestEventId: z.string().nullable(), repeated: z.boolean() }))
    .mutation(({ ctx, input }) => resetPreview(ctx.prisma, { ...input, userId: ctx.user.id })),
})
