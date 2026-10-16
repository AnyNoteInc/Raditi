import { z } from 'zod'

import { normalizeSiteHost } from '../policies/site-address.ts'
import { connectionTlsModes, databaseEngines } from './kinds.ts'
import { siteConnectionLimits } from './limits.ts'

// What the wizard sends: the code source and the database of a site, secrets included. Shape
// only. Whether an address is accepted is the resolver's answer (address.ts) and whether the
// access works is the answer of a real connection. The secret fields exist in the browser's
// state, in the request and, after a passed check, in Vault — nowhere else.

/** C0 and DEL always; C1 (U+0080–U+009F) too when asked. Walks charCodeAt: no control character in a regex. */
export function hasControlCharacter(text: string, options: { c1?: boolean } = {}): boolean {
  const { c1 = false } = options
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f || (c1 && code >= 0x80 && code <= 0x9f)) return true
  }
  return false
}

function hasNulOrLineBreak(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0 || code === 10 || code === 13) return true
  }
  return false
}

/** Printable ASCII, CR, LF and TAB only. */
function isAsciiText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if ((code < 0x20 || code > 0x7e) && code !== 9 && code !== 10 && code !== 13) return false
  }
  return true
}

/** A value of one line: not empty, no control character. Not trimmed. */
export const oneLine = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacter(value))

/** Shape only: a bare host, normalised. Whether the address is accepted is the resolver's answer. */
export const siteHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value, ctx) => {
    const host = normalizeSiteHost(value)
    if (host === null) {
      ctx.addIssue({ code: 'custom', message: 'Invalid host' })
      return z.NEVER
    }
    return host
  })

const portSchema = z.number().int().min(1).max(65_535)

/** Never trimmed: a password may begin or end with a space. Refuses NUL, CR and LF (by character code). */
export const passwordSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !hasNulOrLineBreak(value))

/** Absolute or relative to the login folder; `/` separators; no `..`, no backslash. No default. */
export const remotePathSchema = oneLine(1024).refine(
  (value) => !value.includes('\\') && !value.split('/').includes('..'),
)

/**
 * "<key type> SHA256:<digest>": the key type as ssh2's `utils.parseKey(key).type` prints it (`ssh-ed25519`,
 * `ssh-rsa`, `ecdsa-sha2-nistp256`, …) — a key type, never a signature algorithm (`rsa-sha2-512` is not one) —
 * and base64 of the SHA-256 digest without padding: 43 characters. At most 128 characters, the width of
 * `site_code_sources.host_key`: the longest known type gives 70.
 */
export const hostKeySchema = z
  .string()
  .max(128)
  .regex(/^(?:ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+) SHA256:[A-Za-z0-9+/]{43}$/)

/** Both key formats are ASCII: printable ASCII, CR, LF and TAB only, so the largest key is 32 KiB of JSON, not 96. */
export const privateKeySchema = z
  .string()
  .min(1)
  .max(siteConnectionLimits.privateKeyChars)
  .refine(isAsciiText)

export const ftpSourceInputSchema = z.strictObject({
  kind: z.literal('ftp'),
  host: siteHostSchema,
  port: portSchema,
  username: oneLine(128),
  password: passwordSchema,
  rootPath: remotePathSchema,
  tls: z.enum(connectionTlsModes),
})

export const sftpSourceInputSchema = z.strictObject({
  kind: z.literal('sftp'),
  host: siteHostSchema,
  port: portSchema,
  username: oneLine(128),
  auth: z.discriminatedUnion('method', [
    z.strictObject({ method: z.literal('password'), password: passwordSchema }),
    z.strictObject({
      method: z.literal('key'),
      privateKey: privateKeySchema,
      passphrase: passwordSchema.optional(),
    }),
  ]),
  rootPath: remotePathSchema,
  /** The host key a previous check returned; absent only on the first check. */
  hostKey: hostKeySchema.optional(),
})

/** Typed in full: URL alone would also take `https:host`, a `\` for a `/` and an empty userinfo. */
const GIT_URL = /^https:\/\/[^/\\?#@\s]+\/[^\\?#\s]*$/i

function canonicalGitUrl(value: string): string | null {
  if (!GIT_URL.test(value) || hasControlCharacter(value)) return null
  let url: URL
  try {
    // The constructor, not `URL.parse`: the wizard validates in browsers that do not have it yet.
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  // Port 0 is no port: a client dials its default instead, and the row of the source refuses it.
  if (url.port === '0') return null
  // The one dot of a root name is dropped; after a second one an empty label is left.
  const host = url.hostname.replace(/\.$/, '')
  if (host === '' || host.endsWith('.')) return null
  url.hostname = host
  const href = url.href.replace(/\/+$/, '')
  // Nothing but the origin: the address of a server, not of a repository.
  if (href === url.origin || href.length > siteConnectionLimits.gitUrlChars) return null
  return href
}

/**
 * https only; no userinfo, query or fragment; never port 0; a non-empty path; at most `gitUrlChars` (1020)
 * characters, typed and canonical. Output: canonical href without a trailing slash.
 */
export const gitRepositoryUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(siteConnectionLimits.gitUrlChars)
  .transform((value, ctx) => {
    const url = canonicalGitUrl(value)
    if (url === null) {
      ctx.addIssue({ code: 'custom', message: 'Invalid repository address' })
      return z.NEVER
    }
    return url
  }) satisfies z.ZodType<string>

export const gitBranchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]*$/)

export const gitSourceInputSchema = z.strictObject({
  kind: z.literal('git'),
  url: gitRepositoryUrlSchema,
  /** Most services accept any name next to a token; a colon would break Basic authentication. */
  username: oneLine(128)
    .regex(/^[^:\s]+$/)
    .default('x-access-token'),
  token: passwordSchema,
  branch: gitBranchSchema.optional(),
})

export const codeSourceInputSchema = z.discriminatedUnion('kind', [
  ftpSourceInputSchema,
  sftpSourceInputSchema,
  gitSourceInputSchema,
])
export type CodeSourceInput = z.infer<typeof codeSourceInputSchema>

export const databaseInputSchema = z.strictObject({
  engine: z.enum(databaseEngines),
  host: siteHostSchema,
  port: portSchema,
  database: oneLine(64),
  username: oneLine(128),
  password: passwordSchema,
  tls: z.enum(connectionTlsModes),
})
export type DatabaseInput = z.infer<typeof databaseInputSchema>
