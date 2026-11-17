import { prisma } from '@repo/db'

import { env } from '@/env'
import { handleGithubWebhook } from '@/server/git-webhooks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The webhook of the GitHub App (docs/plan/84-projects.md, ПР17; slice 84.26): a hint for core. */
export function POST(request: Request): Promise<Response> {
  return handleGithubWebhook(request, {
    prisma,
    now: () => new Date(),
    webhookSecret: gitWebhookSecret(),
  })
}

/** null — the git settings do not parse or no GitHub App is set: the route answers 404. */
function gitWebhookSecret(): string | null {
  try {
    return env.git().githubApp?.webhookSecret ?? null
  } catch {
    return null
  }
}
