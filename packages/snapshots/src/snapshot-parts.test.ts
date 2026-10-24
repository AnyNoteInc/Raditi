import { Buffer } from 'node:buffer'

import type { SessionState, SnapshotPart } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { emptyUntrackedArchive } from './archive-validation.ts'
import { openSnapshotParts, sealSnapshotPart, type SnapshotSealBase } from './snapshot-parts.ts'
import { tarZst } from './testing.ts'

const home: SessionState = {
  root: '/agent-home/opencode',
  include: ['.local/share/opencode/opencode.db'],
  exclude: [],
}
const prefix = 'sessions/session1/turns/0001/'
const files = { home: 'home.tar.zst', untracked: 'untracked.tar.zst', patch: 'patch.diff' } as const
const homeOnly: SnapshotSealBase = {
  schemaVersion: 1,
  workspaceId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session1',
  turn: 1,
  createdAt: '2026-10-22T10:00:00.000Z',
  image: `registry.invalid/raditi/opencode@sha256:${'a'.repeat(64)}`,
  driver: { id: 'opencode', version: '1.0.0' },
  home,
}
const withGit: SnapshotSealBase = {
  ...homeOnly,
  git: {
    provider: 'gitea',
    branch: 'agent/task1',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
  },
}

const keyOf = () => new Uint8Array(32).fill(7)

function stored(
  base: SnapshotSealBase,
  name: SnapshotPart['name'],
  plaintext: Uint8Array,
): { part: SnapshotPart; body: Uint8Array } {
  const { body, sealed } = sealSnapshotPart(base, name, plaintext, keyOf())
  const part: SnapshotPart = {
    name,
    key: `${prefix}${files[name]}`,
    sha256: sealed.sha256,
    sizeBytes: sealed.sizeBytes,
    encryption: {
      algorithm: 'aes-256-gcm',
      keyId: `ws-${base.workspaceId}`,
      wrappedKey: 'vault:v1:wrapped',
      iv: sealed.iv,
      tag: sealed.tag,
    },
  }
  return { part, body }
}

describe('the parts of a snapshot without a repository (docs/plan/57-browser-tasks.md, Б4)', () => {
  it('seals and opens the home part alone, and zeroes the key', async () => {
    const archive = await tarZst({ '.local/share/opencode/opencode.db': 'session' })
    const key = keyOf()
    const opened = await openSnapshotParts(
      homeOnly,
      [stored(homeOnly, 'home', archive)],
      home,
      () => Promise.resolve(key),
    )
    expect(Object.keys(opened)).toEqual(['home'])
    expect(Buffer.from(opened.home).equals(Buffer.from(archive))).toBe(true)
    expect(key.every((byte) => byte === 0)).toBe(true)
  })

  it('refuses to seal or open a repository part for it, before the key is asked for', async () => {
    for (const name of ['untracked', 'patch'] as const)
      expect(() => sealSnapshotPart(homeOnly, name, emptyUntrackedArchive(), keyOf())).toThrow(
        /home part alone/,
      )
    const foreign = stored(withGit, 'untracked', emptyUntrackedArchive())
    const dataKey = vi.fn(async () => keyOf())
    await expect(openSnapshotParts(homeOnly, [foreign], home, dataKey)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(dataKey).not.toHaveBeenCalled()
  })

  it('never opens a home part sealed for the other shape', async () => {
    const archive = await tarZst({ '.local/share/opencode/opencode.db': 'session' })
    for (const [sealedFor, openedAs] of [
      [withGit, homeOnly],
      [homeOnly, withGit],
    ] as const)
      await expect(
        openSnapshotParts(openedAs, [stored(sealedFor, 'home', archive)], home, async () =>
          keyOf(),
        ),
      ).rejects.toThrow(/authentication/)
  })
})
