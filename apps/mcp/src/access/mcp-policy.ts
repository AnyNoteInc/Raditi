import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  InitializedNotificationSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/core'
import {
  browserToolArgumentSchemas,
  browserToolNames,
  docCreateArgumentsSchema,
  docFinishArgumentsSchema,
  docReadArgumentsSchema,
  docSectionMoveArgumentsSchema,
  docSectionRemoveArgumentsSchema,
  docSectionWriteArgumentsSchema,
} from '@repo/domain'
import { z } from 'zod'

import { rpcId } from '../common/json-rpc.ts'
import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import {
  pageDeleteArgumentsSchema,
  pageEditArgumentsSchema,
  pageFileDeleteArgumentsSchema,
  pageFilePutArgumentsSchema,
  pageFilesArgumentsSchema,
  pageListArgumentsSchema,
  pagePublishToolArgumentsSchema,
  pageReadArgumentsSchema,
  pageRestoreArgumentsSchema,
  pageTreeArgumentsSchema,
  pageUpdateArgumentsSchema,
} from '../pages/pages-arguments.ts'
import {
  memoryForgetArgumentsSchema,
  memoryListArgumentsSchema,
  memorySaveArgumentsSchema,
  memoryUpdateArgumentsSchema,
} from '../memory/memory-arguments.ts'
import { webSearchArgumentsSchema } from '../search/search-arguments.ts'
import type { McpTurnAccess } from './mcp-access.ts'

export const MCP_SECURITY = Symbol('MCP_SECURITY')
export const MCP_BODY_LIMIT = 100 * 1024
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const siteInfoCall = z.strictObject({
  name: z.literal('site_info'),
  arguments: z.strictObject({}).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
})
const call = <Name extends string, Arguments extends z.ZodType>(name: Name, args: Arguments) =>
  z.strictObject({
    name: z.literal(name),
    arguments: args,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
/**
 * The `web` tools of a browser task (docs/plan/57-browser-tasks.md, Б20, §3.7), each with the
 * domain's own arguments: the worker checks the same schemas again. Absent arguments are `{}`,
 * as mcp-nest passes them on: a tool whose arguments are all optional may go without them.
 */
const webCall = z
  .strictObject({
    name: z.enum(browserToolNames),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (request) =>
      browserToolArgumentSchemas[request.name].safeParse(request.arguments ?? {}).success,
  )
const searchCall = call('search_web', webSearchArgumentsSchema)
const docsCall = z.discriminatedUnion('name', [
  call('doc_create', docCreateArgumentsSchema),
  call('doc_section_write', docSectionWriteArgumentsSchema),
  call('doc_section_remove', docSectionRemoveArgumentsSchema),
  call('doc_section_move', docSectionMoveArgumentsSchema),
  call('doc_read', docReadArgumentsSchema),
  call('doc_finish', docFinishArgumentsSchema),
])
// The pages of the workspace (docs/plan/69-pages.md, Ст20; docs/plan/73-pages-sites.md, Дер23):
// each tool its own branch, or the body is refused.
const pagesCall = z.discriminatedUnion('name', [
  call('page_publish', pagePublishToolArgumentsSchema),
  call('page_list', pageListArgumentsSchema.optional()),
  call('page_tree', pageTreeArgumentsSchema),
  call('page_read', pageReadArgumentsSchema),
  call('page_edit', pageEditArgumentsSchema),
  call('page_update', pageUpdateArgumentsSchema),
  call('page_delete', pageDeleteArgumentsSchema),
  call('page_restore', pageRestoreArgumentsSchema),
  call('page_file_put', pageFilePutArgumentsSchema),
  call('page_file_delete', pageFileDeleteArgumentsSchema),
  call('page_files', pageFilesArgumentsSchema),
])
// The memory of the chat (docs/plan/84-projects.md, §4.4): each tool its own branch.
const memoryCall = z.discriminatedUnion('name', [
  call('memory_list', memoryListArgumentsSchema.optional()),
  call('memory_save', memorySaveArgumentsSchema),
  call('memory_update', memoryUpdateArgumentsSchema),
  call('memory_forget', memoryForgetArgumentsSchema),
])
const envelope = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: rpcId.optional(),
  method: z.enum([
    'initialize',
    'ping',
    'tools/list',
    'tools/call',
    'notifications/initialized',
    'notifications/cancelled',
  ]),
  params: z.record(z.string(), z.unknown()).optional(),
})
const methodSchemas = {
  initialize: InitializeRequestSchema,
  ping: PingRequestSchema,
  'tools/list': ListToolsRequestSchema,
  'tools/call': CallToolRequestSchema,
  'notifications/initialized': InitializedNotificationSchema,
  'notifications/cancelled': CancelledNotificationSchema,
}

export interface McpSecurity {
  allowedHosts: readonly string[]
  allowLocalOrigin: boolean
  /**
   * The browser worker is configured (BROWSER_WORKER_URL): web_* for a chat that needs a
   * browser, on the open web (docs/plan/57-browser-tasks.md, Б20). A product path, open in
   * production too.
   */
  webTools?: boolean
  /**
   * `search_web` for every turn (spec §20, «Веб-поиск агента — 08.11.2026»): a product path,
   * like the worker's. The guard drops it while the key of the search is not in Vault.
   */
  searchTools?: boolean
  /**
   * The pages of a workspace (docs/plan/69-pages.md, Ст20): every turn, with a site or without,
   * where the pages are configured (PAGES_BASE_DOMAIN).
   */
  pagesTools?: boolean
  /** The documents of a workspace (docs/plan/69-pages.md, Ст21): every turn, every composition. */
  docsTools?: boolean
  /**
   * The memory of a chat (docs/plan/84-projects.md, ПР18): every composition, a turn whose chat has
   * its memory on.
   */
  memoryTools?: boolean
}

/** The security of the role's MCP endpoint, as the profiles of its configuration make it. */
export function mcpSecurityOf(config: McpConfig): McpSecurity {
  const { worker } = mcpProfilesOf(config)
  return {
    allowedHosts: config.allowedHosts,
    allowLocalOrigin: config.appEnv !== 'production',
    ...(worker ? { webTools: true } : {}),
    searchTools: true,
    docsTools: true,
    memoryTools: true,
    ...(config.pages ? { pagesTools: true } : {}),
  }
}

/**
 * Tool families beside site_info; a request sees and calls only those of its scope. `web` — the
 * cloud browser of a chat (docs/plan/57-browser-tasks.md, Б20); `search` — the web search of any
 * turn, while its key is in Vault; `docs` — the documents of the workspace, any turn
 * (docs/plan/69-pages.md, Ст21); `pages` — its pages, while the pages are configured (Ст20).
 */
export const mcpToolFamilies = ['web', 'search', 'docs', 'pages', 'memory'] as const
export type McpToolFamily = (typeof mcpToolFamilies)[number]

/** What a request of this scope is offered: `web` to a chat that needs a browser (Б20). */
export function mcpToolFamiliesOf(access: McpTurnAccess, security: McpSecurity): McpToolFamily[] {
  const families: McpToolFamily[] = []
  if (security.webTools && access.requirements.browser) families.push('web')
  if (security.searchTools) families.push('search')
  if (security.docsTools) families.push('docs')
  if (security.pagesTools) families.push('pages')
  // The memory of the chat while it is on (docs/plan/84-projects.md, ПР18).
  if (security.memoryTools && access.memory) families.push('memory')
  return families
}

export function mcpHeadersAllowed(
  headers: { host?: string; origin?: string },
  security: McpSecurity,
): boolean {
  if (!headers.host || /[\s/@\\?#]/.test(headers.host)) return false
  try {
    const host = new URL(`http://${headers.host}`)
    if (!security.allowedHosts.includes(host.hostname.toLowerCase())) return false
    if (!headers.origin) return true
    if (!security.allowLocalOrigin) return false
    const origin = new URL(headers.origin)
    return (
      ['http:', 'https:'].includes(origin.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === '/'
    )
  } catch {
    return false
  }
}

/** Bound the parsed request before the SDK recurses; no source values enter error messages. */
export function mcpBodyAllowed(body: unknown, families: readonly McpToolFamily[] = []): boolean {
  const pending = [{ value: body, depth: 1 }]
  let nodes = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > 5000 || depth > 16) return false
    if (value === null || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) return false
      pending.push({ value: child, depth: depth + 1 })
    }
  }
  const parsed = envelope.safeParse(body)
  if (!parsed.success) return false
  const request = parsed.data
  if (request.method.startsWith('notifications/')) {
    if (request.id !== undefined) return false
  } else if (request.id === undefined) return false
  // SDK errors include caller-supplied paths, even in initialize capabilities. Validate all
  // allowed methods with the installed SDK's schemas and discard its diagnostic details.
  if (!methodSchemas[request.method].safeParse(body).success) return false
  if (request.method === 'tools/call')
    return (
      siteInfoCall.safeParse(request.params).success ||
      (families.includes('web') && webCall.safeParse(request.params).success) ||
      (families.includes('search') && searchCall.safeParse(request.params).success) ||
      (families.includes('docs') && docsCall.safeParse(request.params).success) ||
      (families.includes('pages') && pagesCall.safeParse(request.params).success) ||
      (families.includes('memory') && memoryCall.safeParse(request.params).success)
    )
  return true
}
