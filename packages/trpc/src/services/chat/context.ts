import {
  DomainError,
  type AppEnv,
  type ObjectStorage,
  type PagesAddress,
  type SecretStore,
} from '@repo/domain'

import type { PageKeys } from './page-tokens.ts'

/**
 * What the procedures of a dialog reach outside the database (docs/plan/53-chat-preview-release.md).
 * The app builds it once per process; the adapters behind `storage` and `secrets` are made on
 * first use, so a broken S3 or Vault section fails only the procedure that needs it.
 */
export interface ChatContext {
  /** APP_ENV: outside production a dialog is taken only in a synthetic workspace (rule 1). */
  appEnv: AppEnv
  /**
   * The cloud browser of tasks (docs/plan/57-browser-tasks.md, Б9, Б12): `streamUrl` is where the
   * cabinet opens the stream of a session (BROWSER_STREAM_PUBLIC_URL, `ws(s)://…`). Absent or
   * null — the platform has no browser here: chats get none, and no ticket is issued.
   */
  browser?: { streamUrl: string } | null
  /**
   * The public VAPID key of Web Push (WEB_PUSH_VAPID_PUBLIC, docs/plan/75-chat-input-output.md, ВВ8):
   * the cabinet subscribes a browser with it. Absent or null — no notifications in browsers.
   */
  webPushPublicKey?: string | null
  /**
   * Where published pages answer (docs/plan/69-pages.md, Ст3): the cabinet names their address.
   * Absent or null — no pages here: the section «Страницы» says so.
   */
  pages?: PagesAddress | null
  /**
   * The root of the domain of pages, where the frame of the cabinet opens a page of a chat
   * (docs/plan/67-agent-documents.md, Д3): its origin (from PAGES_BASE_DOMAIN, docs/plan/69-pages.md,
   * Ст3), the key of its tokens (PAGES_SIGNING_SECRET) and the cabinet's origin that frames it
   * (APP_URL). Absent or null — no page is shown here: the cabinet only downloads one.
   */
  pageViews?: { origin: string; appUrl: string; keys: PageKeys } | null
  /**
   * The username of the bot of the chat in Telegram (TELEGRAM_BOT_USERNAME, docs/plan/80-telegram.md):
   * the cabinet links Telegram through `t.me/<bot>`. Absent or null — no Telegram here.
   */
  telegramBot?: string | null
  /** `raditi-inbox`: the files of messages, removed while unsent (`attachment.remove`). */
  storage: () => ObjectStorage
  /**
   * Vault under the policies `sites-writer` and `workspace-provisioner`: the values of the
   * variables of a workspace are written and never read back (`workspaceEnv.*`;
   * docs/plan/83-remove-projects.md, БП4), and the Transit key of a workspace is made before its
   * first task (`task.create`; docs/plan/57-browser-tasks.md, Б32). Three methods, not the store
   * (spec §15): web shares its AppRole with `core` at MVP (П9), so nothing that holds this object
   * can call `kvRead`.
   */
  secrets: () => ChatSecretWriter
}

/**
 * What a procedure may do with Vault: write a value by CAS, read a key's versions, and create
 * the Transit key of a workspace when it is missing — never read, export or remove one.
 */
export type ChatSecretWriter = Pick<SecretStore, 'kvWrite' | 'kvMetadata' | 'transitEnsureKey'>

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
