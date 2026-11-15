import type { PrismaClient } from '@repo/db'
import { parseAgentSkillUrl, type AgentSkillAuthState } from '@repo/domain'

/** An added MCP server the relay may serve now: on, with authorization that works. */
export interface RelayedServer {
  url: string
  authKind: 'header' | 'oauth'
  /** The owner's header, for `header`. */
  headerName: string | null
}

/** What the relay learned of a server's authorization: its state and a code, never a text. */
export interface RelayOutcome {
  state: AgentSkillAuthState
  error: string | null
  at: Date
}

export interface SkillServerStore {
  /** The server of a site by its name; null for one that is off, open or needs a sign-in. */
  find(siteId: string, name: string): Promise<RelayedServer | null>
  /** Writes the state of its authorization; a server turned to none meanwhile is left alone. */
  record(siteId: string, name: string, outcome: RelayOutcome): Promise<void>
}

/**
 * The servers of `site_agent_skills` (docs/plan/80-mcp-server-credentials.md). The site comes from
 * the admission of the turn, never from the request: a turn reaches only its own site's servers.
 */
export class PostgresSkillServers implements SkillServerStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'siteAgentSkill'>) {}

  async find(siteId: string, name: string): Promise<RelayedServer | null> {
    const row = await this.prisma.siteAgentSkill.findUnique({
      where: { siteId_name: { siteId, name } },
      select: { url: true, enabled: true, authKind: true, headerName: true, authState: true },
    })
    if (row === null || !row.enabled || row.authKind === 'none' || row.authState !== 'ok')
      return null
    // The address as the platform keeps it, read again: a row written past the check goes nowhere.
    if (row.url === null || parseAgentSkillUrl(row.url) !== row.url) return null
    if (row.authKind === 'header' && row.headerName === null) return null
    return { url: row.url, authKind: row.authKind, headerName: row.headerName }
  }

  async record(siteId: string, name: string, outcome: RelayOutcome): Promise<void> {
    await this.prisma.siteAgentSkill.updateMany({
      where: { siteId, name, authKind: { not: 'none' } },
      data: { authState: outcome.state, authError: outcome.error, authCheckedAt: outcome.at },
    })
  }
}
