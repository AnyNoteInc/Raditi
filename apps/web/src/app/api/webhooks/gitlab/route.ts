import { prisma } from '@repo/db'

import { env } from '@/env'
import { handleGitlabWebhook } from '@/server/git-webhooks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The hook core made on a GitLab project (docs/plan/84-projects.md, ПР17; slice 84.26): a hint for
 * core, checked by the secrets derived from REPO_CONFIRM_SECRET.
 */
export function POST(request: Request): Promise<Response> {
  return handleGitlabWebhook(request, {
    prisma,
    now: () => new Date(),
    rootSecret: rootSecret(),
  })
}

/** null — the git settings do not parse or carry no secret of the cards: the route answers 404. */
function rootSecret(): string | null {
  try {
    return env.git().repoConfirmSecret
  } catch {
    return null
  }
}
