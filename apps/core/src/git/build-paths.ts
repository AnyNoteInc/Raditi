import {
  readRepoCiPaths,
  repoBuildPathMatcher,
  repoCiOwnPaths,
  type RepoProviderKind,
} from '@repo/domain'
import { gitProviderCiPaths } from '@repo/git-providers'

// Which changed paths of a chat's branch are build settings (docs/plan/84-projects.md, ПР16):
// the domain's `forbiddenCiPaths`, the provider's `support.ciPaths`, and the repository's own —
// its `ci_config_path` and the files of `include: local` (`project_repositories.ci_paths`, and
// those the last CI Lint of the branch named).

export function buildPathsOf(
  repo: { provider: string; ciPaths: unknown },
  includes: readonly string[] = [],
): (path: string) => boolean {
  return repoBuildPathMatcher({
    providerPaths: gitProviderCiPaths(repo.provider as RepoProviderKind),
    own: repoCiOwnPaths(readRepoCiPaths(repo.ciPaths), includes),
  })
}
