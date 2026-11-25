import { artifactRole, readArtifact, type PrismaClient } from '@repo/db'
import type * as dbModule from '@repo/db'
import type * as artifactDomain from '@repo/domain/artifacts'
import { expect, it, vi } from 'vitest'

import { canvasThumbs } from './canvas.ts'

const renderer = vi.hoisted(() => ({ version: 1 }))

vi.mock('@repo/domain/artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof artifactDomain>()),
  get CANVAS_RENDER_VERSION() {
    return renderer.version
  },
}))
vi.mock('@repo/db', async (importOriginal) => ({
  ...(await importOriginal<typeof dbModule>()),
  artifactRole: vi.fn(),
  readArtifact: vi.fn(),
}))

it('queues missing thumbnails again for a new renderer or after the retry window', async () => {
  const artifactId = '019b6321-743d-754e-8cb0-af624c998d30'
  vi.mocked(artifactRole).mockResolvedValue('owner')
  vi.mocked(readArtifact).mockResolvedValue({
    id: artifactId,
    kind: 'canvas',
    seq: 5,
    blocks: [{ key: 'home', kind: 'frame', parent: null, rev: 2, content: null, props: {} }],
  } as Awaited<ReturnType<typeof readArtifact>>)
  const dedupeKeys = new Set<string>()
  const db = {
    artifact: { findUniqueOrThrow: async () => ({ workspaceId: 'workspace' }) },
    outboxEvent: {
      createMany: async ({ data: [{ dedupeKey }] }: { data: [{ dedupeKey: string }] }) => {
        const previous = dedupeKeys.size
        dedupeKeys.add(dedupeKey)
        return { count: dedupeKeys.size - previous }
      },
    },
  } as unknown as PrismaClient
  const storage = { exists: async () => false }
  const input = { artifactId, userId: 'owner' }

  const now = vi.spyOn(Date, 'now').mockReturnValue(120_000)
  try {
    await canvasThumbs(db, storage, input)
    await canvasThumbs(db, storage, input)
    expect(dedupeKeys.size).toBe(1)

    renderer.version += 1
    await canvasThumbs(db, storage, input)
    await canvasThumbs(db, storage, input)
    expect(dedupeKeys.size).toBe(2)

    now.mockReturnValue(180_000)
    await canvasThumbs(db, storage, input)
    await canvasThumbs(db, storage, input)
    expect(dedupeKeys.size).toBe(3)
    await canvasThumbs(db, { exists: async () => true }, input)
    expect(dedupeKeys.size).toBe(3)
  } finally {
    now.mockRestore()
  }
})
