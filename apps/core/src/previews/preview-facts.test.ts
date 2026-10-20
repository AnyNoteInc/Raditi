import { describe, expect, it } from 'vitest'
import { emptyPreviewRecord } from '@repo/site-content'

import { previewAction, previewShowsTarget, type PreviewFacts } from './preview-facts.ts'

const now = new Date('2026-10-17T12:00:00Z')
const later = new Date(now.getTime() + 3_600_000)
const earlier = new Date(now.getTime() - 1000)
const head = 'c'.repeat(40)

function facts(
  preview: Partial<PreviewFacts['preview']> = {},
  rest: Partial<Omit<PreviewFacts, 'preview'>> = {},
): PreviewFacts {
  return {
    preview: {
      id: '00000000-0000-4000-8000-0000000000a1',
      siteId: '00000000-0000-4000-8000-0000000000a2',
      taskId: '00000000-0000-4000-8000-0000000000a3',
      status: 'ready',
      dbMode: 'copy',
      unavailableReason: null,
      hostname: 'site-0f3a9c1b-chat-a1b2c3.localhost',
      candidateId: '00000000-0000-4000-8000-0000000000c1',
      filesSha: head,
      revision: 2,
      dirty: false,
      upstream: { host: '127.0.0.1', port: 40001 },
      writeEpoch: 3,
      seed: { key: 'k', sha256: 'a'.repeat(64), releaseId: null },
      expiresAt: later,
      lastViewedAt: null,
      record: emptyPreviewRecord(),
      written: false,
      ...preview,
    },
    task: { status: 'awaiting_approval', workspaceId: 'w', dataClass: 'synthetic' },
    site: { id: 's', stack: 'wordpress', url: 'https://shop.example.ru', installedReleaseId: null },
    repo: null,
    candidate: {
      id: '00000000-0000-4000-8000-0000000000c1',
      revision: 2,
      headSha: head,
      files: [],
      dbPlan: [],
      invalid: false,
    },
    hasDatabase: true,
    ...rest,
  }
}

describe('what a preview needs now', () => {
  it('destroys the preview of a closed dialog, and nothing of a destroyed one', () => {
    for (const status of ['done', 'failed', 'cancelled', 'rolled_back'] as const)
      expect(
        previewAction(facts({}, { task: { status, workspaceId: 'w', dataClass: 'synthetic' } }), {
          requested: false,
          now,
        }),
      ).toBe('destroy')
    expect(
      previewAction(facts({ status: 'destroyed' }), { requested: true, now, lost: true }),
    ).toBe('none')
  })

  it('finishes a build that was never done or whose holder died, even during a pass', () => {
    const busy = { status: 'running' as const, workspaceId: 'w', dataClass: 'synthetic' as const }
    expect(
      previewAction(facts({ status: 'pending' }, { task: busy }), { requested: false, now }),
    ).toBe('build')
    expect(previewAction(facts({ status: 'building' }), { requested: false, now })).toBe('build')
  })

  it('never rebuilds a served preview under a pass, unless its containers are gone', () => {
    const task = { status: 'running' as const, workspaceId: 'w', dataClass: 'synthetic' as const }
    const dirty = facts({ dirty: true }, { task })
    expect(previewAction(dirty, { requested: true, now })).toBe('none')
    expect(previewAction(dirty, { requested: false, now, lost: true })).toBe('build')
  })

  it('stops a preview whose time is up while its dialog waits, never under a pass', () => {
    expect(previewAction(facts({ expiresAt: earlier }), { requested: false, now })).toBe('expire')
    expect(
      previewAction(facts({ status: 'failed', expiresAt: earlier }), { requested: true, now }),
    ).toBe('expire')
    const task = { status: 'preparing' as const, workspaceId: 'w', dataClass: 'synthetic' as const }
    expect(
      previewAction(facts({ status: 'failed', expiresAt: earlier }, { task }), {
        requested: true,
        now,
      }),
    ).toBe('build')
  })

  it('rebuilds on request what does not show its candidate', () => {
    expect(previewAction(facts(), { requested: true, now })).toBe('none')
    expect(previewAction(facts(), { requested: false, now })).toBe('none')
    expect(previewAction(facts({ dirty: true }), { requested: true, now })).toBe('build')
    expect(previewAction(facts({ dirty: true }), { requested: false, now })).toBe('none')
    expect(previewAction(facts({ revision: 1 }), { requested: true, now })).toBe('build')
    expect(previewAction(facts({ status: 'expired' }), { requested: true, now })).toBe('build')
    expect(previewAction(facts({ status: 'failed' }), { requested: true, now })).toBe('build')
    // Back to the base after a failed pass with no candidate before it.
    expect(previewAction(facts(), { requested: true, now })).toBe('none')
    expect(previewAction(facts({}, { candidate: null }), { requested: true, now })).toBe('build')
    expect(
      previewAction(facts({ revision: 0, candidateId: null }, { candidate: null }), {
        requested: true,
        now,
      }),
    ).toBe('none')
  })

  it('tries an unavailable preview again only when its cause may have gone', () => {
    const noDatabase = facts(
      { status: 'unavailable', unavailableReason: 'no_database' },
      { hasDatabase: false },
    )
    expect(previewAction(noDatabase, { requested: true, now })).toBe('none')
    expect(previewAction({ ...noDatabase, hasDatabase: true }, { requested: true, now })).toBe(
      'build',
    )
    expect(
      previewAction(facts({ status: 'unavailable', unavailableReason: 'no_core' }), {
        requested: true,
        now,
      }),
    ).toBe('build')
  })

  it('does not count a preview the agent synced as showing its revision', () => {
    expect(previewShowsTarget(facts())).toBe(true)
    expect(
      previewShowsTarget(
        facts({
          record: {
            ...emptyPreviewRecord(),
            sync: {
              assignmentId: '00000000-0000-4000-8000-0000000000d1',
              baseSha: head,
              paths: [],
            },
          },
        }),
      ),
    ).toBe(false)
    expect(previewShowsTarget(facts({ filesSha: 'd'.repeat(40) }))).toBe(false)
  })

  it('rebuilds on request a preview the agent wrote content into since its build', () => {
    // A failed pass: its writes are out of the plan, and the same revision is asked again.
    const written = facts({ written: true })
    expect(previewShowsTarget(written)).toBe(false)
    expect(previewAction(written, { requested: true, now })).toBe('build')
    expect(previewAction(written, { requested: false, now })).toBe('none')
  })
})
