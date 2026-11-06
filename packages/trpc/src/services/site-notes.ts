import type { PrismaClient } from '@repo/db'
import {
  BROWSER_AGENT_NOTES_MAX_CHARS,
  DomainError,
  hasVisibleText,
  looksLikeSecret,
  notesLookLikeSecret,
} from '@repo/domain'
import { z } from 'zod'

import { isManagerRole, memberRole } from './chat/access.ts'
import { accessibleSite, siteNotFound } from './site-basics.ts'

// Hints for the agent the owner writes when a site is added for the browser (docs/plan/57-browser-
// tasks.md, Б8): «вход по адресу /login». They go to the model with every task of the site, so
// they pass the checks of a task's words: refused in the client's terms, never repeated back.
// After that an owner or an admin changes them, from the answer to `/init` (docs/plan/61, К31).

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
export const notesChanged = () =>
  new DomainError('PROJECT_NOTES_CHANGED', 'The hints changed after they were shown', 409)

function notesOf(raw: string | undefined, hasSecret: (text: string) => boolean): string | null {
  const notes = (raw ?? '').trim()
  if (!hasVisibleText(notes)) return null
  if (notes.length > BROWSER_AGENT_NOTES_MAX_CHARS) throw notesTooLong()
  if (forbidden.test(notes) || !notes.isWellFormed()) throw notesInvalid()
  if (hasSecret(notes)) throw notesHaveSecret()
  return notes
}

/**
 * `sites.agent_notes` from what the owner typed: trimmed, null when there is nothing to read; a
 * text over `BROWSER_AGENT_NOTES_MAX_CHARS`, with characters a row does not store or that looks
 * like a password or a key is refused.
 */
export const agentNotesOf = (raw: string | undefined): string | null =>
  notesOf(raw, looksLikeSecret)

/** The same for the answer to `/init`: a text about code, full of names (`notesLookLikeSecret`). */
export const codeNotesOf = (raw: string | undefined): string | null =>
  notesOf(raw, notesLookLikeSecret)

export const notesNotAllowed = () =>
  new DomainError('PROJECT_NOTES_NOT_ALLOWED', 'Only an owner or an admin changes the hints', 403)

export interface SiteAgentNotesView {
  notes: string | null
  /** An owner or an admin: changes them. */
  canManage: boolean
}

async function siteOf(db: PrismaClient, userId: string, siteId: string) {
  const site = await db.site.findFirst({
    where: accessibleSite(userId, siteId),
    select: { id: true, workspaceId: true, agentNotes: true },
  })
  if (!site) throw siteNotFound()
  return site
}

/** The hints of a site as they are now, for every member of its workspace. */
export async function readSiteAgentNotes(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<SiteAgentNotesView> {
  const site = await siteOf(db, input.userId, input.siteId)
  return {
    notes: site.agentNotes,
    canManage: isManagerRole(await memberRole(db, site.workspaceId, input.userId)),
  }
}

/**
 * Replaces the hints of a site with what the client saw and left in the field; an owner or an admin
 * only, audited without the text. Empty clears them. `seen` — the hints the window showed: others
 * written since are not replaced unseen, the window shows them and the client saves again (§5.14).
 */
export async function setSiteAgentNotes(
  db: PrismaClient,
  input: { userId: string; siteId: string; ip: string | null; notes: string; seen: string | null },
): Promise<{ notes: string | null }> {
  const site = await siteOf(db, input.userId, input.siteId)
  if (!isManagerRole(await memberRole(db, site.workspaceId, input.userId))) throw notesNotAllowed()
  const notes = codeNotesOf(input.notes)
  await db.$transaction(async (tx) => {
    const { count } = await tx.site.updateMany({
      where: { id: site.id, agentNotes: input.seen },
      data: { agentNotes: notes },
    })
    if (count === 0) throw notesChanged()
    await tx.auditLog.create({
      data: {
        actorType: 'user',
        actorId: input.userId,
        workspaceId: site.workspaceId,
        action: 'site.agent_notes.change',
        targetType: 'site',
        targetId: site.id,
        ip: input.ip,
        meta: { cleared: notes === null },
      },
    })
  })
  return { notes }
}
