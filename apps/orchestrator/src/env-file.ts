import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The nearest .env walking up from `startDir` (normally the repo root). */
export function findEnvFile(startDir: string): string | undefined {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

export interface LoadRepoEnvOptions {
  startDir: string
  nodeEnv: string | undefined
  load?: (path: string) => void
}

/**
 * Loads the repo .env for local runs; returns its path. Never in production: there every
 * variable comes from the deployment, and a stray .env must not override or add to them.
 * Variables that are already set win: process.loadEnvFile never overrides them.
 */
export function loadRepoEnv({
  startDir,
  nodeEnv,
  load = (path) => process.loadEnvFile(path),
}: LoadRepoEnvOptions): string | undefined {
  if (nodeEnv === 'production') return undefined
  const envFile = findEnvFile(startDir)
  if (envFile) load(envFile)
  return envFile
}
