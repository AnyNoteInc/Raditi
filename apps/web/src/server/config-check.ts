import 'server-only'

import { dbConfigFromEnv } from '@repo/db'

import { env } from '@/env'

type Sections = Record<string, () => unknown>

/** Every settings section web reads, as it reads them. */
const sections: Sections = {
  web: env.web,
  auth: env.auth,
  storage: env.storage,
  vault: env.vault,
  // Payments switched off is valid; half of the shop credentials, a development-only variable
  // (YOOKASSA_API_URL, YOOKASSA_WEBHOOK_ALLOWLIST) or a shop in production that does not say
  // whether its autopayments are approved (YOOKASSA_AUTOPAYMENTS) is not.
  yookassa: env.yookassa,
  db: () => dbConfigFromEnv(process.env),
}

/** Names of the sections that fail to parse, in order; never their messages. */
export function brokenSections(read: Sections = sections): string[] {
  return Object.entries(read).flatMap(([name, section]) => {
    try {
      section()
      return []
    } catch {
      return [name]
    }
  })
}
