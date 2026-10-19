import { hkdfSync } from 'node:crypto'

import {
  DomainError,
  type AppEnv,
  type ObjectStorage,
  type PreviewAddress,
  type SecretStore,
} from '@repo/domain'

/**
 * What the procedures of a dialog reach outside the database (docs/plan/53-chat-preview-release.md).
 * The app builds it once per process; the adapters behind `storage` and `secrets` are made on
 * first use, so a broken S3 or Vault section fails only the procedure that needs it.
 */
export interface ChatContext {
  /** APP_ENV: outside production a dialog is taken only in a synthetic workspace (rule 1). */
  appEnv: AppEnv
  /**
   * Where previews are served and how long an unviewed one lives (PREVIEW_BASE_DOMAIN,
   * PREVIEW_SCHEME, PREVIEW_PUBLIC_PORT, PREVIEW_TTL_HOURS). null — previews are not set up
   * here: a dialog gets no preview row, and `/preview` answers that there is none.
   */
  preview: { address: PreviewAddress; ttlHours: number } | null
  /** The HMAC key of release confirmations: `releaseConfirmKey(BETTER_AUTH_SECRET)`. */
  releaseConfirmKey: Uint8Array
  /** `raditi-artifacts`: the diff of a candidate (`candidate.fileDiff`). */
  storage: () => ObjectStorage
  /**
   * Vault under the policy `sites-writer`: the values of the client's variables are written and
   * never read back (`siteEnv.*`). Two methods, not the store, as the wizard's (spec §15): web
   * shares its AppRole with `core` at MVP (П9), so nothing that holds this object can call
   * `kvRead`.
   */
  secrets: () => SiteSecretWriter
}

/** What a procedure may do with Vault: write a value by CAS and read a key's versions. */
export type SiteSecretWriter = Pick<SecretStore, 'kvWrite' | 'kvMetadata'>

/** The `info` of HKDF: a key of its own, never the secret of the sessions itself. */
export const RELEASE_CONFIRM_KEY_INFO = 'raditi-release-confirm-v1'

/**
 * The key `release.prepare` signs a confirmation with and `release.confirm` checks it by:
 * HKDF-SHA256 of BETTER_AUTH_SECRET with its own `info`, 32 bytes. Every web replica derives the
 * same key; rotating the secret of the sessions voids the confirmations in flight, nothing else.
 */
export function releaseConfirmKey(secret: string): Uint8Array {
  if (secret.length === 0) throw new Error('The secret of release confirmations is empty')
  return new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), RELEASE_CONFIRM_KEY_INFO, 32))
}

/** The dialog context of a procedure, or the refusal that dialogs are not set up. */
export function chatContextOf(context: { chat?: ChatContext | null }): ChatContext {
  if (context.chat == null) {
    throw new DomainError('CHAT_NOT_CONFIGURED', 'Dialogs are not set up in this process', 503)
  }
  return context.chat
}
