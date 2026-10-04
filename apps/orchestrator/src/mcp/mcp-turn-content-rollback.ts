import { contentUndoFenceSchema, leaseLost, type TurnContentRollback } from '@repo/domain'

import type { McpContentService } from './mcp-content.ts'
import type { PostgresMcpJournal } from './mcp-journal.ts'

/**
 * The undo before a replacement run, in the process of the role (the channel from core is a
 * later P6 gate). It is admitted by the fence of the turn lease the new turn holds and by its
 * saved plan — never by a credential of the turn: none is passed here.
 */
export class McpTurnContentRollback implements TurnContentRollback {
  constructor(
    private readonly journal: PostgresMcpJournal,
    private readonly content: McpContentService,
  ) {}

  async rollback(input: Parameters<TurnContentRollback['rollback']>[0]): Promise<void> {
    const fence = contentUndoFenceSchema.safeParse(input.fence)
    if (!fence.success || fence.data.operation !== 'turn')
      throw leaseLost('Content rollback does not own the current turn')
    const scope = await this.journal.hostScope(fence.data, fence.data.taskId)
    for (const target of await this.journal.replacementTargets(scope, input.turn))
      await this.content.rollbackTurn(scope, target)
  }
}
