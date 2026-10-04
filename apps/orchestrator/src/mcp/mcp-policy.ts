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

import { restoreArgumentsSchema, wpRestArgumentsSchema } from './mcp-content.ts'

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
  contentTools?: boolean
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
export function mcpBodyAllowed(body: unknown, contentTools = false): boolean {
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
      (contentTools && contentCall.safeParse(request.params).success)
    )
  return true
}

export function mcpErrorId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const parsed = rpcId.safeParse((body as { id?: unknown }).id)
  return parsed.success ? parsed.data : null
}
