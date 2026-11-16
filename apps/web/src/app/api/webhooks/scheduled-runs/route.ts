import { prisma } from '@repo/db'
import { startScheduledRun } from '@repo/trpc'

import { env } from '@/env'
import { chatServices } from '@/server/chat-services'
import { handleScheduleIntake } from '@/server/schedule-intake'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The runs of scheduled tasks, posted by core (docs/plan/82-scheduled-tasks.md, §4.3). */
export function POST(request: Request): Promise<Response> {
  return handleScheduleIntake(request, {
    secret: env.web().scheduleIntakeSecret,
    start: async ({ runId }) => {
      const chat = chatServices()
      if (chat === null) throw new Error('Dialogs are not set up')
      return startScheduledRun(prisma, chat, { runId, now: new Date() })
    },
  })
}
