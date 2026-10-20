import { dbConfigFromEnv, type DbConfig } from '@repo/db'
import { appEnvSchema, envProblems, envVar, type Env } from '@repo/domain'
import { DEV_METRICS_TOKEN, metricsTokenProblem } from '@repo/observability'
import { ConfigError } from '@repo/app-bootstrap'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { z } from 'zod'

import { llmConfigFromEnv, type LlmConfig } from './llm-config.ts'

export { ConfigError }

/** Everything the llm role needs. Holds credentials: never log it. */
export type LlmRoleConfig = LlmConfig & { db: DbConfig; vault: VaultConfig; metricsToken: string }

const ownEnvSchema = z.object({
  // Required, never defaulted: a missing APP_ENV must not switch the production checks off.
  APP_ENV: envVar(appEnvSchema),
  // `Authorization: Bearer <token>` carries one word: a space or a trailing line break from a
  // secret template would leave /metrics, /health details and the pool probe closed for good.
  METRICS_TOKEN: envVar(
    z
      .string()
      .regex(/^\S+$/, 'must not contain whitespace (it is sent as a Bearer token)')
      .optional(),
  ),
})

/**
 * The settings of the subscription gateway (spec §5, §15) and nothing else: the database, Vault
 * and the gateway's own variables. It opens no letter, charges nothing and reads none of the
 * shop, storage, Redis or git settings. Lists every problem at once.
 */
export function loadLlmConfig(env: Env): LlmRoleConfig {
  const own = ownEnvSchema.safeParse(env)
  if (!own.success) throw new ConfigError(envProblems(own.error), 'llm')
  const { APP_ENV: appEnv, METRICS_TOKEN: metricsToken } = own.data
  const problems: string[] = []
  const section = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
      return undefined
    }
  }
  // It opens /metrics and the pool probe endpoint core calls: no other role checks it for it.
  const tokenProblem = metricsTokenProblem(metricsToken, appEnv)
  if (tokenProblem) problems.push(`METRICS_TOKEN: ${tokenProblem}`)
  const db = section(() => dbConfigFromEnv(env))
  const vault = section(() => vaultConfigFromEnv(env))
  const llm = section(() => llmConfigFromEnv(env, appEnv))
  if (problems.length > 0 || db === undefined || vault === undefined || llm === undefined)
    throw new ConfigError(problems, 'llm')
  return { ...llm, db, vault, metricsToken: metricsToken ?? DEV_METRICS_TOKEN }
}
