import { describe, expect, it } from 'vitest'

import { sessionStateSchema } from './session-state.ts'
import {
  snapshotManifestSchema,
  snapshotPartFiles,
  snapshotPartNames,
  turnSnapshotPrefix,
} from './snapshot-manifest.ts'

const home = { root: '/agent-home/codex', include: ['sessions'], exclude: [] }
const manifest = () => ({
  schemaVersion: 1,
  workspaceId: 'ws1',
  sessionId: 's1',
  turn: 1,
  createdAt: '2026-09-26T20:00:00.000Z',
  image: `registry/raditi@sha256:${'a'.repeat(64)}`,
  driver: { id: 'codex', version: '0.157.1', nativeSessionId: 'thread-1' },
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
  it('rejects mutable image tags and unsupported encryption', () => {
    expect(
      snapshotManifestSchema.safeParse({ ...manifest(), image: 'raditi:latest' }).success,
    ).toBe(false)
    const value = manifest()
    value.parts[0]!.encryption.algorithm = 'aes-128-cbc'
    expect(snapshotManifestSchema.safeParse(value).success).toBe(false)
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
