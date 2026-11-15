import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { envVarNameProblem, envVarNameSchema, envVarValueSchema } from '../release/env-vars.ts'

/**
 * Variables of a workspace (docs/plan/83-remove-projects.md, БП4): «Настройки → Переменные».
 * The value of each lies in Vault `kv/workspaces/<workspaceId>/env/<NAME>` (written by web,
 * never read back there), the name in `workspace_env_vars`. Every turn of every chat of the
 * workspace gets them all in the agent's `bash` commands — no consent per variable — unless the
 * workspace holds real client data and the gate of 152-FZ is not passed (rule 1).
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

/** Whether the agent of a workspace of this data class gets its variables (rule 1). */
export const workspaceEnvVarsReachAgent = (dataClass: 'synthetic' | 'client'): boolean =>
  dataClass !== 'client'
