import { conflict, type DomainError } from '../errors.ts'

/**
 * The life of a preview (docs/plan/53-chat-preview-release.md, Р2, Р4, Р16, Р22):
 * `preview_environments.status`. A preview is the working copy of one dialog — the full tree of
 * the candidate, its own database copy and PHP — and never a deploy target.
 */
export const previewStatuses = [
  'pending',
  'building',
  'ready',
  'failed',
  'unavailable',
  'expired',
  'destroyed',
] as const
export type PreviewStatus = (typeof previewStatuses)[number]

/** `preview_environments.db_mode`: a copy of the site's database, or none (Р4). */
export const previewDbModes = ['copy', 'none'] as const
export type PreviewDbMode = (typeof previewDbModes)[number]

/**
 * Why a preview cannot be shown; `unavailable_reason`. The screen says it in words and never
 * draws a site without its database (Р4) or without the files it cannot run without (Р16).
 */
export const previewUnavailableReasons = ['no_database', 'no_core', 'not_supported'] as const
export type PreviewUnavailableReason = (typeof previewUnavailableReasons)[number]

/** Who a ticket and a session are for: a person, or the browser of the agent (Р21). */
export const previewSessionKinds = ['user', 'browser'] as const
export type PreviewSessionKind = (typeof previewSessionKinds)[number]

const transitions: Record<PreviewStatus, readonly PreviewStatus[]> = {
  pending: ['building', 'unavailable', 'destroyed'],
  // A build ends ready, failed, or finds what it cannot run without.
  building: ['ready', 'failed', 'unavailable', 'destroyed'],
  // A new candidate, a reset or a sync rebuilds; the TTL stops the containers.
  ready: ['building', 'expired', 'destroyed'],
  failed: ['building', 'expired', 'destroyed'],
  // The cause may go away (a database access added): the next build tries again.
  unavailable: ['building', 'expired', 'destroyed'],
  // Opened again after its TTL: rebuilt from the seed and the candidate.
  expired: ['building', 'destroyed'],
  destroyed: [],
}

export function canPreviewTransition(from: PreviewStatus, to: PreviewStatus): boolean {
  return transitions[from].includes(to)
}

export function previewNextStatuses(from: PreviewStatus): readonly PreviewStatus[] {
  return transitions[from]
}

export function assertPreviewTransition(from: PreviewStatus, to: PreviewStatus): void {
  if (!canPreviewTransition(from, to)) throw invalidTransition(from, to)
}

const invalidTransition = (from: PreviewStatus, to: PreviewStatus): DomainError =>
  conflict(`Preview cannot move from ${from} to ${to}`)

/** Containers run and the gateway may pass a viewer through. */
export const isPreviewServing = (status: PreviewStatus): boolean => status === 'ready'

/**
 * The preview shows exactly `revision` (Р22): built to it and not touched by a writing browser
 * action since. Checks, the approval screen and `/release` want this; `revision` is the one
 * `task_candidates.preview_revision` recorded for the candidate.
 */
export function previewShowsRevision(
  preview: { status: PreviewStatus; revision: number | null; dirty: boolean },
  revision: number,
): boolean {
  return isPreviewServing(preview.status) && !preview.dirty && preview.revision === revision
}
