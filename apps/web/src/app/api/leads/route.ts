import { prisma } from '@repo/db'

import { env } from '@/env'
import { withBodyLimit } from '@/server/body-limit'
import { handleLeadRequest, MAX_LEAD_BODY_BYTES } from '@/server/leads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A lead from the landing (docs/plan/65-landing-platforms-leads.md). */
export const POST = withBodyLimit(MAX_LEAD_BODY_BYTES, (request) => {
  const auth = env.auth()
  return handleLeadRequest(request, {
    prisma,
    appUrl: env.web().appUrl,
    secret: auth.secret,
    captchaServerKey: auth.captcha?.serverKey ?? null,
  })
})
