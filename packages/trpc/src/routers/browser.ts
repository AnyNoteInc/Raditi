import { z } from 'zod'

import { issueStreamTicket } from '../services/chat/browser.ts'
import { chatContextOf } from '../services/chat/context.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The cloud browser of a task in the cabinet (docs/plan/57-browser-tasks.md, Б12): the way into
// the stream of its session. The stream itself goes to the gateway, never through tRPC.

export const browserRouter = router({
  /**
   * A one-time ticket (60 s) for the stream of the open browser of a task, the address of the
   * stream and the session it opens. The ticket is sent as the first message of the WebSocket,
   * never in its address. A task of someone else, one without a browser and one whose browser is
   * closed answer the same NOT_FOUND.
   */
  streamTicket: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(z.strictObject({ url: z.string(), ticket: z.string(), sessionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      issueStreamTicket(ctx.prisma, chatContextOf(ctx), {
        userId: ctx.user.id,
        taskId: input.taskId,
      }),
    ),
})
