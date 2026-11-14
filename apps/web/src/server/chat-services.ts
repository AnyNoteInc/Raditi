import 'server-only'

import {
  envVar,
  isDomainError,
  parseEnv,
  previewDefaults,
  type Env,
  type ObjectStorage,
  type SiteStack,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { getSiteAdapter } from '@repo/site-adapters'
import { createS3ObjectStorage } from '@repo/storage'
import { pageKeys, releaseConfirmKey, type ChatContext, type SiteSecretWriter } from '@repo/trpc'
import { createVaultSecretStore } from '@repo/vault'
import { z } from 'zod'

import { env } from '@/env'

// PREVIEW_TTL_HOURS with the bounds and the default of the core role
// (apps/core/src/config/config.ts): web writes `expires_at` of a new preview by it.
const ttlSchema = z.object({
  PREVIEW_TTL_HOURS: envVar(
    z.coerce.number().int().min(1).max(720).default(previewDefaults.ttlHours),
  ),
})

/** How long an unviewed preview lives, in hours. */
export function previewTtlHours(source: Env): number {
  return parseEnv('web', ttlSchema, source).PREVIEW_TTL_HOURS
}

/**
 * Three methods of the store, not the store (spec §15, as `siteConnections` does): web shares its
 * AppRole with `core` at MVP (П9), and in dev it holds the root token, so nothing a procedure
 * holds can call `kvRead`. `transitEnsureKey` makes the key of a workspace before its first task
 * (docs/plan/57-browser-tasks.md, Б32).
 */
function writerOf(store: ReturnType<typeof createVaultSecretStore>): SiteSecretWriter {
  return {
    kvWrite: (path, data, options) => store.kvWrite(path, data, options),
    kvMetadata: (path) => store.kvMetadata(path),
    transitEnsureKey: (key) => store.transitEnsureKey(key),
  }
}

/** Whether the adapter of a stack works in the site's admin pages (`SiteAdapter.browserGuide`). */
export function browserSupported(stack: SiteStack): boolean {
  try {
    getSiteAdapter(stack).browserGuide()
    return true
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_IMPLEMENTED') return false
    throw error
  }
}

let built: ChatContext | undefined
let storage: ObjectStorage | undefined
let secrets: SiteSecretWriter | undefined
// A broken section is told to the log once per minute, not once per request.
const report = throttledLogger((line) => console.error(`[chat] ${line}`))

/**
 * What the procedures of a dialog reach outside the database (docs/plan/53-chat-preview-release.md):
 * the environment, where previews are served, where the stream of a task's browser is opened
 * (docs/plan/57-browser-tasks.md), the key of release confirmations, the artifacts and Vault.
 * Built on first use and kept for the process; the S3 and Vault clients are made only when a
 * procedure needs them. Every tRPC context asks for it: a section that does not parse
 * makes it null — the procedures of a dialog answer that dialogs are unavailable, the other
 * pages work — and it is read again on the next request.
 */
export function chatServices(): ChatContext | null {
  if (built !== undefined) return built
  try {
    const web = env.web()
    built = {
      appEnv: web.appEnv,
      preview:
        web.preview === null
          ? null
          : { address: web.preview, ttlHours: previewTtlHours(process.env) },
      browser: web.browserStreamUrl === null ? null : { streamUrl: web.browserStreamUrl },
      browserSupported,
      pages: web.pages,
      // The domain of the pages the agent makes (docs/plan/67-agent-documents.md, Д3, Д8).
      pageViews:
        web.pageViews == null
          ? null
          : {
              origin: web.pageViews.origin,
              appUrl: web.appUrl,
              keys: pageKeys(web.pageViews.secret),
            },
      releaseConfirmKey: releaseConfirmKey(env.auth().secret),
      storage: () => (storage ??= createS3ObjectStorage(env.storage())),
      secrets: () => (secrets ??= writerOf(createVaultSecretStore(env.vault()))),
    }
    return built
  } catch (error) {
    report('dialogs: settings', error)
    return null
  }
}
