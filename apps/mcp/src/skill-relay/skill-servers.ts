import type { PrismaClient } from '@repo/db'
import {
  agentSkillHeaderNameSchema,
  agentSkillOAuthSchema,
  parseAgentSkillUrl,
  type AgentSkillAuthState,
  type AgentSkillOAuth,
} from '@repo/domain'

/** An added MCP server with authorization; the relay serves it while its state is `ok`. */
export interface RelayedServer {
  url: string
  authKind: 'header' | 'oauth'
  /** The owner's header, for `header`. */
  headerName: string | null
  state: AgentSkillAuthState
  error: string | null
  /** What of the sign-in is not secret, for `oauth`: where and when its token is renewed. */
  oauth: AgentSkillOAuth | null
}

/** What the relay learned of a server's authorization: its state and a code, never a text. */
export interface RelayOutcome {
  state: AgentSkillAuthState
  error: string | null
  at: Date
}

export interface SkillServerStore {
  /** The server of a workspace by its name; null for one that is off or has no authorization. */
  find(workspaceId: string, name: string): Promise<RelayedServer | null>
  /** Writes the state of its authorization; a server turned to none meanwhile is left alone. */
  record(workspaceId: string, name: string, outcome: RelayOutcome): Promise<void>
}

/**
 * The servers of `workspace_agent_skills` (docs/plan/81-mcp-server-credentials.md). The workspace comes
 * from the admission of the turn, never from the request: a turn reaches only its own workspace's
 * servers.
 */
export class PostgresSkillServers implements SkillServerStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'workspaceAgentSkill'>) {}

  async find(workspaceId: string, name: string): Promise<RelayedServer | null> {
    const row = await this.prisma.workspaceAgentSkill.findUnique({
      where: { workspaceId_name: { workspaceId, name } },
      select: {
        url: true,
        enabled: true,
        authKind: true,
        headerName: true,
        authState: true,
        authError: true,
        oauth: true,
      },
    })
    if (row === null || !row.enabled || row.authKind === 'none') return null
    // The address and the header as the platform keeps them, read again: a row written past the
    // checks goes nowhere and sets no header of the relay's own.
    if (row.url === null || parseAgentSkillUrl(row.url) !== row.url) return null
    if (
      row.authKind === 'header' &&
      (row.headerName === null || !agentSkillHeaderNameSchema.safeParse(row.headerName).success)
    )
      return null
    const oauth = row.authKind === 'oauth' ? agentSkillOAuthSchema.safeParse(row.oauth) : null
    if (oauth !== null && !oauth.success) return null
    return {
      url: row.url,
      authKind: row.authKind,
      headerName: row.headerName,
      state: row.authState,
      error: row.authError,
      oauth: oauth?.data ?? null,
    }
  }

  async record(workspaceId: string, name: string, outcome: RelayOutcome): Promise<void> {
    await this.prisma.workspaceAgentSkill.updateMany({
      where: { workspaceId, name, authKind: { not: 'none' } },
      data: { authState: outcome.state, authError: outcome.error, authCheckedAt: outcome.at },
    })
  }
}
