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

/**
 * What a running stage is doing (site_provisioning_stages.step): code_import fetches the files and
 * scans them, then publishes the first commit and its tag. NULL in every other status.
 */
export const provisioningSteps = ['fetch', 'publish'] as const
export type ProvisioningStep = (typeof provisioningSteps)[number]

/** The tag of the first version of every site repository (owner's decision of 17.10.2026). */
export const INITIAL_SITE_TAG = 'v0.0.0'

/** The organization of site repositories in the platform's Gitea, and the name of one. */
export const SITE_REPOSITORY_OWNER = 'sites'
export const siteRepositoryName = (siteId: string): string => `site-${siteId}`
