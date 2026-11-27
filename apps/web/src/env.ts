import 'server-only'

import { authConfigFromEnv, type AuthConfig } from '@repo/auth'
import { storageConfigFromEnv, type StorageConfig } from '@repo/storage'
import { telegramConfigFromEnv, type TelegramConfig } from '@repo/telegram'
import { vaultConfigFromEnv, type VaultConfig } from '@repo/vault'
import { vkConfigFromEnv, type VkConfig } from '@repo/vk'
import { yookassaConfigFromEnv, type YookassaConfig } from '@repo/yookassa'

import { webGitEnvFromEnv, type WebGitEnv } from '@/server/git-env'
import { webEnvFromEnv } from '@/server/web-env'

// DATABASE_URL is read by @repo/db itself on first use (dbConfigFromEnv).

/** Parses on first use and remembers the result; a failure is retried next time. */
function lazy<T>(read: () => T): () => T {
  let parsed: { value: T } | undefined
  return () => {
    parsed ??= { value: read() }
    return parsed.value
  }
}

/**
 * Server configuration, section by section. Nothing is read at import time, so `next build`
 * needs no secrets, and in development a broken section (say, S3) fails only the code that uses
 * it. In production every section is checked at start (instrumentation.ts).
 */
export const env = {
  web: lazy(() => webEnvFromEnv(process.env)),
  auth: lazy((): AuthConfig => authConfigFromEnv(process.env)),
  storage: lazy((): StorageConfig => storageConfigFromEnv(process.env)),
  vault: lazy((): VaultConfig => vaultConfigFromEnv(process.env)),
  /** null — payments are off: both shop credentials are empty. */
  yookassa: lazy((): YookassaConfig | null => yookassaConfigFromEnv(process.env)),
  /** null — the bot of the chat is off: TELEGRAM_BOT_TOKEN is empty (docs/plan/80-telegram.md). */
  telegram: lazy((): TelegramConfig | null => telegramConfigFromEnv(process.env)),
  /** The apps of the repositories of projects (docs/plan/84-projects.md, §4.5); each part may be off. */
  git: lazy((): WebGitEnv => webGitEnvFromEnv(process.env)),
  // The secret of the cards of VK (docs/plan/99-vk-community.md, §3.3).
  vk: lazy((): VkConfig => vkConfigFromEnv(process.env)),
}
