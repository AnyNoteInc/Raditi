import { attachmentLimits } from '@repo/domain'
import { z } from 'zod'

import {
  attachmentIdsSchema,
  bindChooserAttachments,
  listTaskAttachments,
  removeUnsentAttachment,
  startAttachment,
} from '../services/chat/attachments.ts'
import { chatContextOf } from '../services/chat/context.ts'
import { consentedProcedure, router } from '../trpc.ts'

// Files a client attaches to a message (docs/plan/57-browser-tasks.md, Б26, Б27). The bytes go to
// web (`PUT /api/attachments/<id>`), never through tRPC; a message binds the files it sends
// (`task.create`, `task.message`).

const attachmentItem = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  type: z.string(),
  size: z.number().int(),
  kind: z.enum(['image', 'document']),
  sentAt: z.date().nullable(),
})

export const attachmentRouter = router({
  /**
   * Announces a file for a site: its name as the browser gave it, its size in bytes and the type
   * of its extension. Answers its id and the path its bytes are sent to; a file the rules refuse
   * answers why (`ATTACHMENT_REFUSED`).
   */
  start: consentedProcedure
    .input(
      z.strictObject({
        siteId: z.uuid(),
        name: z.string().max(attachmentLimits.rawNameLength),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        type: z.string().max(255),
      }),
    )
    .output(z.strictObject({ attachmentId: z.uuid(), uploadPath: z.string() }))
    .mutation(({ ctx, input }) => {
      // Files belong to dialogs: where dialogs are not set up, nothing could store them.
      chatContextOf(ctx)
      return startAttachment(ctx.prisma, { ...input, userId: ctx.user.id })
    }),

  /** Removes a file of the user that no message sent; a sent one stays with its task. */
  remove: consentedProcedure
    .input(z.strictObject({ attachmentId: z.uuid() }))
    .output(z.strictObject({ attachmentId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const attachmentId = input.attachmentId.toLowerCase()
      await removeUnsentAttachment(ctx.prisma, chatContextOf(ctx), {
        userId: ctx.user.id,
        attachmentId,
      })
      return { attachmentId }
    }),

  /** The files sent with the messages of a task: what the file chooser of its browser offers. */
  list: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(z.array(attachmentItem))
    .query(({ ctx, input }) =>
      listTaskAttachments(ctx.prisma, { userId: ctx.user.id, taskId: input.taskId }),
    ),

  /**
   * Gives files uploaded from the file chooser of the browser («Загрузить новый», Б27) to a task in
   * the browser, without a message: all of them or none.
   */
  bind: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), attachmentIds: attachmentIdsSchema.min(1) }))
    .output(z.strictObject({ bound: z.number().int() }))
    .mutation(({ ctx, input }) =>
      bindChooserAttachments(ctx.prisma, {
        userId: ctx.user.id,
        taskId: input.taskId,
        ids: input.attachmentIds,
      }),
    ),
})
