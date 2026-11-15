import { z } from 'zod'

import {
  setTelegramNotifications,
  startTelegramLink,
  telegramStatus,
  unlinkTelegram,
} from '../services/telegram/link.ts'
import { consentedProcedure, router } from '../trpc.ts'

// «Telegram» of the settings (docs/plan/80-telegram.md, Т3, Т8): link by a one-time link, unlink,
// and whether the bot tells of the chats of the cabinet.
export const telegramRouter = router({
  status: consentedProcedure
    .output(
      z.strictObject({
        available: z.boolean(),
        bot: z.string().nullable(),
        linked: z.strictObject({ username: z.string().nullable(), since: z.date() }).nullable(),
        notifications: z.boolean(),
      }),
    )
    .query(async ({ ctx }) => {
      const bot = ctx.chat?.telegramBot ?? null
      return {
        ...(await telegramStatus(ctx.prisma, { userId: ctx.user.id, available: bot !== null })),
        bot,
      }
    }),

  /** A new link `t.me/<bot>?start=<code>`, 15 minutes, once. */
  link: consentedProcedure
    .output(z.strictObject({ url: z.url(), expiresAt: z.date() }))
    .mutation(({ ctx }) =>
      startTelegramLink(ctx.prisma, {
        userId: ctx.user.id,
        botUsername: ctx.chat?.telegramBot ?? null,
        now: new Date(),
      }),
    ),

  unlink: consentedProcedure
    .output(z.strictObject({ unlinked: z.boolean() }))
    .mutation(async ({ ctx }) => ({
      unlinked: await unlinkTelegram(ctx.prisma, { userId: ctx.user.id }),
    })),

  setNotifications: consentedProcedure
    .input(z.strictObject({ on: z.boolean() }))
    .output(z.strictObject({ on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await setTelegramNotifications(ctx.prisma, { userId: ctx.user.id, on: input.on })
      return { on: input.on }
    }),
})
