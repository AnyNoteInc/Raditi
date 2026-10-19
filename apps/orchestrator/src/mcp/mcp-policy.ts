import { isIP } from 'node:net'

import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  InitializedNotificationSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/core'
import { z } from 'zod'

import type { McpAccess } from './mcp-access.ts'
import {
  browserClickArgumentsSchema,
  browserExpectArgumentsSchema,
  browserFillArgumentsSchema,
  browserNavigateArgumentsSchema,
  browserNoArgumentsSchema,
  browserRunChecksArgumentsSchema,
} from './mcp-browser-tools.ts'
import {
  dbSchemaArgumentsSchema,
  restoreArgumentsSchema,
  wpRestArgumentsSchema,
} from './mcp-content.ts'

export const MCP_SECURITY = Symbol('MCP_SECURITY')
export const MCP_BODY_LIMIT = 100 * 1024
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
const rpcId = z.union([z.string().min(1).max(128), z.number().int().safe()])
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
}

/**
 * Tool families beside site_info; a request sees and calls only those of its scope. `schema` —
 * `db_schema`, where the preview's last build found tables of the platform writable, or where
 * no build has said yet: the CLI asks for its tools once, when its turn starts, and the first
 * turn of a dialog starts while its preview is still being built. Each call checks the kinds of
 * the preview as built then (`DB_OPERATION_NOT_ALLOWED`).
 */
export const mcpToolFamilies = ['content', 'browser', 'schema'] as const
export type McpToolFamily = (typeof mcpToolFamilies)[number]

/** A preview that is gone for the dialog, or never was there to work on (Р4, Р16). */
const closedPreview = new Set(['unavailable', 'destroyed'])

/**
 * What a request of this scope is offered (Р3, Р4, Р21): content tools only for a preview with
 * its own database — or, where previews are not configured, the P6 path of a dialog without
 * one; the browser only on a preview. Each call checks the preview again under its own lock.
 */
export function mcpToolFamiliesOf(access: McpAccess, security: McpSecurity): McpToolFamily[] {
  const preview = access.preview
  const open = preview !== null && !closedPreview.has(preview.status)
  const families: McpToolFamily[] = []
  if (security.contentTools && (preview === null ? security.siteContent : open && preview.database))
    families.push('content')
  if (
    families.includes('content') &&
    preview !== null &&
    (preview.dbKinds === undefined || preview.dbKinds.includes('schema_migration'))
  )
    families.push('schema')
  if (security.browserTools && open) families.push('browser')
  return families
}

/** Hostnames only: sandbox-gw rewrites Host to the configured upstream's host. */
export function parseMcpHosts(raw: string | undefined, production: boolean): string[] {
  if (!raw?.trim()) {
    if (production) throw new Error('MCP_ALLOWED_HOSTS: required for the mcp role in production')
    // Same hosts as the LLM_GATEWAY_HOSTS dev default: on Docker Desktop sandbox-gw sends
    // Host: host.docker.internal for both upstreams.
    return ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']
  }
  const names = raw.split(',').map((value) => value.trim().toLowerCase())
  for (const name of names) {
    const ip = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
    if (isIP(ip) === 6 && ip !== name) continue
    if (isIP(name) === 4) continue
    if (
      name.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
        name,
      )
    )
      throw new Error('MCP_ALLOWED_HOSTS: expected exact hostnames or IP addresses, without ports')
  }
  // WHATWG URL canonicalises IPv6 in incoming Host headers. Apply the same rule to config
  // before comparing or deduplicating equivalent full and compressed spellings.
  try {
    return [...new Set(names.map((name) => new URL(`http://${name}`).hostname.toLowerCase()))]
  } catch {
    throw new Error('MCP_ALLOWED_HOSTS: expected exact hostnames or IP addresses, without ports')
  }
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
      (families.includes('browser') && browserCall.safeParse(request.params).success)
    )
  return true
}

export function mcpErrorId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const parsed = rpcId.safeParse((body as { id?: unknown }).id)
  return parsed.success ? parsed.data : null
}
