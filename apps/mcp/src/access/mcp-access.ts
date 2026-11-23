import { passUnattended, type PrismaClient } from '@repo/db'
import { DomainError, taskRequirementsSchema, terminalTaskStatuses } from '@repo/domain'
import { z } from 'zod'

import { MCP_TOKEN_PATTERN, turnKeyHash } from '@repo/turn-keys'

/**
 * What an admitted token gives (docs/plan/83-remove-projects.md, БП1): a turn of a chat, with no
 * site or preview, and with the repository of its project when its plan names one
 * (docs/plan/84-projects.md, §4.3). Derived only from the admitted token and current assignment,
 * never from tool arguments. The turn holds the row of `site_leases` named by its own chat id.
 */
export const mcpTurnAccessSchema = z
  .strictObject({
    keyId: z.uuid(),
    taskId: z.uuid(),
    workspaceId: z.uuid(),
    sessionId: z.string().min(1).max(64),
    turn: z.number().int().positive(),
    firstEpoch: z.number().int().positive(),
    epoch: z.number().int().positive(),
    /**
     * Whether the chat has the cloud browser (`tasks.needs_browser`) and whether its turn has the
     * repository of its project — read from the plan of the turn, never from the chat now (ПР2).
     */
    requirements: taskRequirementsSchema,
    /**
     * The memory of the chat (docs/plan/84-projects.md, ПР18): its author's, of its project or — null
     * projectId — of the account; null or absent — off (`users.agent_memory`), no author, or the
     * project in the trash. The family `memory` is offered only with it.
     */
    memory: z
      .strictObject({ userId: z.uuid(), projectId: z.uuid().nullable() })
      .nullable()
      .optional(),
    /**
     * The repository of the turn, as its plan names it (docs/plan/84-projects.md, §4.3): the family
     * `repo` is offered only with it. Its tokens never come here — `mcp` holds none (§4.6).
     */
    repository: z
      .strictObject({
        projectId: z.uuid(),
        projectRepositoryId: z.uuid(),
        mode: z.enum(['read', 'write']),
        branch: z.string().min(1).max(255),
        baseSha: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .nullable()
      .optional(),
    /**
     * A pass of a scheduled run before the first words of its client (docs/plan/82-scheduled-
     * tasks.md, Зп27, `passUnattended`): nobody confirms anything, so the tasks and the pages are
     * not changed, a call with `confirmedByClient` is refused, the MCP servers of the workspace are
     * not called and the browser only reads (Зп28, Зп32, Зп50, Зп51). Decided for the pass, by the
     * request it answers (`answeredAtOf`): what the client writes while it runs lifts nothing of it.
     * Absent — false: a scope made before the field.
     */
    unattended: z.boolean().optional(),
    /**
     * The key of the turn has the profile that sees images (`llm_keys.vision_model_id`,
     * docs/plan/88-artifacts.md, Ар32): the helper `look` and its `artifact_render`. Absent — false.
     */
    vision: z.boolean().optional(),
  })
  .refine((access) => access.requirements.repository === Boolean(access.repository))
export type McpTurnAccess = z.infer<typeof mcpTurnAccessSchema>

export interface McpAccessStore {
  authenticate(token: string): Promise<McpTurnAccess | null>
}
export const MCP_ACCESS = Symbol('MCP_ACCESS')
/** Never issued (tokens are 32 random bytes): health runs the real admission query with it. */
export const MCP_ACCESS_PROBE_TOKEN = `mcp_${'0'.repeat(64)}`

/**
 * MCP needs only the paired hash, not Vault turns/ or any subscription credential. A turn is
 * admitted by the row of `site_leases` its assignment names: the chat's own (its id).
 */
export class PostgresMcpAccess implements McpAccessStore {
  constructor(
    private readonly prisma: Pick<PrismaClient, '$queryRaw' | 'scheduledRun' | 'taskEvent'>,
  ) {}

  async authenticate(token: string): Promise<McpTurnAccess | null> {
    if (!MCP_TOKEN_PATTERN.test(token)) return null
    const hash = turnKeyHash(token)
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT k.id AS "keyId", t.id AS "taskId", t.workspace_id AS "workspaceId",
        k.session_id AS "sessionId", k.turn_no AS turn,
        k.first_epoch AS "firstEpoch", a.lease_epoch AS epoch, t.needs_browser AS "needsBrowser",
        u.id AS "authorId", u.agent_memory AS "agentMemory", t.project_id AS "projectId",
        (p.deleted_at IS NOT NULL) AS "projectGone",
        a.plan->'repository' AS "repository",
        a.plan->>'committedAt' AS "answeredAt",
        (k.vision_model_id IS NOT NULL) AS vision
      FROM llm_keys k JOIN tasks t ON t.id = k.task_id
      LEFT JOIN users u ON u.id = t.created_by_id
      LEFT JOIN projects p ON p.id = t.project_id
      JOIN turn_assignments a ON a.task_id = k.task_id AND a.turn_no = k.turn_no
        AND a.first_epoch = k.first_epoch AND a.session_id = k.session_id
        AND a.site_id = t.id
      JOIN site_leases l ON l.site_id = a.site_id AND l.holder_task_id = t.id
        AND l.epoch = a.lease_epoch
      WHERE k.mcp_token_hash = ${hash} AND k.revoke_requested_at IS NULL AND k.revoked_at IS NULL
        AND k.task_attempt = t.attempt AND k.expires_at > clock_timestamp()
        AND k.valid_until > clock_timestamp() AND a.deadline_at > clock_timestamp()
        AND a.finished_at IS NULL AND a.outcome IS NULL
        AND l.operation = 'turn' AND NOT l.held_for_operator AND l.expires_at > clock_timestamp()
        AND t.content_retired_at IS NULL
        AND t.status <> ALL(${[...terminalTaskStatuses]}::"TaskStatus"[])
    `
    if (rows.length === 0) return null
    // A matched hash with no single valid scope is broken data, not a bad token: fail closed
    // as an outage the operator sees, with a fixed message that carries none of the row.
    const parsed = rows.length === 1 ? mcpTurnAccessSchema.safeParse(accessOf(rows[0])) : undefined
    if (!parsed?.success)
      throw new DomainError('MCP_ACCESS_SCOPE_INVALID', 'MCP admission row is invalid', 503)
    // Whether the client is there is one rule of the platform (Зп27), decided for the pass: by the
    // request it answers, never by what the feed holds when a call comes.
    const answeredAt = answeredAtOf(rows[0])
    const unattended = await passUnattended(
      this.prisma,
      parsed.data.taskId,
      answeredAt === null ? undefined : { answeredAt },
    )
    return { ...parsed.data, unattended }
  }
}

/**
 * When the request a pass answers was written: `committedAt` of the plan its assignment keeps
 * (`turnPlanSchema`; the planner writes there the instant of that `feed.request`) — the bound of
 * `passUnattended`, so what the client writes while the pass runs — «Остановить», «Отправить
 * сейчас» — lifts nothing of it. null — a plan without it, which only a fixture writes: the whole
 * feed is counted.
 */
function answeredAtOf(row: unknown): Date | null {
  const value = (row as { answeredAt?: unknown } | null)?.answeredAt
  if (typeof value !== 'string') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

/** The admission row with the task's need of a browser folded into its requirements. */
function accessOf(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row
  // `answeredAt` is the pass's, not the scope's: read by `answeredAtOf`.
  const {
    needsBrowser,
    authorId,
    agentMemory,
    projectId,
    projectGone,
    repository,
    answeredAt: _answeredAt,
    ...access
  } = row as Record<string, unknown>
  const memory =
    typeof authorId === 'string' && agentMemory === true && projectGone !== true
      ? { userId: authorId, projectId: projectId ?? null }
      : null
  const repo =
    repository && typeof repository === 'object'
      ? (({ projectId: p, projectRepositoryId, mode, branch, baseSha }) => ({
          projectId: p,
          projectRepositoryId,
          mode,
          branch,
          baseSha,
        }))(repository as Record<string, unknown>)
      : null
  return {
    ...access,
    requirements: { repository: repo !== null, browser: needsBrowser },
    memory,
    repository: repo,
  }
}
