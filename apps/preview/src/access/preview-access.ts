import type { PreviewSessionKind, PreviewStatus } from '@repo/domain'

/**
 * What the gateway of previews reads and writes (docs/plan/53-chat-preview-release.md, Р19):
 * the preview of an exact host, one-time tickets and the sessions they open. Nothing here takes
 * an upstream from a request: the address of a preview is the one its row holds.
 */

/** The preview behind one host, as the gateway routes by it. */
export interface PreviewRoute {
  id: string
  siteId: string
  hostname: string
  status: PreviewStatus
  revision: number
  /** Bumped to end every session of the preview at once. */
  accessEpoch: number
  /** null — no container answers yet. */
  upstream: { host: string; port: number } | null
}

export interface PreviewSessionRecord {
  id: string
  previewId: string
  /** null — the session of the agent's browser (kind browser). */
  userId: string | null
  kind: PreviewSessionKind
  accessEpoch: number
  expiresAt: Date
  revokedAt: Date | null
  /** Membership and the status of the site were last checked then; null — never. */
  checkedAt: Date | null
}

export interface EnterInput {
  previewId: string
  /** previewTicketHash() of the ticket. */
  tokenHash: string
  /** user — a visitor's browser; browser — the agent's browser through a relay. */
  kind: PreviewSessionKind
}

export interface PreviewAccessStore {
  /** The preview of this exact hostname; null — none, or it is destroyed. */
  route(hostname: string): Promise<PreviewRoute | null>
  /**
   * Spends a ticket of this preview and kind and opens a session in one transaction. null — the
   * ticket is unknown, spent, expired, of another preview or of the other kind (then it is left
   * as it was), or (kind user) its user may not open the preview any more, or the site is closed
   * (then it stays spent).
   */
  enter(input: EnterInput): Promise<PreviewSessionRecord | null>
  session(id: string): Promise<PreviewSessionRecord | null>
  /**
   * Checks again that the session may still open its preview — the user is a member of the
   * site's workspace, the site is neither paused, disconnected nor archived, the access epoch
   * has not moved — and records when. A failed check revokes the session for good.
   */
  recheck(sessionId: string): Promise<{ checkedAt: Date } | null>
}

/** How long a session lives (Р19): the cookie carries no Max-Age, the row ends it. */
export const PREVIEW_SESSION_HOURS = 12

/** The site statuses that close every way into its previews. */
export const CLOSED_SITE_STATUSES = ['paused', 'disconnected', 'archived'] as const
