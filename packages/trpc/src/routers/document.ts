import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { issuePageView, readDocumentText } from '../services/chat/documents.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The documents the agent made in a chat (docs/plan/67-agent-documents.md, Д3, Д5): the address of
// a page in the frame, and the text of a Markdown document the cabinet draws.

const fileInput = z.strictObject({ taskId: z.uuid(), fileId: z.uuid() })

export const documentRouter = router({
  /**
   * A fresh address of a page of the chat on the domain of pages, five minutes: every frame of
   * it asks for its own. A chat of someone else and a file that is no page answer NOT_FOUND.
   */
  pageView: consentedProcedure
    .input(fileInput)
    .output(z.strictObject({ url: z.string(), expiresAt: z.iso.datetime() }))
    .mutation(({ ctx, input }) =>
      issuePageView(ctx.prisma, chatContextOf(ctx), { userId: ctx.user.id, ...input }),
    ),
  /** The text of a Markdown document of the chat: never changes for its id. */
  text: consentedProcedure
    .input(fileInput)
    .output(
      z.discriminatedUnion('readable', [
        z.strictObject({ readable: z.literal(true), text: z.string(), truncated: z.boolean() }),
        z.strictObject({ readable: z.literal(false) }),
      ]),
    )
    .query(({ ctx, input }) =>
      readDocumentText(ctx.prisma, chatContextOf(ctx).storage(), {
        userId: ctx.user.id,
        ...input,
      }),
    ),
})
