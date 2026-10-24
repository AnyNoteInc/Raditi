import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  InitializedNotificationSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/core'
import { browserToolArgumentSchemas, browserToolNames, requirementsOf } from '@repo/domain'
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
import type { McpAccess } from './mcp-access.ts'

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
  }
}

/**
 * Tool families beside site_info; a request sees and calls only those of its scope. `schema` —
 * `db_schema`, where the preview's last build found tables of the platform writable, or where
 * no build has said yet: the CLI asks for its tools once, when its turn starts, and the first
 * turn of a dialog starts while its preview is still being built. Each call checks the kinds of
 * the preview as built then (`DB_OPERATION_NOT_ALLOWED`). `web` — the cloud browser of a task
 * on the site itself (docs/plan/57-browser-tasks.md, Б20); `browser` is the preview's.
 */
export const mcpToolFamilies = ['content', 'browser', 'schema', 'web'] as const
export type McpToolFamily = (typeof mcpToolFamilies)[number]

/** A preview that is gone for the dialog, or never was there to work on (Р4, Р16). */
const closedPreview = new Set(['unavailable', 'destroyed'])

/**
 * What a request of this scope is offered (Р3, Р4, Р21): content tools only for a preview with
 * its own database — or, where previews are not configured, the P6 path of a dialog without
 * one; the browser only on a preview. Each call checks the preview again under its own lock.
 * A task without a repository changes its site through the browser alone (docs/plan/57, Б1):
 * no content tools, whatever the profile; the `web` tools go to a task that needs a browser
 * where the worker is configured, each call admitted again with its session (Б20).
 */
export function mcpToolFamiliesOf(access: McpAccess, security: McpSecurity): McpToolFamily[] {
  const preview = access.preview
  const open = preview !== null && !closedPreview.has(preview.status)
  const requirements = requirementsOf(access)
  const families: McpToolFamily[] = []
  if (
    security.contentTools &&
    requirements.repository &&
    (preview === null ? security.siteContent : open && preview.database)
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
      (families.includes('content') && contentCall.safeParse(request.params).success) ||
      (families.includes('schema') && schemaCall.safeParse(request.params).success) ||
      (families.includes('browser') && browserCall.safeParse(request.params).success) ||
      (families.includes('web') && webCall.safeParse(request.params).success)
    )
  return true
}
