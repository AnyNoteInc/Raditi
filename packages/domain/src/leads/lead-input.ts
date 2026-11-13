import { z } from 'zod'

/**
 * Limits of a lead from the landing (docs/plan/65-landing-platforms-leads.md, Л5; two fields
 * since 13.11.2026).
 */
export const leadLimits = {
  siteChars: 253,
  phoneMinDigits: 10,
  phoneMaxDigits: 15,
  telegramMinChars: 5,
  telegramMaxChars: 32,
} as const

/** The words the form shows under a field; the server answers with the same ones. */
export const leadFieldErrors = {
  site: 'Например, kofeinya.ru',
  phone: 'Нужен номер телефона или ник в Telegram',
  consent: 'Без согласия мы не сможем ответить',
} as const

export type LeadField = keyof typeof leadFieldErrors

/**
 * `+<digits>` from what a visitor types; null when it is not a phone number. Ten digits starting
 * with 9 and eleven starting with 8 are Russian numbers written without +7.
 */
export function normalizeLeadPhone(value: string): string | null {
  const trimmed = value.trim()
  if (!/^\+?[\d\s()\-.]+$/.test(trimmed)) return null
  let digits = trimmed.replace(/\D/g, '')
  if (!trimmed.startsWith('+')) {
    if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`
    else if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`
  }
  if (digits.length < leadLimits.phoneMinDigits || digits.length > leadLimits.phoneMaxDigits) {
    return null
  }
  return `+${digits}`
}

const TELEGRAM_NAME = `[a-z][a-z0-9_]{${leadLimits.telegramMinChars - 1},${leadLimits.telegramMaxChars - 1}}`
const TELEGRAM_AT = new RegExp(`^@(${TELEGRAM_NAME})$`, 'i')
const TELEGRAM_LINK = new RegExp(`^(?:https?://)?(?:t|telegram)\\.me/(${TELEGRAM_NAME})/?$`, 'i')

/**
 * `@name`, lower-cased, from a Telegram username as a visitor types it — `@name`, `t.me/name`,
 * `https://t.me/name`, `telegram.me/name`; null for anything else. A bare word is not a username:
 * without `@` or a link nothing tells it from a name or a typo.
 */
export function normalizeLeadTelegram(value: string): string | null {
  const trimmed = value.trim()
  const name = (TELEGRAM_AT.exec(trimmed) ?? TELEGRAM_LINK.exec(trimmed))?.[1]
  return name === undefined ? null : `@${name.toLowerCase()}`
}

/**
 * How to reach the visitor, as the lead stores it: a phone number as `+<digits>` or a Telegram
 * username as `@name`; null when the value is neither.
 */
export function normalizeLeadContact(value: string): string | null {
  return normalizeLeadPhone(value) ?? normalizeLeadTelegram(value)
}

const LABEL = /^(?!-)[a-z0-9а-яё-]{1,63}(?<!-)$/

/**
 * The host of a site as a visitor types it — `kofeinya.ru`, `www.kofeinya.ru/menu`,
 * `https://кофейня.рф` — lower-cased, without scheme, port, path or a final dot; null when it is
 * not a host name with at least two labels.
 */
export function normalizeLeadSite(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '' || /\s/.test(trimmed)) return null
  const withoutScheme = trimmed.replace(/^https?:\/\//, '')
  const host = withoutScheme.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, '').replace(/\.$/, '')
  if (host.length === 0 || host.length > leadLimits.siteChars || host.includes('@')) return null
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null
  if (/^\d+$/.test(labels.at(-1)!)) return null
  return host
}

/**
 * A lead from the landing, as the form sends it and the server stores it: the site and a contact.
 * The contact keeps the name of its column, `phone`, and holds a phone number or a Telegram
 * username (`normalizeLeadContact`). `check` is the trap field: hidden from people and named like
 * no field a browser fills in, so a filled one marks a robot and the server drops the lead quietly.
 */
export const leadInputSchema = z.object({
  site: z.string().transform((value, ctx) => {
    const site = normalizeLeadSite(value)
    if (site === null) ctx.addIssue({ code: 'custom', message: leadFieldErrors.site })
    return site ?? ''
  }),
  phone: z.string().transform((value, ctx) => {
    const contact = normalizeLeadContact(value)
    if (contact === null) ctx.addIssue({ code: 'custom', message: leadFieldErrors.phone })
    return contact ?? ''
  }),
  consent: z.literal(true, { error: leadFieldErrors.consent }),
  check: z.string().max(200).optional(),
})

export type LeadInput = z.input<typeof leadInputSchema>
export type LeadSubmission = z.output<typeof leadInputSchema>

/** The first message of every invalid field, keyed by the field. */
export function leadFieldIssues(error: z.ZodError): Partial<Record<LeadField, string>> {
  const issues: Partial<Record<LeadField, string>> = {}
  for (const issue of error.issues) {
    const field = issue.path[0]
    if (typeof field === 'string' && field in leadFieldErrors && !(field in issues)) {
      issues[field as LeadField] = issue.message
    }
  }
  return issues
}
