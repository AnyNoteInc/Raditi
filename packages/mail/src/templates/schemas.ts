import { amountRubSchema } from '@repo/domain'
import { z } from 'zod'

// Links end up in href attributes: only http(s), never javascript: or data:.
const httpUrl = z.url({ protocol: /^https?$/ })
// The name typed at sign-up (users.name is varchar(255)). Only the welcome letter takes it,
// and shows it only if greetingName finds it safe: letters with one-time links greet without
// a name, so a crafted name cannot turn them into phishing.
const recipientName = z.string().max(255)
const isoDateTime = z.iso.datetime({ offset: true })

// Billing letters greet without a name and take their words from our own records, never from
// what the customer typed. A value still stays on one line: it goes into a sentence and, in
// the renewal notice, into the subject.
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u)
// plans.name, varchar(100): the letter writes it as «тариф «Бизнес»».
const planName = oneLine(100)
// paymentMethodLabel of @repo/domain: «Карта «Мир» •• 4444», «СБП».
const paymentMethod = oneLine(100)
// The public origin of the app (APP_URL); the letter links to the «Тарифы» page under it.
const billingLink = { appUrl: httpUrl }
/**
 * Gift credits of the workspace that can be spent when the letter is written; may be zero. They
 * are spent without a paid tariff as well, so a letter about a tariff that is not paid for or
 * has ended says of new tasks what the page it leads to says (`giftTakesTasks`).
 */
const giftCreditsLeft = z.int().nonnegative()

export const mailDataSchemas = {
  'verify-email': z.object({
    url: httpUrl,
    expiresAt: isoDateTime.optional(),
  }),
  'reset-password': z.object({
    url: httpUrl,
    expiresAt: isoDateTime.optional(),
  }),
  welcome: z.object({ name: recipientName, appUrl: httpUrl }),
  'payment-succeeded': z.discriminatedUnion('item', [
    z.object({
      item: z.literal('plan'),
      planName,
      amount: amountRubSchema,
      /** The end of the paid period: «Тариф действует до …». */
      periodEnd: isoDateTime,
      /** plans.credits_per_month of the tariff: «Начислили 300 кредитов на этот период». */
      credits: z.int().positive(),
      ...billingLink,
    }),
    z.object({
      item: z.literal('pack'),
      /** plans.pack_credits of the pack: «пакет из 100 кредитов». */
      packCredits: z.int().positive(),
      amount: amountRubSchema,
      ...billingLink,
    }),
  ]),
  'renewal-notice': z.object({
    planName,
    amount: amountRubSchema,
    /** When the automatic charge is made: the end of the current period. */
    chargeAt: isoDateTime,
    paymentMethod,
    ...billingLink,
  }),
  'payment-failed': z.object({
    planName,
    amount: amountRubSchema,
    paymentMethod,
    giftCreditsLeft,
    ...billingLink,
  }),
  'subscription-ended': z.object({
    planName,
    endedAt: isoDateTime,
    /** Purchased credits that stay on the account; may be zero. */
    packCreditsLeft: z.int().nonnegative(),
    giftCreditsLeft,
    ...billingLink,
  }),
}

export type MailKind = keyof typeof mailDataSchemas
export const mailKinds = Object.keys(mailDataSchemas) as MailKind[]

export type MailData = { [K in MailKind]: z.infer<(typeof mailDataSchemas)[K]> }

export type MailMessage<K extends MailKind = MailKind> = {
  [P in K]: { kind: P; to: string; data: MailData[P] }
}[K]

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}
