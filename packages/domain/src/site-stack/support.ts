/**
 * What the platform does with a site of a stack now (docs/plan/62-site-stacks.md, §2.3, Т1, Т3,
 * Т4, Т6, Т25). The adapter declares its `StackSupport`; `siteSupportOf` judges it against the
 * record of the site, the switches and the environment. Everyone reads this one value — the
 * wizard, `siteCapabilities`, `/release` and the instructions of a turn — and keeps no condition
 * of its own: no stack is named here (rule 8), no network or git is read.
 */
import { isProduction, type AppEnv } from '../app-env.ts'
import type { SiteStackFacts } from './facts.ts'
import type { ConnectionWay, SiteLimit, SiteStack } from './stacks.ts'

/** `dev` is open outside production only; `on` is a separate decision with its proof (Т4). */
export type StackSwitch = 'off' | 'dev' | 'on'

/** A row of the stack's table of generations (branches of the CMS). */
export interface StackGeneration {
  /** `j3`, `oc3`, `modx2`: what `sites.stack_facts.generation` names. */
  readonly id: string
  /** Included; versions are compared by their numbers (`compareSiteVersions`). */
  readonly from: string
  /** The end of the branch, included: `3.99` rather than `3.10`, so a new minor version passes. */
  readonly to: string
  /** The PHP versions to try, in order; only versions the images have. */
  readonly php: readonly string[]
  /** The import, the turn, the preview and the release of files: only together. */
  readonly files: StackSwitch
  /** `false` closes the panel only when the branch is known positively (Т3). */
  readonly browser: boolean
  /** The vendor no longer supports the branch: the client is told once. */
  readonly ended: boolean
}

/** What an adapter declares of its stack. */
export interface StackSupport {
  /** The ceiling of the stack for the files. */
  readonly files: StackSwitch
  /** The panel is judged by the stack, not by the branch (Т3). */
  readonly browser: StackSwitch
  /** Empty: the version is not judged. */
  readonly generations: readonly StackGeneration[]
  /** Below this version both ways are refused. */
  readonly refuseBelow: string | null
  /** `/release` only after the checks have passed; WordPress — false. */
  readonly releaseNeedsChecks: boolean
  /** `open`: an unknown version narrows nothing (WordPress); `closed`: it is `version_unknown`. */
  readonly unknownVersion: 'open' | 'closed'
}

/** A row of `stack_switches` (Т5): a switch only narrows. */
export interface StackSwitchRow {
  readonly stack: SiteStack
  readonly axis: ConnectionWay
  /** null: the whole stack. */
  readonly generation: string | null
}

/** One value for the wizard, `siteCapabilities`, `/release` and the instructions of a turn. */
export interface SiteSupportNow {
  /** The import, the repository, the candidate. */
  readonly files: boolean
  /** A file turn may start now (Т25). */
  readonly fileTurns: boolean
  readonly browser: boolean
  /** Why not everything: the texts to the client rest on it. */
  readonly limit: SiteLimit | null
  readonly notice: 'vendor_ended' | null
}

export function stackAxisOpen(value: StackSwitch, env: AppEnv): boolean {
  return value === 'on' || (value === 'dev' && !isProduction(env))
}

/** The numbers of the leading part of a version: `4.0.0.rc1` → 4, 0, 0; `3.0.4.1b` → 3, 0, 4, 1. */
function versionNumbers(version: string): number[] {
  const lead = /^\d+(?:\.\d+)*/.exec(version)?.[0]
  return lead === undefined ? [] : lead.split('.').map(Number)
}

/** By the numbers of the leading part of a version, the missing ones are 0, the suffix is not read. */
export function compareSiteVersions(a: string, b: string): number {
  const left = versionNumbers(a)
  const right = versionNumbers(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** The row of the table where `from <= version <= to`; null — there is none. */
export function generationOf(support: StackSupport, version: string): StackGeneration | null {
  return (
    support.generations.find(
      (row) =>
        compareSiteVersions(row.from, version) <= 0 && compareSiteVersions(version, row.to) <= 0,
    ) ?? null
  )
}

/**
 * What the platform does with a site now. `facts` is the record of the site, not a read of git or a
 * request to the site; `switches` are the rows of this stack, picked by the caller (a support has
 * no name of its stack). The table of `limit` and the rest: docs/plan/62-slices/e2.md, Э2.2.
 */
export function siteSupportOf(
  support: StackSupport,
  facts: SiteStackFacts,
  switches: readonly StackSwitchRow[],
  env: AppEnv,
): SiteSupportNow {
  const version = facts.cmsVersion
  const generation =
    support.generations.find((row) => row.id === facts.generation) ??
    (version === null ? null : generationOf(support, version))
  const publicRow = support.generations.find((row) => row.id === facts.publicGeneration) ?? null
  const below =
    version !== null &&
    support.refuseBelow !== null &&
    compareSiteVersions(version, support.refuseBelow) < 0
  // The panel is judged by the branch found from the files or from outside (Т3); a branch switch of
  // the panel reaches the same row, so a site known only from outside is narrowed too (Т5).
  const branchOf = (axis: ConnectionWay) =>
    axis === 'browser' ? (generation ?? publicRow) : generation
  const switchedOff = (axis: ConnectionWay) =>
    switches.some(
      (row) =>
        row.axis === axis && (row.generation === null || row.generation === branchOf(axis)?.id),
    )
  const filesOpen = stackAxisOpen(support.files, env) && !switchedOff('files')
  const browserOpen = stackAxisOpen(support.browser, env) && !switchedOff('browser')

  function limitOf(): SiteLimit | null {
    if (!filesOpen) return 'stack_off'
    if (facts.limit === 'other_product') return 'other_product'
    if (below || facts.limit === 'version_unsupported') return 'version_unsupported'
    if (facts.limit !== null) return facts.limit
    if (generation !== null && !stackAxisOpen(generation.files, env)) return 'not_yet'
    if (version === null && support.unknownVersion === 'closed') return 'version_unknown'
    if (version !== null && support.generations.length > 0 && generation === null) return 'not_yet'
    return null
  }
  const limit = limitOf()

  const files = limit === null
  // Judged by the record and the version, not by `limit`: `stack_off` comes first in its table, and a
  // closed files axis must not open the panel of a version below refuseBelow (§2.3, Т5).
  const closesBoth =
    below || facts.limit === 'other_product' || facts.limit === 'version_unsupported'
  // An unknown branch does not close the panel (Т3): only a row found by the files or from outside.
  const browser = browserOpen && !closesBoth && (generation ?? publicRow)?.browser !== false
  const probe = facts.probe?.status
  const fileTurns =
    files && !(support.releaseNeedsChecks && (probe === 'failed' || probe === 'no_database'))
  const notice = generation?.ended === true && (files || browser) ? 'vendor_ended' : null
  return { files, fileTurns, browser, limit, notice }
}
