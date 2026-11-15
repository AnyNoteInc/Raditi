import type { SecretStore } from '@repo/domain'

// The authorization of an MCP server of a site's agent, on the side of the cabinet
// (docs/plan/80-mcp-server-credentials.md, §3.4): the key the owner types is checked against the
// server itself, written to Vault and never read back. The check needs the network and the
// address rules of an app (@repo/ip-address), so web makes it and hands it in.

/** What a check of a server found; the reasons are the form's to say. */
export type McpServerCheck =
  | { ok: true; tools: number }
  | {
      ok: false
      reason: 'unauthorized' | 'unreachable' | 'address_refused' | 'not_mcp' | 'needs_login'
    }

/**
 * Asks a server for `initialize` and `tools/list` with the owner's header. Connects only to a
 * public address, follows no redirect, reads a bounded answer; the value goes nowhere else.
 */
export type McpServerProbe = (input: {
  url: string
  header: { name: string; value: string } | null
}) => Promise<McpServerCheck>

/** What the procedures of MCP servers reach outside the database. The app builds it once. */
export interface McpServerServices {
  /** Two methods of Vault: nothing that holds this object can read a secret back. */
  secrets: Pick<SecretStore, 'kvWrite' | 'kvMetadata'>
  probe: McpServerProbe
}
