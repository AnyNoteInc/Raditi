import { hkdfSync } from 'node:crypto'

import {
  DomainError,
  type AppEnv,
  type ObjectStorage,
  type PreviewAddress,
  type SecretStore,
  type SiteStack,
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
  /**
   * The cloud browser of tasks (docs/plan/57-browser-tasks.md, Б9, Б12): `streamUrl` is where the
   * cabinet opens the stream of a session (BROWSER_STREAM_PUBLIC_URL, `ws(s)://…`). Absent or
   * null — the platform has no browser here: no site offers tasks in it, and no ticket is issued.
   */
  browser?: { streamUrl: string } | null
  /**
   * Whether a release of the site's stack replays operations of its database: the adapter of the
   * stack declares at least one kind (`SiteAdapter.dbOperationKinds`;
   * docs/plan/59-dialog-tools-panel.md, И6). The app asks the adapter, as core does for a release:
   * @repo/trpc knows no adapter and compares no stack (rule 8). Absent — none does here, and no
   * dialog offers the tool «База данных».
   */
  databaseOperations?: SiteDatabaseOperations
  /** The HMAC key of release confirmations: `releaseConfirmKey(BETTER_AUTH_SECRET)`. */
  releaseConfirmKey: Uint8Array
  /** `raditi-artifacts`: the diff of a candidate (`candidate.fileDiff`). */
  storage: () => ObjectStorage
  /**
   * Vault under the policies `sites-writer` and `workspace-provisioner`: the values of the
   * client's variables are written and never read back (`siteEnv.*`), and the Transit key of a
   * workspace is made before its first task (`task.create`; docs/plan/57-browser-tasks.md, Б32).
   * Three methods, not the store, as the wizard's (spec §15): web shares its AppRole with `core`
   * at MVP (П9), so nothing that holds this object can call `kvRead`.
   */
  secrets: () => SiteSecretWriter
}

/**
 * What a procedure may do with Vault: write a value by CAS, read a key's versions, and create
 * the Transit key of a workspace when it is missing — never read, export or remove one.
 */
export type SiteSecretWriter = Pick<SecretStore, 'kvWrite' | 'kvMetadata' | 'transitEnsureKey'>

/**
 * Asks the adapter of a site's stack whether a release replays operations of the database: true
 * when it declares a kind, false for a stack it has no adapter for. Never throws.
 */
export type SiteDatabaseOperations = (site: { stack: SiteStack; url: string }) => boolean

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

export const browserUnavailable = () =>
  new DomainError('BROWSER_UNAVAILABLE', 'The cloud browser is not set up in this process', 503)

/** Whether the cabinet of this process can show a browser of the platform (Б9). */
export const browserConfigured = (context: { chat?: ChatContext | null }): boolean =>
  context.chat?.browser != null

/** Where the cabinet opens the stream of a browser, or the refusal that there is none. */
export function browserStreamUrlOf(chat: ChatContext): string {
  if (chat.browser == null) throw browserUnavailable()
  return chat.browser.streamUrl
}
