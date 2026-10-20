import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the search for .env starts: the directory of the app being run (the script Node was
 * given), so that a .env beside the app is found before the repository root's; without a script
 * (a REPL, `node -e`), the directory of `moduleUrl`.
 */
export function envSearchStart(entry: string | undefined, moduleUrl: string): string {
  return dirname(entry ? resolve(entry) : fileURLToPath(moduleUrl))
}

/** The nearest .env walking up from `startDir`: only that one file is loaded. */
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
