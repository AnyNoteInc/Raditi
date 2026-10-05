import type { PrismaClient } from '@repo/db'
import { contentUndoFenceSchema, DomainError, siteStacks, terminalTaskStatuses } from '@repo/domain'
import { z } from 'zod'

import { MCP_TOKEN_PATTERN, turnKeyHash } from '../llm/turn-key.ts'

/** Derived only from the admitted token and current assignment, never from tool arguments. */
export const mcpAccessSchema = z.strictObject({
  keyId: z.uuid(),
  taskId: z.uuid(),
  workspaceId: z.uuid(),
  siteId: z.uuid(),
  sessionId: z.string().min(1).max(64),
  turn: z.number().int().positive(),
  firstEpoch: z.number().int().positive(),
  epoch: z.number().int().positive(),
  stack: z.enum(siteStacks),
  url: z.url().refine((value) => {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    )
  }),
})
export type McpAccess = z.infer<typeof mcpAccessSchema>

/** What it takes to reach a site. The resolver of its content gateway reads nothing else. */
export type McpSiteScope = Pick<McpAccess, 'workspaceId' | 'siteId' | 'stack' | 'url'>
export const mcpSiteScopeSchema = mcpAccessSchema.pick({
  workspaceId: true,
  siteId: true,
  stack: true,
  url: true,
})

/**
 * The scope of the trusted host (spec §11): no turn key and no assignment. It is admitted by
 * the fence of the site lease its caller holds — a turn or a revert — and names the task whose
 * edits it returns: the holder itself or the task the holder reverts. The journal reads it from
 * the database by the fence and checks the fence again at every step; no MCP request carries it.
 */
export const mcpHostScopeSchema = mcpSiteScopeSchema
  .extend({ targetTaskId: z.uuid(), fence: contentUndoFenceSchema.strict() })
  .refine((scope) => scope.fence.siteId === scope.siteId)
export type McpHostScope = z.infer<typeof mcpHostScopeSchema>

export interface McpAccessStore {
  authenticate(token: string): Promise<McpAccess | null>
}
export const MCP_ACCESS = Symbol('MCP_ACCESS')
/** Never issued (tokens are 32 random bytes): health runs the real admission query with it. */
export const MCP_ACCESS_PROBE_TOKEN = `mcp_${'0'.repeat(64)}`
/** A Symbol cannot be supplied by a JSON body or an HTTP header. */
export const MCP_REQUEST_ACCESS = Symbol('MCP_REQUEST_ACCESS')

/** MCP needs only the paired hash, not Vault turns/ or any subscription credential. */
export class PostgresMcpAccess implements McpAccessStore {
  constructor(private readonly prisma: Pick<PrismaClient, '$queryRaw'>) {}

  async authenticate(token: string): Promise<McpAccess | null> {
    if (!MCP_TOKEN_PATTERN.test(token)) return null
    const hash = turnKeyHash(token)
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT k.id AS "keyId", t.id AS "taskId", t.workspace_id AS "workspaceId",
        s.id AS "siteId", k.session_id AS "sessionId", k.turn_no AS turn,
        k.first_epoch AS "firstEpoch", a.lease_epoch AS epoch, s.stack::text AS stack, s.url
      FROM llm_keys k JOIN tasks t ON t.id = k.task_id
      JOIN sites s ON s.id = t.site_id AND s.workspace_id = t.workspace_id
      JOIN turn_assignments a ON a.task_id = k.task_id AND a.turn_no = k.turn_no
        AND a.first_epoch = k.first_epoch AND a.session_id = k.session_id AND a.site_id = s.id
      JOIN site_leases l ON l.site_id = s.id AND l.holder_task_id = t.id
        AND l.epoch = a.lease_epoch
      WHERE k.mcp_token_hash = ${hash} AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
        AND k.task_attempt = t.attempt AND k.expires_at > clock_timestamp()
        AND k.valid_until > clock_timestamp() AND a.deadline_at > clock_timestamp()
        AND a.finished_at IS NULL AND a.outcome IS NULL
        AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
        AND s.status = 'active' AND t.content_retired_at IS NULL
        AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])
    `
    if (rows.length === 0) return null
    // A matched hash with no single valid scope is broken data, not a bad token: fail closed
    // as an outage the operator sees, with a fixed message that carries none of the row.
    const parsed = rows.length === 1 ? mcpAccessSchema.safeParse(rows[0]) : undefined
    if (!parsed?.success)
      throw new DomainError('MCP_ACCESS_SCOPE_INVALID', 'MCP admission row is invalid', 503)
    return parsed.data
  }
}
