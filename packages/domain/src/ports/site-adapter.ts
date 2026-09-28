/**
 * Site adapter port — spec §13. Everything that depends on the CMS or framework hides
 * behind this interface; the core knows nothing about WordPress or Bitrix.
 */
export const siteStacks = ['wordpress', 'bitrix', 'laravel', 'static', 'node', 'python'] as const
export type SiteStack = (typeof siteStacks)[number]

/** Read-only access to a site server during onboarding (SSH, FTP or the Радити plugin). */
export interface ServerProbe {
  exec(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  readFile(path: string): Promise<string | null>
  httpGet(path: string): Promise<{ status: number; body: string }>
}

export interface SiteFacts {
  stack: SiteStack
  url: string
  docroot: string
  version?: string
  runtimeVersion?: string
  extras: Record<string, string>
}

export interface ImportRules {
  /** Lines of the repository .gitignore. */
  gitignore: string[]
  /** Never imported into git: uploads, caches, core files. */
  exclude: string[]
}

/** Variables for the shared deploy workflow; adapters never ship their own CI. */
export type DeployVars = Record<string, string>

export interface BackupPlan {
  paths: string[]
  database: boolean
}

export interface VerifyPlan {
  pages: string[]
  logFiles: string[]
  screenshots: string[]
}

export interface McpToolDescriptor {
  name: string
  description: string
  /** Needs request_approval before running (CLAUDE.md rule 4). */
  dangerous: boolean
}

export interface SiteAdapter {
  readonly stack: SiteStack
  detect(probe: ServerProbe): Promise<SiteFacts | null>
  importRules(site: SiteFacts): ImportRules
  deployVars(site: SiteFacts): DeployVars
  backup(site: SiteFacts): BackupPlan
  verify(site: SiteFacts): VerifyPlan
  mcpTools(site: SiteFacts): McpToolDescriptor[]
  /** Draft of the site AGENTS.md. */
  agentGuide(site: SiteFacts): string
  /** Paths an agent diff may not touch, e.g. wp-config.php or /bitrix/. */
  protectedPaths(site: SiteFacts): string[]
  /** Heavy or generated paths excluded from turn snapshots. */
  snapshotExcludes(site: SiteFacts): string[]
}
