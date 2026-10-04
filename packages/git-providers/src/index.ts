// Git provider adapters (spec §10): Gitea first, then the client's GitHub or GitLab.
// Webhooks go only through GitProvider.parseWebhook; DiffPolicy paths live in @repo/domain.
export { gitProviderConfigSchema, type GitProviderConfig } from './config.ts'
export { createGitProvider, type GitProviderOptions } from './create-git-provider.ts'
export type { GitCredentialLifecycle, ManagedGitProvider } from './credential-lifecycle.ts'
