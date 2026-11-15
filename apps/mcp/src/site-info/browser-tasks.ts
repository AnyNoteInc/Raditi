import { openBrowserSessionOfTask, type PrismaClient } from '@repo/db'
import type { BrowserController } from '@repo/domain'

/** What site_info tells of the cloud browser of a chat (docs/plan/57-browser-tasks.md, Б20). */
export interface McpBrowserTasks {
  /** Who controls the open browser session of the chat; null — none is open. */
  controller(taskId: string): Promise<BrowserController | null>
}

/**
 * The browser of a chat as PostgreSQL tells it: the session starts with the agent's first
 * `web_*` call (docs/plan/61-chats-first.md, К11).
 */
export function mcpBrowserTasksOf(deps: {
  db: Pick<PrismaClient, 'browserSession'>
}): McpBrowserTasks {
  return {
    controller: async (taskId) =>
      (await openBrowserSessionOfTask(deps.db, taskId))?.controller ?? null,
  }
}
