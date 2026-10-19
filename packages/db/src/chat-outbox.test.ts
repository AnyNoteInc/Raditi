import { describe, expect, it, vi } from 'vitest'

import {
  enqueueAgentTurn,
  enqueuePreviewBrowser,
  enqueuePreviewSync,
  enqueueReleaseAdvance,
  enqueueSiteWaitingPasses,
} from './chat-outbox.ts'
import type { OutboxWriter } from './outbox.ts'

const taskId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const previewId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const requestId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a62'
const releaseId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a63'

function fakeWriter(count = 1) {
  const createMany = vi.fn().mockResolvedValue({ count })
  const writer = { outboxEvent: { createMany } } as unknown as OutboxWriter
  const rows = () => createMany.mock.calls.map(([args]) => args.data[0])
  return { writer, rows }
}

describe('enqueueAgentTurn', () => {
  it('writes the pass of a request to agent-turns with ids only', async () => {
    const { writer, rows } = fakeWriter()

    const written = await enqueueAgentTurn(writer, {
      taskId: taskId.toUpperCase(),
      attempt: 2,
      requestEventId: '41',
    })

    expect(written).toBe(true)
    expect(rows()).toEqual([
      {
        topic: 'agent-turns',
        type: 'turn.run',
        payload: { taskId, attempt: 2, requestEventId: '41' },
        dedupeKey: `turn.run:${taskId}:2:41`,
        availableAt: undefined,
      },
    ])
  })

  it('says false when the key already exists', async () => {
    const { writer } = fakeWriter(0)
    await expect(
      enqueueAgentTurn(writer, { taskId, attempt: 1, requestEventId: '7' }),
    ).resolves.toBe(false)
  })

  it('refuses a payload with anything but its ids before writing', async () => {
    const { writer, rows } = fakeWriter()
    await expect(
      enqueueAgentTurn(writer, {
        taskId,
        attempt: 1,
        requestEventId: '7',
        text: 'слова клиента',
      } as never),
    ).rejects.toThrow()
    expect(rows()).toEqual([])
  })
})

describe('enqueuePreviewSync', () => {
  it('keys the job by revision and counter, so a second request is not lost', async () => {
    const { writer, rows } = fakeWriter()

    await enqueuePreviewSync(writer, { previewId, revision: 3, seq: 1 })
    await enqueuePreviewSync(writer, { previewId, revision: 3, seq: 2 })

    expect(rows().map((row) => [row.topic, row.type, row.dedupeKey])).toEqual([
      ['previews', 'preview.sync', `preview.sync:${previewId}:3:1`],
      ['previews', 'preview.sync', `preview.sync:${previewId}:3:2`],
    ])
  })
})

describe('enqueuePreviewBrowser', () => {
  it('keys the job by its request row', async () => {
    const { writer, rows } = fakeWriter()

    await enqueuePreviewBrowser(writer, { previewId, requestId })

    expect(rows()).toEqual([
      {
        topic: 'previews',
        type: 'preview.browser',
        payload: { previewId, requestId },
        dedupeKey: `preview.browser:${previewId}:${requestId}`,
      },
    ])
  })
})

describe('enqueueReleaseAdvance', () => {
  it('keys the job by status, step and counter', async () => {
    const { writer, rows } = fakeWriter()

    await enqueueReleaseAdvance(writer, { releaseId, status: 'approved', step: null, seq: 1 })
    await enqueueReleaseAdvance(writer, { releaseId, status: 'deploying', step: 'files', seq: 4 })

    expect(rows().map((row) => [row.topic, row.dedupeKey])).toEqual([
      ['deploys', `release.advance:${releaseId}:approved:-:1`],
      ['deploys', `release.advance:${releaseId}:deploying:files:4`],
    ])
  })

  it('passes a delay through to the outbox row', async () => {
    const { writer, rows } = fakeWriter()
    const availableAt = new Date('2026-10-17T12:00:00Z')

    await enqueueReleaseAdvance(
      writer,
      { releaseId, status: 'deploying', step: null, seq: 2 },
      { availableAt },
    )

    expect(rows()[0]?.availableAt).toEqual(availableAt)
  })
})

describe('enqueueSiteWaitingPasses', () => {
  const siteId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a64'
  const other = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a65'

  it('puts the passes that wait for the site back, keyed by what let it go', async () => {
    const { writer, rows } = fakeWriter()
    const $queryRaw = vi.fn().mockResolvedValue([
      { id: taskId.toUpperCase(), attempt: 1, request_id: 41n },
      // A task whose only requests are commands has nothing to answer.
      { id: other, attempt: 2, request_id: null },
    ])
    const put = await enqueueSiteWaitingPasses({ ...writer, $queryRaw } as never, {
      siteId,
      tag: `release-${releaseId}`,
    })
    expect(put).toBe(1)
    expect(rows()).toEqual([
      {
        topic: 'agent-turns',
        type: 'turn.run',
        payload: { taskId, attempt: 1, requestEventId: '41' },
        dedupeKey: `turn.run:${taskId}:1:41:retry:release-${releaseId}`,
        availableAt: undefined,
      },
    ])
    // Only queued tasks of the site that wait for it.
    const sql = ($queryRaw.mock.calls[0]![0] as string[]).join('?')
    expect(sql).toContain("t.status = 'queued' AND t.waiting = 'site'")
    expect($queryRaw.mock.calls[0]![1]).toBe(siteId)
  })

  it('refuses a tag that is not a word and an id', async () => {
    const { writer } = fakeWriter()
    const $queryRaw = vi.fn()
    await expect(
      enqueueSiteWaitingPasses({ ...writer, $queryRaw } as never, { siteId, tag: 'x:y' }),
    ).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
  })
})
