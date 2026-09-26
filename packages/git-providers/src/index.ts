// Git provider adapters (spec §10): Gitea first, then the client's GitHub or GitLab.
// Webhooks go only through GitProvider.parseWebhook; DiffPolicy paths live in @repo/domain.
export { gitProviderConfigSchema, type GitProviderConfig } from './config.ts'
export { createGitProvider } from './create-git-provider.ts'
export { createGiteaProvider } from './gitea.ts'
export { createGithubProvider } from './github.ts'
export { createGitlabProvider } from './gitlab.ts'
