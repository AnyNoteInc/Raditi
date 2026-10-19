import { DomainError, type SecretStore } from '@repo/domain'
import { z } from 'zod'

/**
 * Where the token of an owner of the organization `sites` lives (plan 53, Р35): Vault, never the
 * shared environment of the services. The operator writes it; only the `core` role reads it
 * (policy `core-release`). The value: `{ "v": "1", "token": "<Gitea access token>" }`; Gitea
 * 1.27.3 asks it for the scope `write:repository` and its account for the Owners team.
 */
export const GITEA_ORG_OWNER_SECRET_PATH = 'kv/platform/gitea-org-owner'

const secretSchema = z.strictObject({
  v: z.literal('1'),
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
})

const notConfigured = (message: string) =>
  new DomainError('GIT_PROVIDER_NOT_CONFIGURED', message, 503)

/**
 * `GiteaProviderOptions.ownerToken` over Vault: read on every call, kept nowhere. A missing or
 * malformed secret fails the call as not configured; its value is never part of a message.
 */
export function giteaOrgOwnerToken(secrets: Pick<SecretStore, 'kvRead'>): () => Promise<string> {
  return async () => {
    const secret = await secrets.kvRead(GITEA_ORG_OWNER_SECRET_PATH)
    if (!secret) throw notConfigured('Vault holds no token of the Gitea organization owner')
    const parsed = secretSchema.safeParse(secret.data)
    if (!parsed.success)
      throw notConfigured('The token of the Gitea organization owner in Vault has another shape')
    return parsed.data.token
  }
}
