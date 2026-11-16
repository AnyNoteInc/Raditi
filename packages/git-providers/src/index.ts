// Git provider adapters (docs/plan/84-projects.md, ПР11, §4.5). Sign-in lives in ./connect.
export {
  createGitProvider,
  type CreateGitProviderInput,
  type GitProviderEndpoints,
} from './create-git-provider.ts'
export {
  createGitlabProvider,
  gitlabCiPaths,
  gitlabCiStatus,
  type GitlabProviderConfig,
} from './gitlab.ts'
export { gitlabPathAllowed } from './gitlab-paths.ts'
export {
  createGithubProvider,
  githubCiPaths,
  githubCiStatus,
  type GithubProviderConfig,
} from './github.ts'
export {
  assertGitUrl,
  createGitTransport,
  gitTransportDefaults,
  pinnedLookup,
  type GitHttpRequest,
  type GitHttpResponse,
  type GitSend,
  type GitSendLimits,
  type GitSession,
  type GitTransport,
  type GitTransportOptions,
} from './transport.ts'
