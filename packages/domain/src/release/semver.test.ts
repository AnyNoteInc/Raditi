import { describe, expect, it } from 'vitest'

import {
  bumpOf,
  compareVersions,
  formatVersion,
  maxVersion,
  nextVersion,
  parseVersion,
  proposeBump,
  proposeVersion,
  VERSION_TAG_PATTERN_SOURCE,
  versionBumps,
  versionTagSchema,
  versionText,
  type SemVer,
  type VersionFacts,
} from './semver.ts'

function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const part = (next: () => number) =>
  next() < 0.3 ? 0 : Math.floor(next() * (next() < 0.9 ? 30 : 999_999_998))
const randomVersion = (next: () => number): SemVer => ({
  major: part(next),
  minor: part(next),
  patch: part(next),
})

const facts: VersionFacts = {
  changeType: 'content',
  risk: 'low',
  addedFiles: 0,
  deletedFiles: 0,
  newFunctionality: false,
}

describe('parse and format', () => {
  it('reads canonical vX.Y.Z only', () => {
    expect(parseVersion('v1.4.0')).toEqual({ major: 1, minor: 4, patch: 0 })
    expect(parseVersion('v0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 })
    for (const tag of [
      '1.4.0',
      'v1.4',
      'v01.4.0',
      'v1.04.0',
      'v1.4.0-rc.1',
      'v1.4.0+b',
      'V1.4.0',
      ' v1.4.0',
      'v1234567890.0.0',
      '',
    ])
      expect(parseVersion(tag), tag).toBeNull()
  })

  it('formats back what it reads, and every version it formats matches the database CHECK (seeded property)', () => {
    const next = random(7)
    const check = new RegExp(VERSION_TAG_PATTERN_SOURCE)
    for (let i = 0; i < 2000; i++) {
      const version = randomVersion(next)
      const tag = formatVersion(version)
      expect(check.test(tag)).toBe(true)
      expect(versionTagSchema.safeParse(tag).success).toBe(true)
      expect(parseVersion(tag)).toEqual(version)
      expect(versionText(version)).toBe(tag.slice(1))
    }
  })

  it('refuses a part that is not a whole number within nine digits', () => {
    for (const bad of [
      { major: -1, minor: 0, patch: 0 },
      { major: 1.5, minor: 0, patch: 0 },
      { major: 1e9, minor: 0, patch: 0 },
    ])
      expect(() => formatVersion(bad)).toThrow('Invalid version')
  })
})

describe('order and the next number', () => {
  it('orders by major, then minor, then patch (seeded property)', () => {
    const next = random(11)
    for (let i = 0; i < 2000; i++) {
      const a = randomVersion(next)
      const b = randomVersion(next)
      expect(compareVersions(a, b)).toBe(-compareVersions(b, a) || 0)
      expect(compareVersions(a, a)).toBe(0)
      for (const bump of versionBumps) {
        if (a.major > 999_999_000 || a.minor > 999_999_000 || a.patch > 999_999_000) continue
        const after = nextVersion(a, bump)
        expect(compareVersions(after, a)).toBe(1)
        expect(bumpOf(a, formatVersion(after))).toBe(bump)
      }
    }
  })

  it('resets the lower parts', () => {
    const v = { major: 1, minor: 4, patch: 7 }
    expect(formatVersion(nextVersion(v, 'patch'))).toBe('v1.4.8')
    expect(formatVersion(nextVersion(v, 'minor'))).toBe('v1.5.0')
    expect(formatVersion(nextVersion(v, 'major'))).toBe('v2.0.0')
    expect(() => nextVersion({ major: 999_999_999, minor: 0, patch: 0 }, 'major')).toThrow()
  })

  it('takes the highest version and ignores what is not one', () => {
    expect(
      maxVersion(['v1.2.3', 'v1.10.0', null, 'release-7', 'v1.9.9', undefined, 'v01.99.0']),
    ).toEqual({
      major: 1,
      minor: 10,
      patch: 0,
    })
    expect(maxVersion([])).toBeNull()
  })
})

describe('the proposal (Р26)', () => {
  it('proposes patch for content and edits without new files', () => {
    expect(proposeBump(facts)).toBe('patch')
    expect(proposeBump({ ...facts, changeType: 'code' })).toBe('patch')
    expect(proposeBump({ ...facts, changeType: 'code', risk: 'high' })).toBe('patch')
  })

  it('proposes minor for new files or new functionality in code', () => {
    expect(proposeBump({ ...facts, addedFiles: 1 })).toBe('minor')
    expect(proposeBump({ ...facts, changeType: 'mixed', newFunctionality: true })).toBe('minor')
    expect(proposeBump({ ...facts, changeType: 'content', newFunctionality: true })).toBe('patch')
    expect(proposeBump({ ...facts, changeType: 'content', newTables: 1 })).toBe('minor')
  })

  it('proposes major for a high risk with deleted files', () => {
    expect(proposeBump({ ...facts, changeType: 'code', risk: 'high', deletedFiles: 2 })).toBe(
      'major',
    )
    expect(proposeBump({ ...facts, changeType: 'code', risk: 'medium', deletedFiles: 2 })).toBe(
      'patch',
    )
  })

  it('starts from the highest of installed, released and tagged, so a burnt number never returns', () => {
    const proposal = proposeVersion(
      { installed: 'v1.2.0', releases: ['v1.3.0', 'v1.2.1'], tags: ['v0.0.0', 'v1.2.0', 'v1.3.0'] },
      { ...facts, addedFiles: 1 },
    )
    expect(proposal).toEqual({
      base: 'v1.3.0',
      bump: 'minor',
      version: 'v1.4.0',
      choices: { patch: 'v1.3.1', minor: 'v1.4.0', major: 'v2.0.0' },
    })
    expect(proposeVersion({ installed: null, releases: [], tags: [] }, facts)).toMatchObject({
      base: 'v0.0.0',
      version: 'v0.0.1',
    })
    expect(bumpOf({ major: 1, minor: 3, patch: 0 }, 'v1.3.5')).toBeNull()
  })
})
