import 'server-only'

import type { ObjectStorage } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { createS3ObjectStorage } from '@repo/storage'
import { pageKeys, type ChatContext, type ChatSecretWriter } from '@repo/trpc'
import { createVaultSecretStore } from '@repo/vault'

import { env } from '@/env'

import { taskSignals } from './task-signals'

/**
 * Three methods of the store, not the store (spec §15): web shares its
 * AppRole with `core` at MVP (П9), and in dev it holds the root token, so nothing a procedure
 * holds can call `kvRead`. `transitEnsureKey` makes the key of a workspace before its first task
 * (docs/plan/57-browser-tasks.md, Б32).
 */
function writerOf(store: ReturnType<typeof createVaultSecretStore>): ChatSecretWriter {
  return {
    kvWrite: (path, data, options) => store.kvWrite(path, data, options),
    kvMetadata: (path) => store.kvMetadata(path),
    transitEnsureKey: (key) => store.transitEnsureKey(key),
  }
}

/** The username of the bot of the chat; null — no Telegram here, or the section does not parse. */
function telegramBot(): string | null {
  try {
    return env.telegram()?.botUsername ?? null
  } catch (error) {
    report('telegram', error)
    return null
  }
}

let built: ChatContext | undefined
let storage: ObjectStorage | undefined
let secrets: ChatSecretWriter | undefined
// A broken section is told to the log once per minute, not once per request.
const report = throttledLogger((line) => console.error(`[chat] ${line}`))

/**
 * What the procedures of a chat reach outside the database (docs/plan/53-chat-preview-release.md):
 * the environment, where the stream of a chat's browser is opened (docs/plan/57-browser-tasks.md),
 * the inbox and Vault.
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
      browser: web.browserStreamUrl === null ? null : { streamUrl: web.browserStreamUrl },
      webPushPublicKey: web.webPushPublicKey,
      telegramBot: telegramBot(),
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
      storage: () => (storage ??= createS3ObjectStorage(env.storage())),
      secrets: () => (secrets ??= writerOf(createVaultSecretStore(env.vault()))),
      // The signals of changed chats (spec §7): one subscriber of Redis for the process.
      signals: taskSignals(),
    }
    return built
  } catch (error) {
    report('dialogs: settings', error)
    return null
  }
}
