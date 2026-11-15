import 'server-only'

import type { McpServerServices } from '@repo/trpc'
import { createVaultSecretStore } from '@repo/vault'

import { env } from '@/env'
import { createMcpServerProbe } from '@/server/mcp-server-probe'

let services: { value: McpServerServices | null } | undefined

/**
 * What an MCP server with a key is checked and written through (docs/plan/80-mcp-server-
 * credentials.md): the check of the server and a Vault store of which only `kvWrite` and
 * `kvMetadata` are reachable — the `sites-writer` policy reads nothing back either. Built on
 * first use and kept for the process. null — the vault or web settings do not parse: servers with
 * a key cannot be added, everything else works. Said once, by the section's name only.
 */
export function mcpServerServices(): McpServerServices | null {
  if (services === undefined) {
    let config
    try {
      config = { vault: env.vault(), probe: env.web().mcpServerProbe }
    } catch {
      console.error('[web] MCP servers with a key are off: the vault or web settings do not parse')
      services = { value: null }
      return null
    }
    const store = createVaultSecretStore(config.vault)
    services = {
      value: {
        secrets: {
          kvWrite: (path, data, options) => store.kvWrite(path, data, options),
          kvMetadata: (path) => store.kvMetadata(path),
        },
        probe: createMcpServerProbe(config.probe),
      },
    }
  }
  return services.value
}
