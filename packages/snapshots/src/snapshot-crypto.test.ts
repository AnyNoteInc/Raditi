import { createHash, randomBytes } from 'node:crypto'

import type { SnapshotManifest } from '@repo/domain'
import { describe, expect, it } from 'vitest'

const sampleDriverId = 'opencode' as const
import { decryptPart, encryptPart, snapshotAad } from './snapshot-crypto.ts'

type SealBase = Omit<SnapshotManifest, 'parts'>
const manifest: SealBase & { git: NonNullable<SealBase['git']> } = {
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

describe('snapshot AAD of a snapshot with a repository (pinned before plan 57)', () => {
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const full: SealBase = {
    ...manifest,
    driver: { ...manifest.driver, nativeSessionId: 'ses_abc' },
    home: { ...manifest.home, include: ['z.db', 'a.db'], exclude: ['y', 'b'] },
    git: { ...manifest.git, sandboxBaseSha: 'd'.repeat(40) },
  }
  const { publication: _publication, ...gitWithoutPublication } = manifest.git
  const unpublished = { ...manifest, git: gitWithoutPublication }

  it('keeps the exact bytes the code sealed v1 snapshots with', () => {
    const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
    expect(Buffer.from(snapshotAad(manifest, 'home')).toString()).toBe(
      `[1,"00000000-0000-4000-8000-000000000001","session1",1,"2026-10-17T10:00:00.000Z",` +
        `"${image}","opencode","1.0.0",null,"gitea","agent/task1","${'b'.repeat(40)}",` +
        `"${'c'.repeat(40)}","/agent-home/opencode",["state.db"],[],"home","task1",` +
        `"2026-10-17T10:00:00.000Z"]`,
    )
    // SHA-256 of the AAD as the code computed it before snapshots without a repository existed.
    const pinned = {
      plain: {
        home: '26220cf135f44d8cd4a5b4bd3620843ee9cd1419fab1879cb66154d0ee4b3d62',
        untracked: '35649bbd56d44962510e5127987b6680593f8d399b34e07069d8bf35cd81bd90',
        patch: '61da7d805e3985c3a38ea5571bddda3db10c0758c1de24d1b7d2b35435c2dfe6',
      },
      full: {
        home: '58756455b5011553e7ed388956bcaa08771927bb5d8c5ffc49f2e4a67c9ea171',
        untracked: '13189abc26657509cd3d3dbe359f3c8214b70f459c9d6990ee0118a8b3e3bcdc',
        patch: '0cdf976a54810515e371105934fecf98ce942c2445fa3837ed5661c60bee8935',
      },
      unpublished: {
        home: '798d4a30369f86272464e41011b8ac3b210d9e145424e400ea751cb0177578f8',
        untracked: '1240b8f69449abbf433171a2cded5d68a48b130ad2309429673e82daf9dcbd58',
        patch: '74e103eff188ce09f90dd59382f925c7495be3d04fc43a9c917e629fb4a9e9cc',
      },
    } as const
    for (const [name, shape] of [
      ['plain', manifest],
      ['full', full],
      ['unpublished', unpublished],
    ] as const)
      for (const part of ['home', 'untracked', 'patch'] as const)
        expect(sha(snapshotAad(shape, part)), `${name} ${part}`).toBe(pinned[name][part])
  })

  it('opens parts sealed by the code before plan 57', () => {
    const key = Buffer.alloc(32, 0x11)
    const sealed = [
      [
        manifest,
        'home',
        'sealed by plain',
        [
          '939944c482c192f258dc2916314f73',
          'aa65e004935c4fc14321168c',
          'a305ba88ea2c109641e10fe44ec9f179',
        ],
      ],
      [
        full,
        'patch',
        'sealed by full',
        [
          'a6ddc6d72558351635ff410e7900',
          '2ee2abba8d4025403e3860c5',
          '7465b613306684ecec15ea66a2a1406f',
        ],
      ],
    ] as const
    for (const [shape, part, text, [body, iv, tag]] of sealed) {
      const opened = decryptPart(Buffer.from(body, 'hex'), key, snapshotAad(shape, part), iv, tag)
      expect(Buffer.from(opened).toString()).toBe(text)
    }
  })
})

describe('snapshot AAD without a repository (plan 57, Б4)', () => {
  const { git: _git, ...homeOnly } = manifest

  it('puts null in the git positions and the workspace tag last', () => {
    const image = `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`
    expect(Buffer.from(snapshotAad(homeOnly, 'home')).toString()).toBe(
      `[1,"00000000-0000-4000-8000-000000000001","session1",1,"2026-10-17T10:00:00.000Z",` +
        `"${image}","opencode","1.0.0",null,null,null,null,null,"/agent-home/opencode",` +
        `["state.db"],[],"home","workspace","none"]`,
    )
  })

  it('never opens a part of a snapshot with a repository, nor the reverse', () => {
    const key = randomBytes(32)
    const aad = snapshotAad(homeOnly, 'home')
    const sealed = encryptPart(Buffer.from('home'), key, aad)
    expect(Buffer.from(decryptPart(sealed.body, key, aad, sealed.iv, sealed.tag)).toString()).toBe(
      'home',
    )
    const { publication: _publication, ...bare } = manifest.git
    for (const git of [manifest.git, bare, { ...bare, sandboxBaseSha: 'd'.repeat(40) }]) {
      const other = snapshotAad({ ...homeOnly, git }, 'home')
      expect(Buffer.from(other).equals(Buffer.from(aad))).toBe(false)
      expect(() => decryptPart(sealed.body, key, other, sealed.iv, sealed.tag)).toThrow()
      const withGit = encryptPart(Buffer.from('home'), key, other)
      expect(() => decryptPart(withGit.body, key, aad, withGit.iv, withGit.tag)).toThrow()
    }
  })
})
