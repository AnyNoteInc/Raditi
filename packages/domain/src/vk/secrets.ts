import { z } from 'zod'

import { vkLimits } from './limits.ts'

// The keys of VK in Vault (docs/plan/99-vk-community.md, §4, rule 2): the key of a client's
// community — written by web, never read back by it; read only by core, for a publication the
// client pressed — and the service key of Raditi's VK app, put by the operator command
// (`subscriptions:vk-key`, beside the key of the web search) and read by mcp to read open walls.
// Neither reaches the database, a sandbox, the model or a log.

/** The key of a connected community: one version, replaced by a new key of the same community. */
export const vkCommunitySecretPath = (workspaceId: string, communityId: string): string =>
  `kv/workspaces/${workspaceId}/vk/${communityId}`

/** The service key of Raditi's VK app (ВК4): reads open walls and their comments. */
export const VK_SERVICE_KEY_PATH = 'subs/vk/service'

/** The one field of both keys: KV data is a map of strings. */
export const VK_TOKEN_FIELD = 'token'

/** A key of VK as the form takes it and Vault keeps it: one word of printable characters. */
export const vkTokenSchema = z
  .string()
  .trim()
  .min(16)
  .max(vkLimits.tokenChars)
  .regex(/^[\x21-\x7e]+$/, 'One word of printable characters')

export const vkSecretSchema = z.strictObject({ [VK_TOKEN_FIELD]: vkTokenSchema })
export type VkSecret = z.infer<typeof vkSecretSchema>
