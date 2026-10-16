import type { SiteRepositoryProvisioner } from '@repo/domain'

import { parseGitProviderConfig } from './config.ts'
import {
  createGiteaClient,
  giteaRefused,
  isGiteaName,
  type GiteaClient,
  type GiteaClientOptions,
} from './gitea-client.ts'

export interface GiteaRepositoryProvisionerConfig {
  /** Web root of our Gitea (GITEA_URL). The API is called only over https. */
  baseUrl: string
  /**
   * Token of the account that creates site repositories (GITEA_PROVISIONER_TOKEN), never the
   * bot's. Gitea 1.27.3 asks it for the scopes write:organization and write:repository, and its
   * account for a team of the organization that may create repositories.
   */
  token: string
  /** Owner of every site repository: `sites` (spec §10). */
  organization: string
}

export type GiteaRepositoryProvisionerOptions = GiteaClientOptions

/**
 * Site repositories of our Gitea 1.27 (spec §10): private, without a first commit, default
 * branch `main`. Gitea makes the creating account an administrator of the new repository; that
 * is how a repeated call sees the repository an earlier one created. A refusal that no retry
 * cures says why in `details.reason` (GiteaRefusal).
 */
export function createGiteaRepositoryProvisioner(
  config: GiteaRepositoryProvisionerConfig,
  options: GiteaRepositoryProvisionerOptions = {},
): SiteRepositoryProvisioner {
  const parsed = parseGitProviderConfig('GiteaRepositoryProvisioner', {
    baseUrl: config.baseUrl,
    token: config.token,
  })
  const { organization } = config
  if (!isGiteaName(organization))
    throw new Error('Invalid GiteaRepositoryProvisioner configuration: organization')
  // On first use, as in gitea.ts: an address without https fails the call, not the start of core.
  let client: GiteaClient | undefined
  const api = () => (client ??= createGiteaClient(parsed, options))

  return {
    async ensureRepository(name) {
      // A name that cannot be one is refused by the client before any request.
      const repository =
        (await api().createOrganizationRepository(organization, name)) ??
        // The name is taken: by an earlier call for the same site, or by something else.
        (await api().getRepository(organization, name))
      if (!repository)
        throw giteaRefused('not_ours', 'Gitea does not show the repository that holds the name')
      // Gitea matches names without letter case and may answer with another spelling.
      if (!repository.private || repository.owner !== organization || repository.name !== name)
        throw giteaRefused('not_ours', 'The repository is not the private one of the organization')
      // The branch the creation asks for and the import pushes. Gitea makes the first branch
      // pushed to an empty repository its default, and an owner can change it.
      if (repository.defaultBranch !== 'main')
        throw giteaRefused('not_ours', 'The default branch of the repository is not main')
      return {
        ref: { provider: 'gitea', owner: repository.owner, name: repository.name },
        defaultBranch: repository.defaultBranch,
        // Built from the configured address: Gitea derives its clone_url from the Host header.
        cloneUrl: `${api().root}/${repository.owner}/${repository.name}.git`,
        private: repository.private,
      }
    },
  }
}
