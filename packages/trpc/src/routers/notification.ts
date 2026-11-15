import { isPushEndpoint } from '@repo/domain'
import { z } from 'zod'

import {
  readNotificationSettings,
  subscribeBrowser,
  unsubscribeBrowser,
  writeNotificationSettings,
} from '../services/notifications.ts'
import { consentedProcedure, router } from '../trpc.ts'

/** The subscription a browser gives (`PushSubscription.toJSON()`), as the cabinet sends it. */
const subscriptionInput = z.strictObject({
  // Only a push service of a browser: core sends to it (docs/plan/75, ВВ8).
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine(isPushEndpoint, 'not a push service'),
  p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
  auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
})

// «Уведомления» of the settings (docs/plan/75-chat-input-output.md, ВВ8, ВВ10).
export const notificationRouter = router({
  /** The client's choice, how many browsers take Web Push, and the key a browser subscribes by. */
  settings: consentedProcedure
    .output(
      z.strictObject({
        push: z.boolean(),
        email: z.boolean(),
        browsers: z.number().int(),
        publicKey: z.string().nullable(),
      }),
    )
    .query(async ({ ctx }) => ({
      ...(await readNotificationSettings(ctx.prisma, ctx.user.id)),
      publicKey: ctx.chat?.webPushPublicKey ?? null,
    })),

  setSettings: consentedProcedure
    .input(z.strictObject({ push: z.boolean().optional(), email: z.boolean().optional() }))
    .output(z.strictObject({ push: z.boolean(), email: z.boolean() }))
    .mutation(({ ctx, input }) =>
      writeNotificationSettings(ctx.prisma, ctx.user.id, {
        ...(input.push === undefined ? {} : { push: input.push }),
        ...(input.email === undefined ? {} : { email: input.email }),
      }),
    ),

  subscribe: consentedProcedure
    .input(subscriptionInput)
    .output(z.strictObject({ subscribed: z.literal(true) }))
    .mutation(({ ctx, input }) => subscribeBrowser(ctx.prisma, ctx.user.id, input)),

  unsubscribe: consentedProcedure
    .input(z.strictObject({ endpoint: z.url().max(2048) }))
    .output(z.strictObject({ unsubscribed: z.literal(true) }))
    .mutation(({ ctx, input }) => unsubscribeBrowser(ctx.prisma, ctx.user.id, input.endpoint)),
})
