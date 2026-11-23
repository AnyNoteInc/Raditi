import { describe, expect, it, vi } from 'vitest'

import { ArtifactNotify } from './artifact-notify.ts'

// A notice of an artifact (docs/plan/88-artifacts.md, Ар54): only to a reader who still has access,
// a series of edits as one notice, never to the one who did it.

const ARTIFACT = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const READER = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const ACTOR = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62'

function harness(options: { access?: boolean; recent?: number } = {}) {
  const deliver = vi.fn(async () => 'sent' as const)
  const db = {
    // artifactRole reads one row: the reader is its owner, or nothing.
    $queryRaw: vi.fn(async () =>
      options.access === false
        ? []
        : [{ owner: READER, deleted: false, taken_down: false, member: true, grants: null }],
    ),
    chatNotification: { count: vi.fn(async () => options.recent ?? 0) },
  }
  const notify = new ArtifactNotify({ db: db as never, delivery: { deliver } })
  return { notify, deliver }
}

const job = (
  kind: 'artifact_comment' | 'artifact_changed',
  actorUserId: string | null = ACTOR,
) => ({
  artifactId: ARTIFACT,
  userId: READER,
  kind,
  actorUserId,
})

describe('ArtifactNotify', () => {
  it('tells a reader with access, with the path of the artifact and no words', async () => {
    const { notify, deliver } = harness()
    await notify.run(job('artifact_comment'))
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: READER,
        kind: 'artifact_comment',
        path: `/artifacts/${ARTIFACT}`,
        artifact: { id: ARTIFACT, actorUserId: ACTOR },
        telegram: null,
      }),
    )
  })

  it('tells nobody who lost access, nor the one who did it', async () => {
    const lost = harness({ access: false })
    await lost.notify.run(job('artifact_comment'))
    expect(lost.deliver).not.toHaveBeenCalled()
    const self = harness()
    await self.notify.run(job('artifact_comment', READER))
    expect(self.deliver).not.toHaveBeenCalled()
  })

  it('tells of a series of edits once in half an hour', async () => {
    const quiet = harness({ recent: 1 })
    await quiet.notify.run(job('artifact_changed'))
    expect(quiet.deliver).not.toHaveBeenCalled()
    const first = harness({ recent: 0 })
    await first.notify.run(job('artifact_changed'))
    expect(first.deliver).toHaveBeenCalled()
  })
})
