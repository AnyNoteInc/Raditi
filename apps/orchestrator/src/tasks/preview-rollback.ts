import {
  excludeTurnDbOperations,
  requestPreviewSync,
  taskHasProductionWrites,
  type PrismaClient,
} from '@repo/db'
import { conflict, type SiteLeaseFence, type TurnContentRollback } from '@repo/domain'

/**
 * The undo of a turn's content before the turn that replaces it (spec §8, «Изменить»/«Попробовать
 * ещё»; docs/plan/53-chat-preview-release.md, Р3, Р22): a turn writes content only into the
 * dialog's preview, so its writes leave the plan (`excluded`) and the preview is rebuilt to the
 * last candidate. A turn that wrote the production site itself (the content path before Р3)
 * cannot be undone from core — that is the host undo of the `mcp` role, whose channel from core
 * (N8) is not there yet: the replacement is refused before its sandbox.
 */
export class PreviewTurnRollback implements TurnContentRollback {
  constructor(private readonly db: Pick<PrismaClient, '$queryRaw' | '$transaction'>) {}

  async rollback(input: { fence: SiteLeaseFence; turn: number }): Promise<void> {
    const { taskId } = input.fence
    if (await taskHasProductionWrites(this.db, taskId, { turnNo: input.turn }))
      throw conflict('The replaced turn wrote the production site and cannot be undone here')
    await this.db.$transaction(async (tx) => {
      await excludeTurnDbOperations(tx, { taskId, turnNo: input.turn })
      const standing = await tx.taskCandidate.findFirst({
        where: { taskId, status: { in: ['current', 'stale'] } },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      })
      await requestPreviewSync(tx, { taskId, revision: standing?.revision ?? 0 })
    })
  }
}
