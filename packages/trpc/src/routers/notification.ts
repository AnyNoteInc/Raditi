import { isPushEndpoint } from '@repo/domain'
import { z } from 'zod'

import {
  readNotificationSettings,
  replaceBrowserSubscription,
  resubscribeBrowser,
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
  /**
   * The client's choice, how many browsers take Web Push, and the key a browser subscribes by.
   * `endpoint` — the subscription of the browser that asks, if it has one: `otherBrowsers` counts
   * the browsers of the user besides it (docs/plan/82-scheduled-tasks.md, Зп37).
   */
  settings: consentedProcedure
    .input(z.strictObject({ endpoint: z.url().max(2048).optional() }).optional())
    .output(
      z.strictObject({
        push: z.boolean(),
        email: z.boolean(),
        browsers: z.number().int(),
        otherBrowsers: z.number().int(),
        publicKey: z.string().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => ({
      ...(await readNotificationSettings(ctx.prisma, ctx.user.id, input?.endpoint)),
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
    .mutation(({ ctx, input }) =>
      subscribeBrowser(ctx.prisma, ctx.user.id, input, ctx.chat?.webPushPublicKey ?? null),
    ),

  /**
   * «Включить» in a browser whose subscription was made under another VAPID key (docs/plan/82-
   * scheduled-tasks.md, Зп37): the press is the consent — the new subscription is the user's. The
   * old one goes only if it is this user's.
   */
  resubscribe: consentedProcedure
    .input(subscriptionInput.extend({ oldEndpoint: z.url().max(2048).nullable() }))
    .output(z.strictObject({ resubscribed: z.literal(true) }))
    .mutation(({ ctx, input }) => {
      const { oldEndpoint, ...subscription } = input
      return resubscribeBrowser(
        ctx.prisma,
        ctx.user.id,
        { oldEndpoint, subscription },
        ctx.chat?.webPushPublicKey ?? null,
      )
    }),

  /**
   * The browser replaced its subscription by itself (`pushsubscriptionchange`, Зп41): the service
   * worker posts the old endpoint and the new subscription to `/api/notifications/resubscribe`,
   * which calls this. Not a «turn on»: the row of the old one moves to the new one only when it is
   * the signed-in user's — another account signed in on that browser gets nothing (Зп37).
   */
  replaceSubscription: consentedProcedure
    .input(subscriptionInput.extend({ oldEndpoint: z.url().max(2048).nullable() }))
    .output(z.strictObject({ replaced: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const { oldEndpoint, ...subscription } = input
      return replaceBrowserSubscription(
        ctx.prisma,
        ctx.user.id,
        { oldEndpoint, subscription },
        ctx.chat?.webPushPublicKey ?? null,
      )
    }),

  unsubscribe: consentedProcedure
    .input(z.strictObject({ endpoint: z.url().max(2048) }))
    .output(z.strictObject({ unsubscribed: z.literal(true) }))
    .mutation(({ ctx, input }) => unsubscribeBrowser(ctx.prisma, ctx.user.id, input.endpoint)),
})
