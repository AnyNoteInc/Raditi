import { openBrowserSessionOfTask, type PrismaClient } from '@repo/db'
import type { BrowserController, SiteAdapter, SiteStack } from '@repo/domain'

import type { McpSiteScope } from '../access/mcp-access.ts'

/** What site_info tells of the cloud browser of a task (docs/plan/57-browser-tasks.md, Б20). */
export interface McpBrowserTasks {
  /** Where the task's browser starts on the site, by its stack's policy; null — none known. */
  startPath(scope: McpSiteScope): string | null
  /** Who controls the open browser session of the task; null — none is open. */
  controller(taskId: string): Promise<BrowserController | null>
}

/**
 * The browser of a task as PostgreSQL and the stack of its site tell it. Read for every
 * site_info whose task needs a browser, with or without the browser worker: the session is
 * core's (Б18), the start is the stack's policy — this names no CMS (rule 8).
 */
export function mcpBrowserTasksOf(deps: {
  db: Pick<PrismaClient, 'browserSession'>
  adapters: (stack: SiteStack) => Pick<SiteAdapter, 'browserTaskPolicy'>
}): McpBrowserTasks {
  return {
    startPath: (site) => {
      try {
        return deps.adapters(site.stack).browserTaskPolicy({ url: site.url }).startPath
      } catch {
        // A stack with no adapter yet has no start to name.
        return null
      }
    },
    controller: async (taskId) =>
      (await openBrowserSessionOfTask(deps.db, taskId))?.controller ?? null,
  }
}
