/**
 * Site adapter port — spec §13. Everything that depends on the CMS or framework hides
 * behind this interface; the core knows nothing about WordPress or Bitrix.
 */
import type { z } from 'zod'

import { badRequest } from '../errors.ts'
import type { PublishedContentGateway } from './published-content.ts'

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

/**
 * Kinds of access to a site kept in Vault (spec §15); each is one secret of the site and one
 * `credential_refs` row of the same kind.
 */
export const siteAccessKinds = ['ssh', 'ftp', 'wp', 'browser'] as const
export type SiteAccessKind = (typeof siteAccessKinds)[number]

const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * The only Vault path of one access of one site: `kv/sites/<siteId>/<kind>`. A reference in
 * the database is followed only when it equals this, so a changed row cannot point a reader
 * at another site's secret or at another mount.
 */
export function siteAccessPath(siteId: string, kind: SiteAccessKind): string {
  if (!SITE_ID.test(siteId) || !siteAccessKinds.includes(kind))
    throw badRequest('Invalid site access reference')
  return `kv/sites/${siteId}/${kind}`
}

/**
 * One HTTP exchange with a site. The adapter names its limits; the transport follows no
 * redirect (a 3xx is returned as it is) and rejects on a network failure, a timeout or a
 * response larger than `maxResponseBytes`.
 */
export interface SiteHttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Readonly<Record<string, string>>
  body?: string
  timeoutMs: number
  maxResponseBytes: number
}

export interface SiteHttpResponse {
  status: number
  body: Uint8Array
}

/** The composition root owns it: the place that decides which addresses a site may resolve to. */
export type SiteHttpTransport = (request: SiteHttpRequest) => Promise<SiteHttpResponse>

/** What every content access says besides its adapter's own fields: the origin it is valid for. */
export interface SiteContentAccess {
  origin: string
}

export interface SiteContentConnection<Access extends SiteContentAccess = SiteContentAccess> {
  siteId: string
  /** Origin of the site's address; the caller has checked that the access names the same one. */
  origin: string
  access: Access
  transport: SiteHttpTransport
  /** Plain http to a loopback name, for a disposable local site. Never in production. */
  allowLoopbackHttp: boolean
}

/**
 * Published content of one stack (spec §11, §13): which access of the site it needs, how that
 * secret looks, and the gateway built from it. The caller reads the secret and never learns
 * its CMS-specific fields.
 */
export interface SiteContentAdapter<Access extends SiteContentAccess = SiteContentAccess> {
  readonly stack: SiteStack
  /** `credential_refs.kind` of the access and the last segment of its Vault path. */
  readonly accessKind: SiteAccessKind
  /** The secret as Vault keeps it: a flat record of strings. */
  readonly accessSchema: z.ZodType<Access>
  createGateway(connection: SiteContentConnection<Access>): PublishedContentGateway
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
