import 'server-only'

import { createHmac } from 'node:crypto'

import type { BuiltinMcpServices } from '@repo/trpc'
import { createVaultSecretStore } from '@repo/vault'
import { vkCallbackPath } from '@repo/domain'
import { VkHttpApi } from '@repo/vk'

import { env } from '@/env'

let services: { value: BuiltinMcpServices | null } | undefined

/**
 * What the keys of the built-in MCP servers are checked and written through
 * (docs/plan/99-vk-community.md, ВК15): a Vault store of which only `kvWrite` and `kvMetadata` are
 * reachable — `sites-writer` reads nothing back — and the check of a VK community key against
 * api.vk.com. Built on first use and kept for the process; null — the vault settings do not parse:
 * the servers are listed and switched, no key is connected.
 */
export function builtinMcpServices(): BuiltinMcpServices | null {
  if (services === undefined) {
    let vault
    let confirmSecret: string | null
    let appUrl: string
    try {
      vault = env.vault()
      confirmSecret = env.vk().confirmSecret
      appUrl = env.web().appUrl
    } catch {
      console.error('[web] built-in MCP keys are off: the vault, vk or web settings do not parse')
      services = { value: null }
      return null
    }
    const store = createVaultSecretStore(vault)
    const vk = new VkHttpApi()
    services = {
      value: {
        secrets: {
          kvWrite: (path, data, options) => store.kvWrite(path, data, options),
          kvMetadata: (path) => store.kvMetadata(path),
        },
        vk: {
          community: (token, groupId) => vk.community(token, groupId),
          tokenPermissions: (token) => vk.tokenPermissions(token),
          addCallbackServer: (token, groupId, server) =>
            vk.addCallbackServer(token, groupId, server),
          deleteCallbackServer: (token, groupId, serverId) =>
            vk.deleteCallbackServer(token, groupId, serverId),
        },
        // The webhook of the Callback API (slice 99.6): only where VK can reach it, over https.
        callbackUrl: appUrl.startsWith('https://')
          ? (communityId: string) => `${appUrl.replace(/\/$/, '')}${vkCallbackPath(communityId)}`
          : null,
        // The cards of VK: the same secret core checks every press by.
        confirmMac: confirmSecret
          ? (material: string) =>
              createHmac('sha256', confirmSecret).update(material).digest('base64url')
          : null,
      },
    }
  }
  return services.value
}
