import { z } from 'zod'

/** Limits of a lead from the landing (docs/plan/65-landing-platforms-leads.md, Л5). */
export const leadLimits = {
  nameChars: 100,
  emailChars: 254,
  siteChars: 253,
  aboutMinChars: 10,
  aboutMaxChars: 2000,
  phoneMinDigits: 10,
  phoneMaxDigits: 15,
} as const

/** The words the form shows under a field; the server answers with the same ones. */
export const leadFieldErrors = {
  name: 'Напишите, как к вам обращаться',
  phone: 'Нужен номер из 10–15 цифр',
  email: 'Проверьте адрес почты',
  site: 'Например, kofeinya.ru',
  about: 'Расскажите хотя бы в одном предложении',
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Characters as PostgreSQL counts them: code points, an emoji is one. */
const characters = (text: string) => [...text].length

/**
 * A lead from the landing, as the form sends it and the server stores it. `check` is the trap
 * field: hidden from people and named like no field a browser fills in, so a filled one marks a
 * robot and the server drops the lead quietly. Lengths are counted in characters, as PostgreSQL
 * counts them (`char_length`), not in UTF-16 units.
 */
export const leadInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, leadFieldErrors.name)
    .refine((name) => characters(name) <= leadLimits.nameChars, leadFieldErrors.name),
  phone: z.string().transform((value, ctx) => {
    const phone = normalizeLeadPhone(value)
    if (phone === null) ctx.addIssue({ code: 'custom', message: leadFieldErrors.phone })
    return phone ?? ''
  }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(leadLimits.emailChars, leadFieldErrors.email)
    .regex(EMAIL, leadFieldErrors.email),
  site: z.string().transform((value, ctx) => {
    const site = normalizeLeadSite(value)
    if (site === null) ctx.addIssue({ code: 'custom', message: leadFieldErrors.site })
    return site ?? ''
  }),
  about: z
    .string()
    .trim()
    .refine((about) => characters(about) >= leadLimits.aboutMinChars, leadFieldErrors.about)
    .refine(
      (about) => characters(about) <= leadLimits.aboutMaxChars,
      `Не больше ${leadLimits.aboutMaxChars} знаков`,
    ),
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
