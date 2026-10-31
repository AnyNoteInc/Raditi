import { Inject } from '@nestjs/common'
import { Ctx } from '@nestjs/microservices'
import { McpController, Tool, type McpContext } from '@rekog/mcp-nest'
import {
  isPreviewServing,
  previewOrigin,
  requirementsOf,
  type BrowserController,
  type PreviewAddress,
} from '@repo/domain'
import { z } from 'zod'

import { siteAccessOf, type McpTurnAccess } from '../access/mcp-access.ts'
import { MCP_REQUEST_ACCESS, type McpRequest } from '../access/mcp-request.ts'
import type { McpBrowserTasks } from './browser-tasks.ts'
import { MCP_BROWSER_TASKS } from './site-info.tokens.ts'

/** Where previews answer (PREVIEW_BASE_DOMAIN and the rest); null — they are not configured. */
export const MCP_PREVIEW_ADDRESS = Symbol('MCP_PREVIEW_ADDRESS')

/**
 * The browser of a task as the agent is told it: the site, where it starts, who drives it.
 * Without a site `siteUrl` and `startPath` are null.
 */
export interface SiteBrowserInfo {
  siteUrl: string | null
  startPath: string | null
  controller: BrowserController | null
}

/**
 * What the agent is told of its site. A dialog with a preview (docs/plan/53-chat-preview-
 * release.md, Р3, Р21): `url` is the preview's own address while it serves — where the browser
 * tools go — and null otherwise; `siteUrl` is the site's address, the one links inside content
 * keep (the preview's database is a copy of the site's, Р15), never a place to write. A dialog
 * without one (previews are not configured): the site, as before. A chat without a site: nulls,
 * and the tool stays, so the list of a turn is never empty (docs/plan/61-chats-first.md, §5.5).
 */
export function siteInfoOf(
  access: McpTurnAccess,
  address: PreviewAddress | null,
  browser: SiteBrowserInfo | null = null,
) {
  if (access.siteId === null) return { stack: null, url: null, siteUrl: null, browser }
  const preview = access.preview
  // A browser task (docs/plan/57-browser-tasks.md, Б20): its browser works on the site itself.
  const session = browser === null ? {} : { browser }
  if (!preview) return { url: access.url, stack: access.stack, ...session }
  return {
    url:
      address && isPreviewServing(preview.status) ? previewOrigin(preview.hostname, address) : null,
    siteUrl: access.url,
    stack: access.stack,
    preview: preview.status,
    // What a release carries of the database of this site (docs/plan/53, «Операции БД и
    // миграции»): the kinds the preview's last build found writable.
    database: { operations: preview.dbKinds ?? ['content_update'] },
    ...session,
  }
}

@McpController()
export class McpToolsController {
  constructor(
    @Inject(MCP_PREVIEW_ADDRESS) private readonly previews: PreviewAddress | null,
    @Inject(MCP_BROWSER_TASKS) private readonly browserTasks: McpBrowserTasks,
  ) {}

  @Tool({
    name: 'site_info',
    description:
      "Read the stack of the site of this turn and its addresses: url — where this dialog's preview answers (null while it is not ready; the site itself where there are no previews), siteUrl — the site's own address, which links inside content keep; database.operations — what of the database a release carries here. For a task in the browser, browser: the site, the path its browser starts at and who controls it now (agent or user; null — not open).",
    parameters: z.strictObject({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  })
  async siteInfo(@Ctx() context: McpContext) {
    const access = context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
    if (!access)
      return { isError: true, content: [{ type: 'text', text: 'MCP authorization is required' }] }
    let browser: SiteBrowserInfo | null = null
    if (requirementsOf(access).browser)
      try {
        const site = siteAccessOf(access)
        browser = {
          siteUrl: access.url,
          startPath: site && this.browserTasks.startPath(site),
          controller: await this.browserTasks.controller(access.taskId),
        }
      } catch {
        return {
          isError: true,
          content: [{ type: 'text', text: 'The browser of the task cannot be read now' }],
        }
      }
    // No credentials, internal ids, site owner or third-party content go to the agent.
    return {
      content: [{ type: 'text', text: JSON.stringify(siteInfoOf(access, this.previews, browser)) }],
    }
  }
}
