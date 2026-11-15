import { Inject } from '@nestjs/common'
import { Ctx } from '@nestjs/microservices'
import { McpController, Tool, type McpContext } from '@rekog/mcp-nest'
import type { BrowserController } from '@repo/domain'
import { z } from 'zod'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import { MCP_REQUEST_ACCESS, type McpRequest } from '../access/mcp-request.ts'
import type { McpBrowserTasks } from './browser-tasks.ts'
import { MCP_BROWSER_TASKS } from './site-info.tokens.ts'

/**
 * The browser of a chat as the agent is told it: who drives it. A chat has no site
 * (docs/plan/83-remove-projects.md, БП1), so `siteUrl` and `startPath` are always null.
 */
export interface SiteBrowserInfo {
  siteUrl: null
  startPath: null
  controller: BrowserController | null
}

/**
 * What the agent is told: a chat has no site, so the stack and addresses are null; the tool stays
 * so the list of a turn is never empty (docs/plan/61-chats-first.md, §5.5).
 */
export function siteInfoOf(_access: McpTurnAccess, browser: SiteBrowserInfo | null = null) {
  return { stack: null, url: null, siteUrl: null, browser }
}

@McpController()
export class McpToolsController {
  constructor(@Inject(MCP_BROWSER_TASKS) private readonly browserTasks: McpBrowserTasks) {}

  @Tool({
    name: 'site_info',
    description:
      'Read what this chat has: there is no site, so stack and url are null. For a chat with the browser, browser: who controls it now (agent or user; null — not started: it starts with your first web_* call).',
    parameters: z.strictObject({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  })
  async siteInfo(@Ctx() context: McpContext) {
    const access = context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
    if (!access)
      return { isError: true, content: [{ type: 'text', text: 'MCP authorization is required' }] }
    let browser: SiteBrowserInfo | null = null
    if (access.requirements.browser)
      try {
        browser = {
          siteUrl: null,
          startPath: null,
          controller: await this.browserTasks.controller(access.taskId),
        }
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: 'The browser of the task cannot be read now' }],
        }
      }
    // No credentials, internal ids or third-party content go to the agent.
    return { content: [{ type: 'text', text: JSON.stringify(siteInfoOf(access, browser)) }] }
  }
}
