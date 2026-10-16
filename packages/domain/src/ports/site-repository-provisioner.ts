import type { RepositoryInfo } from './git-provider.ts'

/**
 * Creates the private, empty repository of a site in the platform's organization, or confirms
 * the one that is already there. Not a GitProvider method: another identity, another right.
 */
export interface SiteRepositoryProvisioner {
  ensureRepository(name: string): Promise<RepositoryInfo>
}
