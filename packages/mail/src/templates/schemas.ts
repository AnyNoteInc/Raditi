import { z } from 'zod'

// Links end up in href attributes: only http(s), never javascript: or data:.
const httpUrl = z.url({ protocol: /^https?$/ })
// The name typed at sign-up (users.name is varchar(255)). Only the welcome letter takes it,
// and shows it only if greetingName finds it safe: letters with one-time links greet without
// a name, so a crafted name cannot turn them into phishing.
const recipientName = z.string().max(255)
const isoDateTime = z.iso.datetime({ offset: true })

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
