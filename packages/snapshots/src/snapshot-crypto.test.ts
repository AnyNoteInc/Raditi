import { randomBytes } from 'node:crypto'

import type { SnapshotManifest } from '@repo/domain'
import { describe, expect, it } from 'vitest'

const sampleDriverId = 'opencode' as const
import { decryptPart, encryptPart, snapshotAad } from './snapshot-crypto.ts'

const manifest: Omit<SnapshotManifest, 'parts'> = {
  schemaVersion: 1,
  workspaceId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session1',
  turn: 1,
  createdAt: '2026-10-17T10:00:00.000Z',
  image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
  driver: { id: sampleDriverId, version: '1.0.0' },
  home: { root: `/agent-home/${sampleDriverId}`, include: ['state.db'], exclude: [] },
  git: {
    provider: 'gitea',
    branch: 'agent/task1',
    baseSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    publication: { taskId: 'task1', committedAt: '2026-10-17T10:00:00.000Z' },
  },
}

describe('snapshot AAD and the working set (plan 53, Р11)', () => {
  it('binds the working-set commit, and leaves the AAD of a full-tree snapshot as it was', () => {
    const full = snapshotAad(manifest, 'home')
    expect(JSON.parse(Buffer.from(full).toString())).not.toContain('sandboxBaseSha')
    const sliced = { ...manifest, git: { ...manifest.git, sandboxBaseSha: 'd'.repeat(40) } }
    const aad = snapshotAad(sliced, 'home')
    expect(Buffer.from(aad).toString()).toContain('d'.repeat(40))
    const key = randomBytes(32)
    const sealed = encryptPart(Buffer.from('home'), key, aad)
    expect(Buffer.from(decryptPart(sealed.body, key, aad, sealed.iv, sealed.tag)).toString()).toBe(
      'home',
    )
    // A manifest that names another working set, or none, does not open the part.
    for (const other of [
      full,
      snapshotAad({ ...sliced, git: { ...sliced.git, sandboxBaseSha: 'e'.repeat(40) } }, 'home'),
    ])
      expect(() => decryptPart(sealed.body, key, other, sealed.iv, sealed.tag)).toThrow()
  })
})
