import { describe, expect, it, vi } from 'vitest'

import { ArtifactDiagram } from './artifact-diagram.ts'

// A picture of «Схема» the cabinet asked for (docs/plan/88-artifacts.md, §7.13, 88.24б).

const artifactId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const workspaceId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const job = { artifactId, block: 'd1' }

function dbWith(content: string | null, kept: unknown = null) {
  return {
    artifact: { findUnique: vi.fn(async () => ({ workspaceId, deletedAt: null })) },
    artifactBlock: { findFirst: vi.fn(async () => (content === null ? null : { content })) },
    artifactDiagramRender: {
      findUnique: vi.fn(async () => kept),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
  }
}

describe('a picture of «Схема» drawn by core', () => {
  it('draws the checked text on the page of the artifact’s workspace and keeps it', async () => {
    const db = dbWith('flowchart LR\n  A --> B')
    const draw = vi.fn(async () => ({
      ok: true as const,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      width: 1,
      height: 1,
      type: 'flowchart-v2',
    }))
    await new ArtifactDiagram({ db: db as never, draw }).run(job)
    expect(draw).toHaveBeenCalledWith({ workspaceId, source: 'flowchart LR\n  A --> B' })
    expect(db.artifactDiagramRender.createMany).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a kept picture, a block gone, or without a worker', async () => {
    const draw = vi.fn()
    await new ArtifactDiagram({ db: dbWith('flowchart LR', { ok: true }) as never, draw }).run(job)
    await new ArtifactDiagram({ db: dbWith(null) as never, draw }).run(job)
    await new ArtifactDiagram({ db: dbWith('flowchart LR') as never, draw: null }).run(job)
    expect(draw).not.toHaveBeenCalled()
  })
})
