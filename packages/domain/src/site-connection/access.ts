import { z } from 'zod'

import type { SiteAccessKind } from '../ports/site-adapter.ts'
import {
  gitBranchSchema,
  hostKeySchema,
  oneLine,
  passwordSchema,
  privateKeySchema,
  remotePathSchema,
} from './inputs.ts'
import {
  connectionTlsModes,
  databaseEngines,
  type ConnectionTls,
  type DatabaseEngine,
  type SiteSourceKind,
} from './kinds.ts'

// What Vault keeps at kv/sites/<siteId>/<kind> (strict, strings only), and the public columns
// of the rows next to it. User names live only in Vault.

const v = z.literal('1')
const portText = z.string().regex(/^[1-9]\d{0,4}$/)
const hostText = z.string().min(1).max(253)
const tlsText = z.enum(connectionTlsModes)

// Each secret repeats not only the server but how it may be reached: the mode of protection, the host key,
// the folder, the branch. `matchesTarget` compares all of them with the row; the worker connects by the secret.
export const ftpAccessSchema = z.strictObject({
  v,
  host: hostText,
  port: portText,
  tls: tlsText,
  rootPath: remotePathSchema,
  username: oneLine(128),
  password: passwordSchema,
})
export type FtpAccess = z.infer<typeof ftpAccessSchema>

export const sshAccessSchema = z.discriminatedUnion('auth', [
  z.strictObject({
    v,
    host: hostText,
    port: portText,
    hostKey: hostKeySchema,
    rootPath: remotePathSchema,
    username: oneLine(128),
    auth: z.literal('password'),
    password: passwordSchema,
  }),
  z.strictObject({
    v,
    host: hostText,
    port: portText,
    hostKey: hostKeySchema,
    rootPath: remotePathSchema,
    username: oneLine(128),
    auth: z.literal('key'),
    privateKey: privateKeySchema,
    passphrase: passwordSchema.optional(),
  }),
])
export type SshAccess = z.infer<typeof sshAccessSchema>

/** `url` is the canonical address (after the `.git` redirect), at most 1024 characters; `branch` absent = the remote default. */
export const gitAccessSchema = z.strictObject({
  v,
  url: z.string().min(1).max(1024),
  branch: gitBranchSchema.optional(),
  username: oneLine(128),
  token: passwordSchema,
})
export type GitAccess = z.infer<typeof gitAccessSchema>

export const dbAccessSchema = z.strictObject({
  v,
  engine: z.enum(databaseEngines),
  host: hostText,
  port: portText,
  tls: tlsText,
  database: oneLine(64),
  username: oneLine(128),
  password: passwordSchema,
})
export type DbAccess = z.infer<typeof dbAccessSchema>

/** Public columns of site_code_sources: one flat shape, so a transport writes it without knowing the kind. */
export interface CodeSourceTarget {
  kind: SiteSourceKind
  host: string
  port: number
  rootPath: string | null
  repositoryUrl: string | null
  branch: string | null
  tls: ConnectionTls | null
  hostKey: string | null
}

/** Public columns of site_databases. */
export interface DatabaseTarget {
  engine: DatabaseEngine
  host: string
  port: number
  databaseName: string
  tls: ConnectionTls
}

/** What a checked input becomes: one Vault record (flat strings) and one row. */
export interface PreparedAccess<Target> {
  accessKind: SiteAccessKind
  secret: Record<string, string>
  target: Target
}
