import {
  BROWSER_AGENT_NOTES_MAX_CHARS,
  DomainError,
  hasVisibleText,
  looksLikeSecret,
} from '@repo/domain'
import { z } from 'zod'

// Hints for the agent the owner writes when a site is added for the browser (docs/plan/57-browser-
// tasks.md, Б8): «вход по адресу /login». They go to the model with every task of the site, so
// they pass the checks of a task's words: refused in the client's terms, never repeated back.

/** Bounds the body; the length stored is checked after trimming, in the client's words. */
export const agentNotesInput = z.string().max(BROWSER_AGENT_NOTES_MAX_CHARS * 4)

// What a row may not store: control characters other than a line break and a tab.
const forbidden = /[^\P{Cc}\n\t]/u

export const notesTooLong = () =>
  new DomainError('PROJECT_NOTES_TOO_LONG', 'The hints for the agent are too long', 400)
/** The text is never repeated in the message. */
export const notesHaveSecret = () =>
  new DomainError('PROJECT_NOTES_HAS_SECRET', 'The hints look like a password or a key', 400)
export const notesInvalid = () =>
  new DomainError('PROJECT_NOTES_INVALID', 'The hints have characters a row does not store', 400)

/**
 * `sites.agent_notes` from what the owner typed: trimmed, null when there is nothing to read; a
 * text over `BROWSER_AGENT_NOTES_MAX_CHARS`, with characters a row does not store or that looks
 * like a password or a key is refused.
 */
export function agentNotesOf(raw: string | undefined): string | null {
  const notes = (raw ?? '').trim()
  if (!hasVisibleText(notes)) return null
  if (notes.length > BROWSER_AGENT_NOTES_MAX_CHARS) throw notesTooLong()
  if (forbidden.test(notes) || !notes.isWellFormed()) throw notesInvalid()
  if (looksLikeSecret(notes)) throw notesHaveSecret()
  return notes
}
