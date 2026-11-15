import { z } from 'zod'

/**
 * What the rows of the feed a chat of a project wrote before projects went
 * (docs/plan/83-remove-projects.md, БП6) are read with: the versions of a release, its outcomes
 * and why a preview was not made. Nothing new is written with them.
 */
export const versionBumps = ['patch', 'minor', 'major'] as const
export type VersionBump = (typeof versionBumps)[number]

const PART = '(0|[1-9]\\d{0,8})'
const CANONICAL = new RegExp(`^v${PART}\\.${PART}\\.${PART}$`)

/** `vX.Y.Z`, without leading zeros. */
export const versionTagSchema = z.string().regex(CANONICAL, 'expected a version vX.Y.Z')

export const releaseOutcomes = ['installed', 'rolled_back', 'failed', 'unknown', 'refused'] as const

export const previewUnavailableReasons = [
  'no_database',
  'no_core',
  'not_supported',
  'boot_failed',
  'version_unsupported',
  'no_layout',
] as const
export type PreviewUnavailableReason = (typeof previewUnavailableReasons)[number]
