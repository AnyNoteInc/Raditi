import { describe, expect, it } from 'vitest'

import { publicationLimits } from '../git/publication.ts'
import { sessionStateSchema, snapshotLimits } from './session-state.ts'
import {
  snapshotHasRepository,
  snapshotManifestSchema,
  snapshotMetadataSchema,
  snapshotPartFiles,
  snapshotPartNames,
  snapshotPartNamesOf,
  snapshotPlanSchema,
  turnSnapshotPrefix,
} from './snapshot-manifest.ts'

const home = {
  root: '/agent-home/opencode',
  include: ['.local/share/opencode/opencode.db', '.local/share/opencode/opencode.db-wal'],
  exclude: [],
}
const manifest = () => ({
  schemaVersion: 1,
  workspaceId: 'ws1',
  sessionId: 's1',
  turn: 1,
  createdAt: '2026-09-26T20:00:00.000Z',
  image: `registry/raditi@sha256:${'a'.repeat(64)}`,
  driver: { id: 'opencode', version: '1.18.34', nativeSessionId: 'ses_0001' },
  home,
  git: { provider: 'gitea', branch: 'task/t1', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40) },
  parts: snapshotPartNames.map((name) => ({
    name,
    key: `sessions/s1/turns/0001/${snapshotPartFiles[name]}`,
    sha256: 'd'.repeat(64),
    sizeBytes: 12,
    encryption: {
      algorithm: 'aes-256-gcm',
      keyId: 'ws-ws1',
      wrappedKey: 'vault:v1:wrapped',
      iv: '0'.repeat(24),
      tag: '1'.repeat(32),
    },
  })),
})

describe('snapshot scope and compatibility metadata', () => {
  it('accepts a complete digest-pinned snapshot', () =>
    expect(snapshotManifestSchema.safeParse(manifest()).success).toBe(true))
  // A snapshot of a session of a removed shell stays in S3 as history; no turn restores it.
  it.each(['gigacode', 'sourcecraft', 'codex', 'kimi', 'qwen', 'openai-chatgpt', 'kimi-code'])(
    'refuses a removed driver %s on restore',
    (id) => {
      const value = manifest()
      value.driver.id = id
      const result = snapshotManifestSchema.safeParse(value)
      expect(result.success).toBe(false)
      if (!result.success)
        expect(result.error.issues.map((issue) => issue.path)).toEqual([['driver', 'id']])
    },
  )
  it.each(['../s', '/s', 's/other', 's\n', '-s', ''])('refuses unsafe session id %j', (id) => {
    expect(() => turnSnapshotPrefix(id, 1)).toThrow('Invalid snapshot identity')
  })
  it.each([0, -1, 1.5, 1_000_000, Infinity])('refuses turn %s', (turn) =>
    expect(() => turnSnapshotPrefix('s', turn)).toThrow(),
  )
  it('pads small turns without truncating larger ones', () => {
    expect(turnSnapshotPrefix('s', 1)).toBe('sessions/s/turns/0001/')
    expect(turnSnapshotPrefix('s', 12345)).toBe('sessions/s/turns/12345/')
  })
  it('refuses missing, duplicated and foreign parts', () => {
    const missing = manifest()
    missing.parts.pop()
    const duplicate = manifest()
    duplicate.parts[1] = duplicate.parts[0]!
    const foreign = manifest()
    foreign.parts[0]!.key = 'sessions/other/turns/0001/home.tar.zst'
    const otherKey = manifest()
    otherKey.parts[0]!.encryption.keyId = 'ws-other'
    for (const value of [missing, duplicate, foreign, otherKey])
      expect(snapshotManifestSchema.safeParse(value).success).toBe(false)
  })
  it.each(['thread.1', 'ses:1', 'a'.repeat(201)])(
    'refuses native session id %j that drivers would not accept',
    (nativeSessionId) => {
      const value = manifest()
      value.driver.nativeSessionId = nativeSessionId
      expect(snapshotManifestSchema.safeParse(value).success).toBe(false)
    },
  )
  it('requires one data key for every part', () => {
    const value = manifest()
    value.parts[2]!.encryption.wrappedKey = 'vault:v1:other'
    expect(snapshotManifestSchema.safeParse(value).success).toBe(false)
  })
  it('rejects mutable image tags and unsupported encryption', () => {
    expect(
      snapshotManifestSchema.safeParse({ ...manifest(), image: 'raditi:latest' }).success,
    ).toBe(false)
    const value = manifest()
    value.parts[0]!.encryption.algorithm = 'aes-128-cbc'
    expect(snapshotManifestSchema.safeParse(value).success).toBe(false)
  })
})

describe('snapshot of a turn without a repository (plan 57, Б4)', () => {
  /** The same snapshot without `git` and with its home part alone. */
  const homeOnly = () => {
    const { git: _git, ...value } = manifest()
    return { ...value, parts: value.parts.filter((part) => part.name === 'home') }
  }

  it('reads a snapshot written before it, with git and three parts, as before', () => {
    const stored = JSON.parse(JSON.stringify(manifest()))
    const parsed = snapshotManifestSchema.parse(stored)
    expect(parsed).toEqual(stored)
    expect(snapshotHasRepository(parsed)).toBe(true)
    expect(snapshotPartNamesOf(parsed)).toEqual(['home', 'untracked', 'patch'])
    expect(parsed.schemaVersion).toBe(1)
  })

  it('accepts a manifest without git that holds the home part alone', () => {
    const parsed = snapshotManifestSchema.parse(homeOnly())
    expect(parsed).not.toHaveProperty('git')
    expect(parsed.parts.map((part) => part.name)).toEqual(['home'])
    expect(snapshotHasRepository(parsed)).toBe(false)
    expect(snapshotPartNamesOf(parsed)).toEqual(['home'])
    expect(parsed.schemaVersion).toBe(1)
  })

  it.each([
    ['git with the home part alone', () => ({ ...homeOnly(), git: manifest().git })],
    ['git with two parts', () => ({ ...manifest(), parts: manifest().parts.slice(0, 2) })],
    ['no git with all three parts', () => ({ ...homeOnly(), parts: manifest().parts })],
    [
      'no git with another part instead of home',
      () => ({ ...homeOnly(), parts: manifest().parts.filter((part) => part.name === 'patch') }),
    ],
    [
      'no git with home twice',
      () => ({ ...homeOnly(), parts: [homeOnly().parts[0]!, homeOnly().parts[0]!] }),
    ],
    ['no git and no parts', () => ({ ...homeOnly(), parts: [] })],
    ['an empty git', () => ({ ...homeOnly(), git: {} })],
    ['a null git', () => ({ ...homeOnly(), git: null })],
  ])('refuses %s', (_label, value) => {
    expect(snapshotManifestSchema.safeParse(value()).success).toBe(false)
  })

  it('keeps every other check of a part without git', () => {
    for (const change of [
      (value: ReturnType<typeof homeOnly>) => {
        value.parts[0]!.key = 'sessions/other/turns/0001/home.tar.zst'
      },
      (value: ReturnType<typeof homeOnly>) => {
        value.parts[0]!.encryption.keyId = 'ws-other'
      },
    ]) {
      const value = homeOnly()
      change(value)
      expect(snapshotManifestSchema.safeParse(value).success).toBe(false)
    }
  })

  it('takes metadata and a plan without git', () => {
    const { schemaVersion: _v, createdAt: _c, parts: _p, git: _g, ...metadata } = manifest()
    expect(snapshotMetadataSchema.parse(metadata)).not.toHaveProperty('git')
    const { home: _h, ...plan } = metadata
    const parsed = snapshotPlanSchema.parse({ ...plan, driver: { id: 'opencode', version: '1' } })
    expect(snapshotHasRepository(parsed)).toBe(false)
  })
})

describe('session file allowlist', () => {
  it('accepts literal directories and files', () =>
    expect(sessionStateSchema.parse(home)).toEqual(home))
  it.each(['/agent-home', '/workspace/repo', '/agent-home/../secrets', '/agent-home/x/'])(
    'refuses root %j',
    (root) => {
      expect(sessionStateSchema.safeParse({ ...home, root }).success).toBe(false)
    },
  )
  it.each([
    '..',
    '../auth.json',
    '/etc/passwd',
    'sessions//file',
    '--checkpoint-action=x',
    'sessions/*',
    'sessions\\x',
    '.git/config',
  ])('refuses path %j', (path) => {
    expect(sessionStateSchema.safeParse({ ...home, include: [path] }).success).toBe(false)
  })
})

describe('pre-turn snapshot plan', () => {
  const plan = () => {
    const { schemaVersion: _v, createdAt: _c, parts: _p, home: _h, ...rest } = manifest()
    const { headSha: _head, ...git } = rest.git
    return {
      ...rest,
      driver: { id: 'opencode', version: '1.18.34' },
      git: { ...git, publication: { taskId: 't1', committedAt: '2026-09-26T20:00:00.000Z' } },
    }
  }
  it('accepts what the manifest would accept', () =>
    expect(snapshotPlanSchema.safeParse(plan()).success).toBe(true))
  it.each(['', 'bad version', '-1', 'v'.repeat(65)])(
    'refuses driver version %j exactly as the manifest does',
    (version) => {
      const value = plan()
      value.driver.version = version
      expect(snapshotPlanSchema.safeParse(value).success).toBe(false)
      const full = manifest()
      full.driver.version = version
      expect(snapshotManifestSchema.safeParse(full).success).toBe(false)
    },
  )
  it('refuses unknown keys, including a premature headSha', () => {
    expect(snapshotPlanSchema.safeParse({ ...plan(), extra: 1 }).success).toBe(false)
    const value = plan()
    expect(
      snapshotPlanSchema.safeParse({ ...value, git: { ...value.git, headSha: 'c'.repeat(40) } })
        .success,
    ).toBe(false)
  })
  it('shares one patch limit between the snapshot and the publication', () =>
    expect(publicationLimits.patchBytes).toBe(snapshotLimits.patchBytes))
})
