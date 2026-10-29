import type { PrismaClient } from '@repo/db'
import {
  browserSignInSchema,
  envVarNameProblem,
  envVarValueSchema,
  siteEnvVarPath,
  siteEnvVarValueOf,
  siteSignInEnvVars,
  type BrowserSignIn,
  type SecretStore,
} from '@repo/domain'

/** A variable of a site as its row in `site_env_vars` names it: the Vault version included. */
export interface SiteEnvVarVersion {
  name: string
  keyVersion: number
}

/**
 * The values of a site's variables (docs/plan/53-chat-preview-release.md, Р13), by name, read
 * by `core` from Vault `kv/sites/<siteId>/env/<NAME>` (policy `core-release`) at the version each
 * row names. A key at another version is a write the row has not recorded yet, and a removed one
 * (`siteEnvVarValueOf` → null) is gone: both are left out. Never logged, never stored in SQL.
 *
 * The turn's credential source reads the variables the agent gets this way: the version the
 * row names is the one the client agreed to give it. What refuses values reads them with
 * `readSiteEnvValuesToRefuse`.
 */
export async function readSiteEnvValues(
  secrets: Pick<SecretStore, 'kvRead'>,
  siteId: string,
  variables: readonly SiteEnvVarVersion[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const variable of variables) {
    if (envVarNameProblem(variable.name) !== null) continue
    const secret = await secrets.kvRead(siteEnvVarPath(siteId, variable.name))
    if (!secret || secret.version !== variable.keyVersion) continue
    const value = siteEnvVarValueOf(secret.data)
    if (value !== null && envVarValueSchema.safeParse(value).success) values[variable.name] = value
  }
  return values
}

/**
 * The values of a site's variables as Vault holds them now, whatever version the rows name — for
 * a refusal (`containsEnvValue`, `envValueInContent`, `envValueInChange`): a value the client
 * has just changed is refused before its row records the new version, and one the preview got
 * after the turn's key was issued is refused as well. Vault keeps one version of each, so the
 * current one is the only one there; a removed variable has none.
 */
export async function readSiteEnvValuesToRefuse(
  secrets: Pick<SecretStore, 'kvRead'>,
  siteId: string,
  names: readonly string[],
): Promise<string[]> {
  const values: string[] = []
  for (const name of new Set(names)) {
    if (envVarNameProblem(name) !== null) continue
    const secret = await secrets.kvRead(siteEnvVarPath(siteId, name))
    const value = secret ? siteEnvVarValueOf(secret.data) : null
    if (value !== null && value.length > 0) values.push(value)
  }
  return values
}

/**
 * The site's saved sign-in to its admin pages (owner's decision of 28.10.2026, Б36): both
 * variables of `siteSignInEnvVars` at the versions their rows name, for the browser of a task
 * only — never the agent's commands, a preview or the model. null — either is not set.
 */
export async function readSiteSignIn(
  db: Pick<PrismaClient, 'siteEnvVar'>,
  secrets: Pick<SecretStore, 'kvRead'>,
  siteId: string,
): Promise<BrowserSignIn | null> {
  const { login, password } = siteSignInEnvVars
  const rows = await db.siteEnvVar.findMany({
    where: { siteId, name: { in: [login, password] } },
    select: { name: true, keyVersion: true },
  })
  if (rows.length < 2) return null
  const values = await readSiteEnvValues(secrets, siteId, rows)
  const signIn = browserSignInSchema.safeParse({ login: values[login], password: values[password] })
  return signIn.success ? signIn.data : null
}
