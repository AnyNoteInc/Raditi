import { amountRubSchema } from '@repo/domain'
import { z } from 'zod'

// Links end up in href attributes: only http(s), never javascript: or data:.
const httpUrl = z.url({ protocol: /^https?$/ })
// The name typed at sign-up (users.name is varchar(255)). Only the welcome letter takes it,
// and shows it only if greetingName finds it safe: letters with one-time links greet without
// a name, so a crafted name cannot turn them into phishing.
const recipientName = z.string().max(255)
const isoDateTime = z.iso.datetime({ offset: true })

/**
 * Why a chat waits for the client (docs/plan/75-chat-input-output.md, ВВ6), and, of a scheduled
 * task, why it did not run (docs/plan/82-scheduled-tasks.md, Зп38, Зп39): it did not start, it
 * paused, it missed a run — the notificationKinds of @repo/domain.
 */
export const chatWaitingKinds = [
  'answered',
  'question',
  'ready',
  'failed',
  'limit',
  'not_started',
  'paused',
  'missed',
] as const
export type ChatWaitingKind = (typeof chatWaitingKinds)[number]
/** The kinds of a scheduled task itself: the letter opens the task, not a chat. */
export const scheduledTaskLetterKinds = [
  'not_started',
  'paused',
  'missed',
] as const satisfies readonly ChatWaitingKind[]

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
 * Gift credits of the workspace that can be spent when the letter is written — in the letter of
 * a failed payment, with the pack credits; may be zero. They are spent without a paid tariff, so a letter about a tariff that is not paid for or
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
  // The agent of a chat waits for the client, who is not looking at it (docs/plan/75, ВВ9). No
  // words of the chat — not its name, not the agent's answer: a link to it and to the settings.
  // A letter of a scheduled task (docs/plan/82, Зп39) names no task either: its name is the
  // client's words.
  'chat-waiting': z.object({
    kind: z.enum(chatWaitingKinds),
    /** Of a run of a scheduled task, or of the task itself; absent — a chat of the client. */
    scheduled: z.boolean().optional(),
    /** The chat in the cabinet; of a task itself — its page. */
    url: httpUrl,
    /** «Уведомления» of the settings, where the letters are turned off. */
    settingsUrl: httpUrl,
  }),
  // A notice of an artifact (docs/plan/88-artifacts.md, Ар54): what happened in our words, a link
  // to the cabinet and to the settings where letters are turned off — no title, no words of anyone.
  'artifact-notice': z.object({
    kind: z.enum([
      'artifact_shared',
      'artifact_comment',
      'artifact_agent_reply',
      'artifact_changed',
    ]),
    url: httpUrl,
    settingsUrl: httpUrl,
  }),
  // An invitation to an artifact (docs/plan/88-artifacts.md, Ар35, slice 88.16-2): to any address
  // the owner typed, so its words are ours alone — the inviter's name only if greetingName finds it
  // safe, the kind as a word, never a title or anything of the artifact.
  'artifact-invite': z.object({
    inviterName: recipientName,
    /** «документ», «макет», «таблицу»… — the accusative of the kind. */
    kindWord: z.enum(['документ', 'макет', 'таблицу', 'холст', 'фирменный стиль', 'артефакт']),
    /** «Приглашения» in the cabinet: after sign-in with this address. */
    url: httpUrl,
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
