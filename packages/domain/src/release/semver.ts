import { z } from 'zod'

import { badRequest } from '../errors.ts'

/**
 * Versions of a site (docs/plan/53-chat-preview-release.md, Р26): lightweight tags `vX.Y.Z` of
 * the site's repository. The number of a release is proposed from the highest version ever
 * seen — installed, in `site_releases` or as a tag — and the client may take a neighbouring
 * one. A number is never reused: a failed release burns it, its tag stays.
 */
export const versionBumps = ['patch', 'minor', 'major'] as const
export type VersionBump = (typeof versionBumps)[number]

export interface SemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/** The database CHECK of `site_releases.version`, `sites.installed_version` and the like. */
export const VERSION_TAG_PATTERN_SOURCE = String.raw`^v\d{1,9}\.\d{1,9}\.\d{1,9}$`
const PART = '(0|[1-9]\\d{0,8})'
/** What this code writes: no leading zeros, so the text of a version is one. */
const CANONICAL = new RegExp(`^v${PART}\\.${PART}\\.${PART}$`)

/** The first tag of an imported site; the deploy workflow never runs on it. */
export const INITIAL_VERSION_TAG = 'v0.0.0'
export const ZERO_VERSION: SemVer = Object.freeze({ major: 0, minor: 0, patch: 0 })

/** `vX.Y.Z` as this code writes it. */
export const versionTagSchema = z.string().regex(CANONICAL, 'expected a version vX.Y.Z')
export type VersionTag = z.infer<typeof versionTagSchema>

/** null for anything but a canonical `vX.Y.Z`: `1.2.3`, `v01.2.3`, `v1.2` and `v1.2.3-rc` are not versions. */
export function parseVersion(tag: string): SemVer | null {
  const match = CANONICAL.exec(tag)
  if (!match) return null
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  })
}

const MAX_PART = 999_999_999
const isPart = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_PART

export function formatVersion(version: SemVer): VersionTag {
  if (!isPart(version.major) || !isPart(version.minor) || !isPart(version.patch))
    throw badRequest('Invalid version')
  return `v${version.major}.${version.minor}.${version.patch}`
}

/** The number without the letter, as the client reads it: «1.4.0». */
export const versionText = (version: SemVer): string => formatVersion(version).slice(1)

export function compareVersions(a: SemVer, b: SemVer): -1 | 0 | 1 {
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1
  }
  return 0
}

/** The next version of this kind: a minor resets the patch, a major both. */
export function nextVersion(version: SemVer, bump: VersionBump): SemVer {
  const next =
    bump === 'major'
      ? { major: version.major + 1, minor: 0, patch: 0 }
      : bump === 'minor'
        ? { major: version.major, minor: version.minor + 1, patch: 0 }
        : { major: version.major, minor: version.minor, patch: version.patch + 1 }
  if (!isPart(next.major) || !isPart(next.minor) || !isPart(next.patch))
    throw badRequest('Version is out of range')
  return Object.freeze(next)
}

/** The highest version among tags and stored versions; what is not a version is ignored. */
export function maxVersion(tags: Iterable<string | null | undefined>): SemVer | null {
  let max: SemVer | null = null
  for (const tag of tags) {
    const version = tag == null ? null : parseVersion(tag)
    if (version && (max === null || compareVersions(version, max) > 0)) max = version
  }
  return max
}

/** What the platform knows about a candidate when it proposes a number. */
export interface VersionFacts {
  changeType: 'code' | 'content' | 'mixed' | 'none'
  risk: 'low' | 'medium' | 'high'
  addedFiles: number
  deletedFiles: number
  /** The candidate adds a feature, not a fix (the agent's claim, read by the platform). */
  newFunctionality: boolean
  /**
   * Tables of the platform the database plan creates or extends (docs/plan/53, «Операции БД и
   * миграции»): a structure the site did not have, whatever the agent calls the change.
   */
  newTables?: number
}

/**
 * Р26: content only or edits without new files — patch; new files, code with new functionality
 * or a new structure of the database — minor; a high risk with deleted files — major.
 */
export function proposeBump(facts: VersionFacts): VersionBump {
  if (facts.risk === 'high' && facts.deletedFiles > 0) return 'major'
  const code = facts.changeType === 'code' || facts.changeType === 'mixed'
  if (facts.addedFiles > 0 || (code && facts.newFunctionality) || (facts.newTables ?? 0) > 0)
    return 'minor'
  return 'patch'
}

export interface VersionProposal {
  /** The highest version seen; v0.0.0 when there is none. */
  base: VersionTag
  bump: VersionBump
  version: VersionTag
  /** The numbers the client may choose instead, one per kind of bump. */
  choices: Readonly<Record<VersionBump, VersionTag>>
}

export interface VersionHistory {
  /** `sites.installed_version`. */
  installed: string | null
  /** Every `site_releases.version` of the site, the burnt ones included. */
  releases: readonly string[]
  /** `v*` tags of the site's repository. */
  tags: readonly string[]
}

export function versionChoices(base: SemVer): Readonly<Record<VersionBump, VersionTag>> {
  return Object.freeze({
    patch: formatVersion(nextVersion(base, 'patch')),
    minor: formatVersion(nextVersion(base, 'minor')),
    major: formatVersion(nextVersion(base, 'major')),
  })
}

export function proposeVersion(history: VersionHistory, facts: VersionFacts): VersionProposal {
  const base = maxVersion([history.installed, ...history.releases, ...history.tags]) ?? ZERO_VERSION
  const bump = proposeBump(facts)
  const choices = versionChoices(base)
  return { base: formatVersion(base), bump, version: choices[bump], choices }
}

/** The kind of bump `version` is over `base`, or null when it is not one of the choices. */
export function bumpOf(base: SemVer, version: string): VersionBump | null {
  const choices = versionChoices(base)
  return versionBumps.find((bump) => choices[bump] === version) ?? null
}
