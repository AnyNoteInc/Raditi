/**
 * Site connection wizard — spec §12, docs/plan/39-site-connection-wizard.md. Where the files
 * and the database of a site are, and the two stages that follow «Добавить сайт». The lists
 * below are also the values of the PostgreSQL enums of the same names.
 */
export const siteSourceKinds = ['ftp', 'sftp', 'git'] as const
export type SiteSourceKind = (typeof siteSourceKinds)[number]

export const databaseEngines = ['mysql', 'postgres'] as const
export type DatabaseEngine = (typeof databaseEngines)[number]

/**
 * How a connection to a client's server is protected. `unverified` is TLS without a check of
 * the server's identity and `plain` is no encryption: each is the client's explicit choice
 * after a refused `verified` check, never a fallback.
 */
export const connectionTlsModes = ['verified', 'unverified', 'plain'] as const
export type ConnectionTls = (typeof connectionTlsModes)[number]

export const provisioningStages = ['code_import', 'database_schema'] as const
export type ProvisioningStage = (typeof provisioningStages)[number]

export const provisioningStageStatuses = ['queued', 'running', 'succeeded', 'failed'] as const
export type ProvisioningStageStatus = (typeof provisioningStageStatuses)[number]

/** The organization of site repositories in the platform's Gitea, and the name of one. */
export const SITE_REPOSITORY_OWNER = 'sites'
export const siteRepositoryName = (siteId: string): string => `site-${siteId}`
