import {
  feedCandidateText,
  feedCandidateVersionText,
  feedCreditsSentence,
  feedDecisionText,
  feedFilesChangedText,
  feedMediaAddedText,
  feedRecordsChangedText,
  feedReleaseKeptText,
  feedReleaseReasonText,
  feedReleaseText,
  feedReleaseTitle,
  feedUndoConfirmedText,
  feedUndoKeptText,
  feedUndoReasonText,
  feedUndoText,
  feedUndoTitle,
  feedUpdateText,
  feedUpdateTitle,
  feedVersionBumpLabel,
} from '@repo/domain/tasks/client-feed-labels'

import type { FeedRow } from './chat-types'

// The rows of the sites of clients that are no more (docs/plan/83-remove-projects.md): the changes
// ready for a site, the decisions and the outcomes of a release, of its undo and of «Обновить».
// Nothing makes them any longer, but the history of a chat keeps them, and they still read: one
// compact row each, its title and its words (docs/plan/96-review-fixes.md, P33.7).

/** A row of the sites of before. */
export type LegacyRow = Extract<
  FeedRow,
  { type: 'feed.candidate' | 'feed.decision' | 'feed.release' | 'feed.undo' | 'feed.update' }
>

/** What an old row says: a title (none for a press of the client), its words, a failure or not. */
export interface LegacyRowText {
  title: string | null
  text: string
  failed: boolean
}

const sentences = (parts: readonly (string | null | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')

export function legacyRowText(row: LegacyRow): LegacyRowText {
  switch (row.type) {
    case 'feed.candidate': {
      const changed = row.files.added + row.files.modified + row.files.deleted
      const bump = row.bump ? ` (${feedVersionBumpLabel[row.bump].toLocaleLowerCase('ru')})` : ''
      return {
        title: feedCandidateText.title,
        text: sentences([
          `${feedCandidateVersionText(row.version)}${bump}.`,
          changed > 0 ? feedFilesChangedText(changed) : null,
          row.media > 0 ? feedMediaAddedText(row.media) : null,
          row.records > 0 ? feedRecordsChangedText(row.records) : null,
        ]),
        failed: false,
      }
    }
    case 'feed.decision':
      return { title: null, text: feedDecisionText(row.version), failed: false }
    case 'feed.release':
      return {
        title: feedReleaseTitle[row.outcome],
        text: sentences([
          feedReleaseText(row.outcome, row.version),
          row.reason === null ? null : feedReleaseReasonText[row.reason],
          ...feedReleaseKeptText(row.kept),
          feedCreditsSentence(row.credits),
        ]),
        failed: row.outcome !== 'installed' && row.outcome !== 'unknown',
      }
    case 'feed.undo':
      if (row.stage === 'confirmed')
        return { title: null, text: feedUndoConfirmedText(row.undoneVersion), failed: false }
      return {
        title: feedUndoTitle[row.stage],
        text: sentences([
          feedUndoText(row.stage, {
            undone: row.undoneVersion,
            version: row.version,
            returnsTo: row.returnsTo,
          }),
          row.reason === null ? null : feedUndoReasonText(row.reason),
          row.stage === 'installed' ? feedUndoKeptText(row.records.kept) : null,
        ]),
        failed: row.stage !== 'installed' && row.stage !== 'unknown',
      }
    case 'feed.update':
      return {
        title: feedUpdateTitle[row.outcome],
        text: feedUpdateText(row.outcome, row.conflicts),
        failed:
          row.outcome === 'conflict' ||
          row.outcome === 'failed' ||
          row.outcome === 'rewind_failed' ||
          row.outcome === 'redo_failed',
      }
  }
}
