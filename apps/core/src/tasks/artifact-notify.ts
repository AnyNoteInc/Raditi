import { Logger } from '@nestjs/common'
import { artifactRole, type PrismaClient } from '@repo/db'
import type { ArtifactNotifyJob } from '@repo/domain'

import { LETTER_PAUSE_MS, type NotificationDelivery } from './notification-delivery.ts'

// A notice of an artifact (docs/plan/88-artifacts.md, Ар54): someone opened one to the reader, a
// new comment in a thread of all, the agent answered their note, another person changed theirs.
// Told only while the reader still has access; «изменил(а)» at most once in LETTER_PAUSE_MS per
// artifact and reader — a series of edits is one notice.

export class ArtifactNotify {
  readonly #logger = new Logger('ArtifactNotify')

  constructor(
    private readonly deps: {
      db: Pick<PrismaClient, '$queryRaw' | 'chatNotification'>
      delivery: Pick<NotificationDelivery, 'deliver'>
      now?: () => Date
    },
  ) {}

  async run(job: ArtifactNotifyJob): Promise<void> {
    const { db, delivery } = this.deps
    const now = this.deps.now?.() ?? new Date()
    if (job.actorUserId === job.userId) return
    const role = await artifactRole(db, { artifactId: job.artifactId, userId: job.userId })
    if (role === null) return
    if (job.kind === 'artifact_changed') {
      const recent = await db.chatNotification.count({
        where: {
          userId: job.userId,
          artifactId: job.artifactId,
          kind: job.kind,
          createdAt: { gt: new Date(now.getTime() - LETTER_PAUSE_MS) },
        },
      })
      if (recent > 0) return
    }
    const answer = await delivery.deliver({
      userId: job.userId,
      kind: job.kind,
      chat: null,
      schedule: null,
      artifact: { id: job.artifactId, actorUserId: job.actorUserId },
      path: `/artifacts/${job.artifactId}`,
      letter: true,
      telegram: null,
    })
    this.#logger.log(`artifact_notify kind=${job.kind} answer=${answer}`)
  }
}
