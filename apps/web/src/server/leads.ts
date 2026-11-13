import { createHmac } from 'node:crypto'

import {
  CAPTCHA_HEADER,
  clientIp,
  clientRateKey,
  validateSmartCaptcha,
  type CaptchaVerdict,
} from '@repo/auth'
import { enqueueOutbox, type PrismaClient } from '@repo/db'
import { leadFieldIssues, leadInputSchema, legalDocumentFor } from '@repo/domain'

/** A lead is a few hundred bytes: the address of a site and a contact. */
export const MAX_LEAD_BODY_BYTES = 16 * 1024
/** Leads one address may send in an hour (docs/plan/65-landing-platforms-leads.md, Л7). */
export const LEADS_PER_ADDRESS_PER_HOUR = 5
const HOUR_MS = 60 * 60_000
const CAPTCHA_TOKEN_MAX = 4096

export interface LeadDeps {
  prisma: Pick<PrismaClient, 'lead' | '$transaction'>
  /** APP_URL: the only origin a lead is taken from. */
  appUrl: string
  /** BETTER_AUTH_SECRET: the key of the HMAC of the client address. */
  secret: string
  /** null: SmartCaptcha is off (local development, tests); production always has it. */
  captchaServerKey: string | null
  validateCaptcha?: (input: {
    serverKey: string
    token: string
    ip?: string
  }) => Promise<CaptchaVerdict>
  now?: () => Date
  log?: (line: string) => void
}

const answer = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** HMAC-SHA256 of the client address, hex: the limit counts by it, the address is not kept. */
export function leadAddressHash(secret: string, ip: string | null): string {
  return createHmac('sha256', secret)
    .update(`lead:${ip ?? 'unknown'}`)
    .digest('hex')
}

/**
 * POST /api/leads: a lead from the landing. Checks the origin, the fields, the trap field, the
 * captcha and the limit per address, then writes the lead and its outbox row in one transaction;
 * core posts it to Telegram. The answers carry the words of the form, never the values.
 */
export async function handleLeadRequest(request: Request, deps: LeadDeps): Promise<Response> {
  const log = deps.log ?? ((line: string) => console.info(line))
  const origin = request.headers.get('origin')
  if (origin === null || origin !== new URL(deps.appUrl).origin) {
    return answer(403, { message: 'Отправьте заявку со страницы Радити.' })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return answer(400, { message: 'Не удалось прочитать заявку. Попробуйте ещё раз.' })
  }
  const parsed = leadInputSchema.safeParse(json)
  if (!parsed.success) {
    return answer(400, {
      message: 'Проверьте поля заявки.',
      fields: leadFieldIssues(parsed.error),
    })
  }
  const lead = parsed.data
  // A robot filled the field people never see: it is told the lead went through.
  if (lead.check) {
    log('lead_dropped reason=trap')
    return answer(200, { ok: true })
  }

  const ip = clientIp(request.headers)
  if (deps.captchaServerKey !== null) {
    const token = request.headers.get(CAPTCHA_HEADER)?.trim()
    if (!token) return answer(400, { message: 'Подтвердите, что вы не робот.' })
    const verdict =
      token.length > CAPTCHA_TOKEN_MAX
        ? ({ kind: 'fail', reason: 'token_too_long' } as const)
        : await (deps.validateCaptcha ?? validateSmartCaptcha)({
            serverKey: deps.captchaServerKey,
            token,
            ...(ip ? { ip } : {}),
          })
    if (verdict.kind === 'fail') {
      log(`lead_refused reason=captcha_${verdict.reason}`)
      return answer(403, { message: 'Проверка не пройдена, попробуйте ещё раз.' })
    }
    // Yandex did not answer: the lead is let through, as sign-in is.
    if (verdict.kind === 'unavailable') log(`lead_captcha_unavailable reason=${verdict.reason}`)
  }

  const now = deps.now?.() ?? new Date()
  // An IPv6 address counts by its /64; without a trusted address (local development) all
  // leads share one count.
  const ipHash = leadAddressHash(deps.secret, clientRateKey(request.headers))
  const recent = await deps.prisma.lead.count({
    where: { ipHash, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  })
  if (recent >= LEADS_PER_ADDRESS_PER_HOUR) {
    log('lead_refused reason=limit')
    return answer(429, { message: 'Заявок с этого адреса слишком много. Попробуйте через час.' })
  }

  const created = await deps.prisma.$transaction(async (tx) => {
    const row = await tx.lead.create({
      data: {
        phone: lead.phone,
        site: lead.site,
        consentVersion: legalDocumentFor('pii_processing').version,
        source: 'landing',
        ipHash,
        createdAt: now,
      },
      select: { id: true, number: true },
    })
    await enqueueOutbox(tx, {
      topic: 'leads',
      type: 'lead.send',
      payload: { leadId: row.id },
      dedupeKey: `lead:${row.id}:send`,
    })
    return row
  })
  log(`lead_created number=${created.number}`)
  return answer(200, { ok: true })
}
