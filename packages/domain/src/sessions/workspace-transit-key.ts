/**
 * The Transit key of a workspace: `transit/keys/ws-<workspaceId>` (spec §15). Turn snapshots
 * (role core) and content snapshots (role mcp) wrap their data keys with it. Platform code
 * builds the name here only. A decision to give content its own key changes this line, the
 * name pattern the Vault adapter accepts and the paths of the policies (infra/vault).
 */
export function workspaceTransitKey(workspaceId: string): string {
  return `ws-${workspaceId}`
}
