import { z } from 'zod'

import { badRequest } from '../errors.ts'

/**
 * Names and values of a client's variables (first those of a site, docs/plan/53, Р13; since
 * plan 83 those of a workspace, below). Names follow an allow pattern and never shadow what the
 * shell, the runtime or the platform reads.
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
  /** Any value that is not empty (owner's decision of 25.10.2026). */
  valueMinBytes: 1,
  /**
   * The shortest value that is masked and refused in kept and published text
   * (`envValueForms`): a shorter one is too easy to find anywhere — masking it would garble the
   * feed and refuse nearly every change — and it is no secret either.
   */
  maskMinBytes: 8,
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

/** A value: 1 byte to 8 KiB of well-formed text without NUL. Never logged or returned. */
export const envVarValueSchema = z
  .string()
  .refine((value) => value.isWellFormed() && !value.includes('\0'), 'expected text')
  .refine(
    (value) => utf8Bytes(value) >= envVarLimits.valueMinBytes,
    `must be at least ${envVarLimits.valueMinBytes} bytes`,
  )
  .refine((value) => utf8Bytes(value) <= envVarLimits.valueMaxBytes, 'is too long')

/**
 * Variables of a workspace (docs/plan/83-remove-projects.md, БП4): «Настройки → Переменные».
 * The value of each lies in Vault `kv/workspaces/<workspaceId>/env/<NAME>` (written by web,
 * never read back there), the name in `workspace_env_vars`. Every turn of every chat of the
 * workspace gets them all in the agent's `bash` commands as soon as they are saved — no consent
 * per variable and, since the owner's decision of 17.11.2026, no gate by the data class of the
 * workspace either.
 */
export const workspaceEnvVarLimits = Object.freeze({ perWorkspace: 64 })

/** What `workspaceEnv.set` takes; the value goes to Vault and nowhere else. */
export const workspaceEnvVarInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  name: envVarNameSchema,
  value: envVarValueSchema,
})
export type WorkspaceEnvVarInput = z.output<typeof workspaceEnvVarInputSchema>

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The only Vault path of a variable's value: `kv/workspaces/<workspaceId>/env/<NAME>`. */
export function workspaceEnvVarPath(workspaceId: string, name: string): string {
  if (!ID.test(workspaceId) || envVarNameProblem(name) !== null)
    throw badRequest('Invalid workspace variable reference')
  return `kv/workspaces/${workspaceId}/env/${name}`
}

/** The data of the key: the value under `value`. */
export const workspaceEnvVarSecret = (value: string): Record<string, string> => ({ value })

/**
 * The writer's policy creates and updates but never deletes, so removing a variable writes a
 * version without a value — `{ removed: <ISO time> }` — and a reader takes it for an absent one.
 * Readers trust the key only at the version `workspace_env_vars.key_version` names.
 */
export const workspaceEnvVarTombstone = (at: Date): Record<string, string> => ({
  removed: at.toISOString(),
})

/** The value a reader takes from the data of the key; null — the variable was removed. */
export const workspaceEnvVarValueOf = (data: Readonly<Record<string, string>>): string | null =>
  Object.hasOwn(data, 'value') && typeof data.value === 'string' ? data.value : null
