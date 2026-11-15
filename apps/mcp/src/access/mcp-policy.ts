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
  requirementsOf,
} from '@repo/domain'
import { z } from 'zod'

import {
  browserClickArgumentsSchema,
  browserExpectArgumentsSchema,
  browserFillArgumentsSchema,
  browserNavigateArgumentsSchema,
  browserNoArgumentsSchema,
  browserRunChecksArgumentsSchema,
} from '../browser/browser-arguments.ts'
import { rpcId } from '../common/json-rpc.ts'
import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import {
  dbSchemaArgumentsSchema,
  restoreArgumentsSchema,
  wpRestArgumentsSchema,
} from '../content/content-arguments.ts'
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
  scheduleArgumentsAdmitted,
  scheduleCreateArgumentsSchema,
  scheduleDeleteArgumentsSchema,
  scheduleListArgumentsSchema,
  scheduleUpdateArgumentsSchema,
} from '../schedule/schedule-arguments.ts'
import { webSearchArgumentsSchema } from '../search/search-arguments.ts'
import { closedPreviewStatuses, type McpTurnAccess } from './mcp-access.ts'

export const MCP_SECURITY = Symbol('MCP_SECURITY')
export const MCP_BODY_LIMIT = 100 * 1024
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const siteInfoCall = z.strictObject({
  name: z.literal('site_info'),
  arguments: z.strictObject({}).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
})
const contentCall = z.discriminatedUnion('name', [
  z.strictObject({
    name: z.literal('wp_rest'),
    arguments: wpRestArgumentsSchema,
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({
    name: z.literal('restore'),
    arguments: restoreArgumentsSchema,
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
])
const schemaCall = z.strictObject({
  name: z.literal('db_schema'),
  arguments: dbSchemaArgumentsSchema,
  _meta: z.record(z.string(), z.unknown()).optional(),
})
const call = <Name extends string, Arguments extends z.ZodType>(name: Name, args: Arguments) =>
  z.strictObject({
    name: z.literal(name),
    arguments: args,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
const browserCall = z.discriminatedUnion('name', [
  call('browser_navigate', browserNavigateArgumentsSchema),
  call('browser_click', browserClickArgumentsSchema),
  call('browser_fill', browserFillArgumentsSchema),
  call('browser_expect', browserExpectArgumentsSchema),
  call('browser_snapshot', browserNoArgumentsSchema.optional()),
  call('browser_screenshot', browserNoArgumentsSchema.optional()),
  call('browser_console', browserNoArgumentsSchema.optional()),
  call('browser_network', browserNoArgumentsSchema.optional()),
  call('browser_run_checks', browserRunChecksArgumentsSchema),
])
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
// each tool its own branch, or the body is refused. The reads for every turn; what changes a page
// or a site of pages — live for every visitor once the turn ends — only for a turn its client
// watches (docs/plan/82-scheduled-tasks.md, Зп28, Зп32).
const pagesCall = z.discriminatedUnion('name', [
  call('page_list', pageListArgumentsSchema.optional()),
  call('page_tree', pageTreeArgumentsSchema),
  call('page_read', pageReadArgumentsSchema),
  call('page_files', pageFilesArgumentsSchema),
])
const pagesChangeCall = z.discriminatedUnion('name', [
  call('page_publish', pagePublishToolArgumentsSchema),
  call('page_edit', pageEditArgumentsSchema),
  call('page_update', pageUpdateArgumentsSchema),
  call('page_delete', pageDeleteArgumentsSchema),
  call('page_restore', pageRestoreArgumentsSchema),
  call('page_file_put', pageFilePutArgumentsSchema),
  call('page_file_delete', pageFileDeleteArgumentsSchema),
])
// The scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп31, Зп32): the list for every turn, the
// changes only for a turn its client watches. A schedule with runs closer than an hour is the
// tool's own refusal (`SCHEDULE_TOO_OFTEN`), not a request refused as a whole.
const admittedBy = (schema: z.ZodType) =>
  z.record(z.string(), z.unknown()).refine((args) => scheduleArgumentsAdmitted(schema, args))
const scheduleCall = call('schedule_list', scheduleListArgumentsSchema.optional())
const scheduleChangeCall = z.discriminatedUnion('name', [
  call('schedule_create', admittedBy(scheduleCreateArgumentsSchema)),
  call('schedule_update', admittedBy(scheduleUpdateArgumentsSchema)),
  call('schedule_delete', admittedBy(scheduleDeleteArgumentsSchema)),
])
/** The names of the tools a pass without its client is not offered (`mcpToolFamiliesOf`). */
const unattendedWithheldTools: ReadonlySet<string> = new Set(
  [pagesChangeCall, scheduleChangeCall].flatMap((union) =>
    union.options.map((option) => option.shape.name.value),
  ),
)
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
  /** The content profile is on: wp_rest and restore, into the preview of the dialog. */
  contentTools?: boolean
  /**
   * The P6 path: content of a dialog without a preview row goes to the site itself. Only where
   * previews are not configured (the local stands); a dialog with a preview never writes there.
   */
  siteContent?: boolean
  /** The browser profile is on: browser_* on the preview of the dialog. */
  browserTools?: boolean
  /**
   * The browser worker is configured (BROWSER_WORKER_URL): web_* for a task that needs a
   * browser, on the site itself (docs/plan/57-browser-tasks.md, Б20). A product path, open in
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
   * where the pages are configured (PAGES_BASE_DOMAIN); their changes only where the client
   * watches (docs/plan/82-scheduled-tasks.md, Зп28, Зп32).
   */
  pagesTools?: boolean
  /** The documents of a workspace (docs/plan/69-pages.md, Ст21): every turn, every composition. */
  docsTools?: boolean
  /**
   * The scheduled tasks of the chat's author (docs/plan/82-scheduled-tasks.md, Зп31): every turn,
   * every composition; their changes only where the client watches (Зп32).
   */
  scheduleTools?: boolean
}

/** The security of the role's MCP endpoint, as the profiles of its configuration make it. */
export function mcpSecurityOf(config: McpConfig): McpSecurity {
  const { content, siteContent, browser, worker } = mcpProfilesOf(config)
  return {
    allowedHosts: config.allowedHosts,
    allowLocalOrigin: config.appEnv !== 'production',
    ...(content ? { contentTools: true, siteContent } : {}),
    ...(browser ? { browserTools: true } : {}),
    ...(worker ? { webTools: true } : {}),
    searchTools: true,
    docsTools: true,
    ...(config.pages ? { pagesTools: true } : {}),
    scheduleTools: true,
  }
}

/**
 * Tool families beside site_info; a request sees and calls only those of its scope. `content` —
 * on a preview, where its last build found any kind of a plan a release could carry, or where no
 * build has said yet (docs/plan/62-site-stacks.md, Т37); `schema` — `db_schema`, where the
 * preview's last build found tables of the platform writable, or where no build has said yet:
 * the CLI asks for its tools once, when its turn starts, and the first turn of a dialog starts
 * while its preview is still being built. Each call checks the kinds of the preview as built
 * then (`DB_OPERATION_NOT_ALLOWED`). `web` — the cloud browser of a task on the site itself
 * (docs/plan/57-browser-tasks.md, Б20); `browser` is the preview's. `search` — the web search of
 * any turn, with a site or without, while its key is in Vault. `pages` — the pages of the
 * workspace read, any turn, while the pages are configured (docs/plan/69-pages.md, Ст20);
 * `pages_changes` — their publication and every change, only by a turn the client watches: they
 * are live for every visitor once the turn ends (docs/plan/82-scheduled-tasks.md, Зп28, Зп32);
 * `docs` — its documents, any turn (Ст21). `schedule` — the scheduled tasks of the chat's author,
 * read by any turn; `schedule_changes` — their creation, change and deletion, only by a turn the
 * client watches: a pass of a scheduled run without its client sees the lists alone (Зп31, Зп32).
 */
export const mcpToolFamilies = [
  'content',
  'browser',
  'schema',
  'web',
  'search',
  'docs',
  'pages',
  'pages_changes',
  'schedule',
  'schedule_changes',
] as const
export type McpToolFamily = (typeof mcpToolFamilies)[number]

/** A preview that is gone for the dialog, or never was there to work on (Р4, Р16). */
const closedPreview = new Set<string>(closedPreviewStatuses)
export const isClosedPreview = (preview: NonNullable<McpTurnAccess['preview']>) =>
  closedPreview.has(preview.status)

/** `kinds` of the preview's last build; undefined — no build has said yet (each call checks). */
const kindsAllowContent = (preview: NonNullable<McpTurnAccess['preview']>) =>
  preview.dbKinds === undefined || preview.dbKinds.length > 0

/**
 * What a request of this scope is offered (Р3, Р4, Р21): content tools only for a preview with
 * its own database a release could carry a change of (Т37) — or, where previews are not
 * configured, the P6 path of a dialog without one; the browser only on a preview. Each call checks the preview again under its own lock.
 * A task without a repository changes its site through the browser alone (docs/plan/57, Б1):
 * no content tools, whatever the profile; the `web` tools go to a task that needs a browser
 * where the worker is configured, each call admitted again with its session (Б20).
 */
export function mcpToolFamiliesOf(access: McpTurnAccess, security: McpSecurity): McpToolFamily[] {
  const preview = access.preview
  const open = preview !== null && !isClosedPreview(preview)
  const requirements = requirementsOf(access)
  const families: McpToolFamily[] = []
  if (
    security.contentTools &&
    requirements.repository &&
    (preview === null
      ? security.siteContent
      : open && preview.database && kindsAllowContent(preview))
  )
    families.push('content')
  if (
    families.includes('content') &&
    preview !== null &&
    (preview.dbKinds === undefined || preview.dbKinds.includes('schema_migration'))
  )
    families.push('schema')
  if (security.browserTools && open) families.push('browser')
  if (security.webTools && requirements.browser) families.push('web')
  if (security.searchTools) families.push('search')
  if (security.docsTools) families.push('docs')
  if (security.pagesTools) {
    families.push('pages')
    if (!access.unattended) families.push('pages_changes')
  }
  if (security.scheduleTools) {
    families.push('schedule')
    if (!access.unattended) families.push('schedule_changes')
  }
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

/** The parsed request within its bounds, before the SDK recurses: no prototype keys. */
function bounded(body: unknown): boolean {
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
  return true
}

/** Bound the parsed request before the SDK recurses; no source values enter error messages. */
export function mcpBodyAllowed(body: unknown, families: readonly McpToolFamily[] = []): boolean {
  if (!bounded(body)) return false
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
      (families.includes('content') && contentCall.safeParse(request.params).success) ||
      (families.includes('schema') && schemaCall.safeParse(request.params).success) ||
      (families.includes('browser') && browserCall.safeParse(request.params).success) ||
      (families.includes('web') && webCall.safeParse(request.params).success) ||
      (families.includes('search') && searchCall.safeParse(request.params).success) ||
      (families.includes('docs') && docsCall.safeParse(request.params).success) ||
      (families.includes('pages') && pagesCall.safeParse(request.params).success) ||
      (families.includes('pages_changes') && pagesChangeCall.safeParse(request.params).success) ||
      (families.includes('schedule') && scheduleCall.safeParse(request.params).success) ||
      (families.includes('schedule_changes') &&
        scheduleChangeCall.safeParse(request.params).success)
    )
  return true
}

/**
 * What a call that needs the client's word answers in a pass without the client (docs/plan/82-
 * scheduled-tasks.md, Зп32): nobody is there to have given it — whatever the instructions of the run
 * say, they are no consent (Зп28). The same words answer a tool of a project's MCP server through
 * the relay (`SkillRelay`). The agent reads the code and these words as the result of its tool.
 */
export const MCP_UNATTENDED_REFUSAL = Object.freeze({
  code: 'SCHEDULE_FORBIDDEN',
  message:
    "This pass runs on a schedule without the client: nobody can confirm a change now. Change no scheduled task, publish or change no page, call no tool of the project's MCP servers and delete nothing; prepare it and ask the client once at the end of your answer.",
})

const confirmingCall = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcId,
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).refine((args) => 'confirmedByClient' in args),
  }),
})

/** A well-formed call of a tool a pass without its client is not offered, by its name alone. */
const withheldCall = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcId,
  method: z.literal('tools/call'),
  params: z.object({ name: z.string().refine((name) => unattendedWithheldTools.has(name)) }),
})

/**
 * A well-formed call that needs the client's word (Зп32): of any tool whose arguments carry
 * `confirmedByClient` — `schedule_*`, `page_delete`, `page_file_delete` — however they say it, or of
 * a tool a pass without its client is not offered — the changes of the scheduled tasks and of the
 * pages (`page_publish`, `page_edit` and the rest), whatever its arguments. In a pass without the
 * client the guard answers it with `MCP_UNATTENDED_REFUSAL` before any tool sees it.
 */
export function mcpCallNeedsClient(body: unknown): boolean {
  return (
    bounded(body) &&
    (confirmingCall.safeParse(body).success || withheldCall.safeParse(body).success)
  )
}
