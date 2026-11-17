import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import { listWorkspaceEnv, removeWorkspaceEnv, setWorkspaceEnv } from '../services/workspace-env.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Настройки → Переменные» (docs/plan/83-remove-projects.md, БП4): every chat of the workspace
// gets them. `workspaceId` absent — the user's personal workspace, the one their chats go to.

const variableOutput = z.strictObject({
  name: z.string(),
  keyVersion: z.number().int(),
  updatedAt: z.date(),
})

const workspaceInput = { workspaceId: z.uuid().optional() }

export const workspaceEnvRouter = router({
  /** The names of the variables, never a value. */
  list: consentedProcedure
    .input(z.strictObject(workspaceInput))
    .output(
      z.strictObject({
        workspaceId: z.uuid().nullable(),
        canEdit: z.boolean(),
        variables: z.array(variableOutput),
      }),
    )
    .query(({ ctx, input }) =>
      listWorkspaceEnv(ctx.prisma, {
        appEnv: chatContextOf(ctx).appEnv,
        userId: ctx.user.id,
        workspaceId: input.workspaceId,
      }),
    ),

  /** Adds a variable or replaces its value; the value is never shown again. */
  set: consentedProcedure
    .input(
      z.strictObject({
        ...workspaceInput,
        // Checked in the service, so a bad name answers in the client's words.
        name: z.string().max(64),
        value: z.string().max(16 * 1024),
      }),
    )
    .output(variableOutput)
    .mutation(({ ctx, input }) => {
      const chat = chatContextOf(ctx)
      return setWorkspaceEnv(ctx.prisma, chat.secrets, {
        appEnv: chat.appEnv,
        userId: ctx.user.id,
        workspaceId: input.workspaceId,
        name: input.name,
        value: input.value,
      })
    }),

  remove: consentedProcedure
    .input(z.strictObject({ ...workspaceInput, name: z.string().max(64) }))
    .output(z.strictObject({ removed: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const chat = chatContextOf(ctx)
      return removeWorkspaceEnv(ctx.prisma, chat.secrets, {
        appEnv: chat.appEnv,
        userId: ctx.user.id,
        workspaceId: input.workspaceId,
        name: input.name,
        now: new Date(),
      })
    }),
})
