import {
  provisioningStages,
  queueNames,
  SITE_PROVISION_JOB,
  siteProvisionDedupeKey,
  siteProvisionJobSchema,
  type ProvisioningStage,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import type { OutboxWriter } from './outbox.ts'
import { enqueueSiteProvisioningStage } from './site-provisioning.ts'

const siteId = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'

function fakeWriter(count = 1) {
  const createMany = vi.fn().mockResolvedValue({ count })
  const writer = { outboxEvent: { createMany } } as unknown as OutboxWriter
  const rows = () => createMany.mock.calls.map(([args]) => args.data[0])
  return { writer, createMany, rows }
}

describe('enqueueSiteProvisioningStage', () => {
  it.each([
    ['code_import', 'site-import'],
    ['database_schema', 'site-provisioning'],
  ] as const)('publishes %s to the queue %s', async (stage, topic) => {
    const { writer, createMany } = fakeWriter()

    const written = await enqueueSiteProvisioningStage(writer, {
      siteId,
      stage,
      attempt: 1,
      enqueues: 1,
    })

    expect(written).toBe(true)
    expect(createMany).toHaveBeenCalledOnce()
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          topic,
          type: 'site.provision',
          payload: { siteId, stage },
          dedupeKey: `site-provisioning:${siteId}:${stage}:1:1`,
          availableAt: undefined,
        },
      ],
      skipDuplicates: true,
    })
  })

  it('has a queue for every stage, and the two stages do not share one', async () => {
    const { writer, rows } = fakeWriter()

    for (const stage of provisioningStages)
      await enqueueSiteProvisioningStage(writer, { siteId, stage, attempt: 1, enqueues: 1 })

    const topics = rows().map((row) => row.topic as string)
    expect(topics).toHaveLength(provisioningStages.length)
    expect(new Set(topics).size).toBe(provisioningStages.length)
    for (const topic of topics) expect(queueNames).toContain(topic)
  })

  it('writes ids only, in the shape the worker parses', async () => {
    const { writer, rows } = fakeWriter()

    await enqueueSiteProvisioningStage(writer, {
      siteId,
      stage: 'code_import',
      attempt: 3,
      enqueues: 2,
    })

    const [row] = rows()
    expect(row.type).toBe(SITE_PROVISION_JOB)
    expect(Object.keys(row.payload).sort()).toEqual(['siteId', 'stage'])
    expect(siteProvisionJobSchema.parse(row.payload)).toEqual({ siteId, stage: 'code_import' })
  })

  it('accepts the id the wizard derives for a site: a version 8 UUID', async () => {
    const { writer, rows } = fakeWriter()
    const derived = '6f1c2d3e-4b5a-8c7d-9e8f-0a1b2c3d4e5f'

    await expect(
      enqueueSiteProvisioningStage(writer, {
        siteId: derived,
        stage: 'database_schema',
        attempt: 1,
        enqueues: 1,
      }),
    ).resolves.toBe(true)
    expect(rows()[0].payload).toEqual({ siteId: derived, stage: 'database_schema' })
  })

  it('writes the id as PostgreSQL prints it: letter case does not make another event', async () => {
    const { writer, rows } = fakeWriter()
    const typed = siteId.toUpperCase()

    await enqueueSiteProvisioningStage(writer, {
      siteId: typed,
      stage: 'code_import',
      attempt: 2,
      enqueues: 1,
    })
    await enqueueSiteProvisioningStage(writer, {
      siteId,
      stage: 'code_import',
      attempt: 2,
      enqueues: 1,
    })

    const [upper, lower] = rows()
    expect(upper).toEqual(lower)
    expect(upper.payload).toEqual({ siteId, stage: 'code_import' })
    expect(upper.dedupeKey).toBe(`site-provisioning:${siteId}:code_import:2:1`)
  })

  it('keys the event by the site, the stage and both counters of the row', async () => {
    const { writer, rows } = fakeWriter()
    const events = [
      { stage: 'code_import', attempt: 1, enqueues: 1 },
      { stage: 'database_schema', attempt: 1, enqueues: 1 },
      // A retry by the user is the next attempt; a resume after a restart the next enqueue.
      { stage: 'code_import', attempt: 2, enqueues: 1 },
      { stage: 'code_import', attempt: 2, enqueues: 2 },
      { stage: 'code_import', attempt: 12, enqueues: 1 },
      { stage: 'code_import', attempt: 1, enqueues: 21 },
    ] as const

    for (const event of events) await enqueueSiteProvisioningStage(writer, { siteId, ...event })

    const keys = rows().map((row) => row.dedupeKey as string)
    expect(keys).toEqual(
      events.map((event) =>
        siteProvisionDedupeKey(siteId, event.stage, event.attempt, event.enqueues),
      ),
    )
    expect(new Set(keys).size).toBe(events.length)
    // The attempt comes before the count of events.
    expect(keys[4]).toBe(`site-provisioning:${siteId}:code_import:12:1`)
    expect(keys[5]).toBe(`site-provisioning:${siteId}:code_import:1:21`)
  })

  it('passes the publish time of a graceful release through', async () => {
    const { writer, rows } = fakeWriter()
    const availableAt = new Date('2026-10-04T12:00:45Z')

    await enqueueSiteProvisioningStage(writer, {
      siteId,
      stage: 'code_import',
      attempt: 1,
      enqueues: 2,
      availableAt,
    })

    expect(rows()[0].availableAt).toBe(availableAt)
  })

  it('leaves the publish time to the database default when it is not given', async () => {
    const { writer, rows } = fakeWriter()

    await enqueueSiteProvisioningStage(writer, {
      siteId,
      stage: 'database_schema',
      attempt: 1,
      enqueues: 1,
    })

    expect(rows()[0].availableAt).toBeUndefined()
  })

  it('returns false when an event with the same key was written before', async () => {
    const { writer, createMany } = fakeWriter(0)

    const written = await enqueueSiteProvisioningStage(writer, {
      siteId,
      stage: 'database_schema',
      attempt: 1,
      enqueues: 1,
    })

    expect(written).toBe(false)
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }))
  })

  it.each([
    ['a site id that is not a uuid', { siteId: 'site-1' }],
    ['a site id with a path in it', { siteId: `${siteId}/../x` }],
    // The worker parses the job with z.uuid(): versions 1 to 8 of the RFC variant only, although
    // the uuid type of PostgreSQL holds any 32 hex digits.
    ['a site id the worker would not parse', { siteId: '11111111-1111-1111-1111-111111111111' }],
    ['an unknown stage', { stage: 'backup' as ProvisioningStage }],
    ['a zero attempt', { attempt: 0 }],
    ['a fractional attempt', { attempt: 1.5 }],
    ['an attempt that is not a number', { attempt: Number.NaN }],
    ['a zero count of events', { enqueues: 0 }],
    ['a negative count of events', { enqueues: -1 }],
  ])('refuses %s before touching the database', async (_, values) => {
    const { writer, createMany } = fakeWriter()

    await expect(
      enqueueSiteProvisioningStage(writer, {
        siteId,
        stage: 'code_import',
        attempt: 1,
        enqueues: 1,
        ...values,
      }),
    ).rejects.toThrow()
    expect(createMany).not.toHaveBeenCalled()
  })

  it('writes nothing but the ids of the input: an extra field never reaches the payload', async () => {
    const { writer, rows } = fakeWriter()
    const input = { siteId, stage: 'code_import', attempt: 1, enqueues: 1, host: 'ftp.example.ru' }

    await enqueueSiteProvisioningStage(
      writer,
      input as Parameters<typeof enqueueSiteProvisioningStage>[1],
    )

    expect(JSON.stringify(rows()[0])).not.toContain('ftp.example.ru')
  })
})
