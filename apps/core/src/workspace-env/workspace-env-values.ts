import {
  envVarNameProblem,
  envVarValueSchema,
  workspaceEnvVarPath,
  workspaceEnvVarValueOf,
  type SecretStore,
} from '@repo/domain'

/** A variable of a workspace as its row in `workspace_env_vars` names it, the Vault version included. */
export interface WorkspaceEnvVarVersion {
  name: string
  keyVersion: number
}

/**
 * The values of a workspace's variables («Настройки → Переменные», docs/plan/83-remove-projects.md,
 * БП4), by name, read by `core` from Vault `kv/workspaces/<workspaceId>/env/<NAME>` (policy
 * `core-workspace-env`) at the version each row names. A key at another version is a write the
 * row has not recorded yet, and a removed one (`workspaceEnvVarValueOf` → null) is gone: both are
 * left out. Never logged, never stored in SQL.
 */
export async function readWorkspaceEnvValues(
  secrets: Pick<SecretStore, 'kvRead'>,
  workspaceId: string,
  variables: readonly WorkspaceEnvVarVersion[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const variable of variables) {
    if (envVarNameProblem(variable.name) !== null) continue
    const secret = await secrets.kvRead(workspaceEnvVarPath(workspaceId, variable.name))
    if (!secret || secret.version !== variable.keyVersion) continue
    const value = workspaceEnvVarValueOf(secret.data)
    if (value !== null && envVarValueSchema.safeParse(value).success) values[variable.name] = value
  }
  return values
}

/**
 * The values of a workspace's variables as Vault holds them now, whatever version the rows name —
 * for a refusal (`containsEnvValue`, `envValueInContent`): a value the client has just changed is
 * refused before its row records the new version. Vault keeps one version of each, so the current
 * one is the only one there; a removed variable has none.
 */
export async function readWorkspaceEnvValuesToRefuse(
  secrets: Pick<SecretStore, 'kvRead'>,
  workspaceId: string,
  names: readonly string[],
): Promise<string[]> {
  const values: string[] = []
  for (const name of new Set(names)) {
    if (envVarNameProblem(name) !== null) continue
    const secret = await secrets.kvRead(workspaceEnvVarPath(workspaceId, name))
    const value = secret ? workspaceEnvVarValueOf(secret.data) : null
    if (value !== null && value.length > 0) values.push(value)
  }
  return values
}
