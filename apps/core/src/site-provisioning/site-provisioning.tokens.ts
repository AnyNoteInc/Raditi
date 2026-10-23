/** (kind: SiteSourceKind) => SiteSourceAdapter: where the files of a connected site come from. */
export const SITE_SOURCES = Symbol('SITE_SOURCES')
/**
 * (engine: DatabaseEngine) => DatabaseInspector: databaseInspector of @repo/site-connections. The
 * import reads the database access of a site through it, to keep its password out of the files.
 */
export const SITE_DATABASES = Symbol('SITE_DATABASES')
/**
 * SiteRepositoryProvisioner of our Gitea, or null while git or GITEA_PROVISIONER_TOKEN is not
 * configured: the import of a connected site then refuses `repository_not_configured`.
 */
export const SITE_REPOSITORY_PROVISIONER = Symbol('SITE_REPOSITORY_PROVISIONER')
