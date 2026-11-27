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
  // A git app set in part, a short secret of the cards or a fake of a stand in production
  // (docs/plan/84-projects.md, §4.5).
  git: env.git,
  // A short secret of the cards of VK (docs/plan/99-vk-community.md, §3.3).
  vk: env.vk,
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
