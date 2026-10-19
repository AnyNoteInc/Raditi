import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { egressHostListSchema } from '../preview/egress-hosts.ts'

/**
 * Environment variables of a client's site (docs/plan/53-chat-preview-release.md, Р13): the
 * value of each in Vault `kv/sites/<siteId>/env/<NAME>` (written by web, never read back),
 * the name and the hosts it may reach in `site_env_vars`. The agent's commands get one only when
 * the client turned `to_agent` on with consent, and a preview — which runs the agent's code —
 * nothing the agent may not see (`envVarReachesPreview`). Names follow an allow pattern and never
 * shadow what the shell, the runtime or the platform reads.
 */
export const ENV_VAR_NAME_PATTERN_SOURCE = '^[A-Z][A-Z0-9_]{1,63}$'
const NAME = new RegExp(ENV_VAR_NAME_PATTERN_SOURCE)

/** Prefixes no client variable may start with. */
export const refusedEnvVarPrefixes = Object.freeze([
  'LD_',
  'DYLD_',
  'NODE_',
  'BUN_',
  'OPENCODE_',
  'RADITI_',
  'GIT_',
  'SSL_',
  'PHP_',
  'WP_',
  'DB_',
  'HTTP_',
  'HTTPS_',
  'XDG_',
  'AUTH_',
  'SECURE_',
  'LOGGED_IN_',
  'NONCE_',
] as const)

/** Whole names no client variable may have; any name ending in `_PROXY` is refused too. */
export const refusedEnvVarNames = Object.freeze([
  'NO_PROXY',
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'BASH_ENV',
  'ENV',
] as const)
const REFUSED_SUFFIX = '_PROXY'

export const envVarLimits = Object.freeze({
  /** Shorter values are too easy to find anywhere, and masking them would garble the text. */
  valueMinBytes: 8,
  valueMaxBytes: 8 * 1024,
  perSite: 64,
})

export type EnvVarNameProblem = 'format' | 'reserved'

/** Why a name is refused, or null when it may be used. */
export function envVarNameProblem(name: string): EnvVarNameProblem | null {
  if (!NAME.test(name)) return 'format'
  if (
    refusedEnvVarPrefixes.some((prefix) => name.startsWith(prefix)) ||
    (refusedEnvVarNames as readonly string[]).includes(name) ||
    name.endsWith(REFUSED_SUFFIX)
  )
    return 'reserved'
  return null
}

export const envVarNameSchema = z.string().superRefine((name, ctx) => {
  const problem = envVarNameProblem(name)
  if (problem === 'format')
    ctx.addIssue({ code: 'custom', message: 'expected capital letters, digits and _' })
  else if (problem === 'reserved')
    ctx.addIssue({ code: 'custom', message: 'the name is reserved by the platform' })
})

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

/** A value: 8 bytes to 8 KiB of well-formed text without NUL. Never logged or returned. */
export const envVarValueSchema = z
  .string()
  .refine((value) => value.isWellFormed() && !value.includes('\0'), 'expected text')
  .refine(
    (value) => utf8Bytes(value) >= envVarLimits.valueMinBytes,
    `must be at least ${envVarLimits.valueMinBytes} bytes`,
  )
  .refine((value) => utf8Bytes(value) <= envVarLimits.valueMaxBytes, 'is too long')

/** What `siteEnv.set` takes; the value goes to Vault and nowhere else. */
export const siteEnvVarInputSchema = z
  .strictObject({
    name: envVarNameSchema,
    value: envVarValueSchema,
    hosts: egressHostListSchema,
    toPreview: z.boolean(),
    toAgent: z.boolean(),
    /** The client read «агент увидит то, что вернёт этот сервис» and agreed. */
    agentConsent: z.boolean(),
  })
  .refine((input) => !input.toAgent || input.agentConsent, {
    message: 'the agent gets a variable only with the consent',
    path: ['agentConsent'],
  })
export type SiteEnvVarInput = z.output<typeof siteEnvVarInputSchema>

const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The only Vault path of a variable's value: `kv/sites/<siteId>/env/<NAME>`. */
export function siteEnvVarPath(siteId: string, name: string): string {
  if (!SITE_ID.test(siteId) || envVarNameProblem(name) !== null)
    throw badRequest('Invalid site variable reference')
  return `kv/sites/${siteId}/env/${name}`
}

/**
 * The data of a variable's key in Vault (`siteEnvVarPath`): the value under `value`. The policy
 * `sites-writer` creates and updates but never deletes, so `siteEnv.remove` writes a version
 * without a value — `{ removed: <ISO time> }` — and a reader takes such a version for an absent
 * variable. Readers trust the key only at the version `site_env_vars.key_version` names.
 */
export const siteEnvVarSecret = (value: string): Record<string, string> => ({ value })

export const siteEnvVarTombstone = (at: Date): Record<string, string> => ({
  removed: at.toISOString(),
})

/** The value a reader takes from the data of the key; null — the variable was removed. */
export const siteEnvVarValueOf = (data: Readonly<Record<string, string>>): string | null =>
  Object.hasOwn(data, 'value') && typeof data.value === 'string' ? data.value : null

/** What of a row of `site_env_vars` decides who gets the value. */
export interface EnvVarRecipients {
  toPreview: boolean
  toAgent: boolean
  /** When the client agreed that the agent sees what the service returns; null — never. */
  agentConsentAt: Date | null
}

/**
 * Whether a workspace of this data class may give its variables to the agent at all (Р13): one
 * of real client data may not until the gate of 152-FZ (rule 1). `siteEnv.list` tells the form,
 * so «Передавать агенту» is off before the client saves.
 */
export const envVarsMayReachAgent = (dataClass: 'synthetic' | 'client'): boolean =>
  dataClass !== 'client'

/**
 * Whether the agent's commands get the value (Р13): the client turned `to_agent` on and agreed,
 * and the workspace holds no real client data — until the gate of 152-FZ nothing of it reaches
 * the agent (rule 1).
 */
export function envVarReachesAgent(
  variable: EnvVarRecipients,
  dataClass: 'synthetic' | 'client',
): boolean {
  return variable.toAgent && variable.agentConsentAt !== null && envVarsMayReachAgent(dataClass)
}

/**
 * Whether a preview's settings file gets the value (`PreviewRuntimeSecrets.env`). A preview runs
 * the agent's code — its themes and plugins are synced in before every browser action (Р22,
 * Р23) — and that code reads whatever the preview's PHP reads, the settings file included, then
 * shows it to the agent through the browser or a post, past any masking of the exact value. So
 * a preview gets only what the agent may see: `to_preview` and `envVarReachesAgent` (plan 53,
 * R5b, 17.10.2026).
 */
export function envVarReachesPreview(
  variable: EnvVarRecipients,
  dataClass: 'synthetic' | 'client',
): boolean {
  return variable.toPreview && envVarReachesAgent(variable, dataClass)
}
