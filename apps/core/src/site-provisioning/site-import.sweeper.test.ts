import { randomUUID } from 'node:crypto'

import { provisioningLimits, siteProvisionWakeJobId, type JobQueue } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { FakeSiteImportStore } from '../testing/site-import-store.ts'
import { SiteImportSweeper } from './site-import.sweeper.ts'

const NOW = Date.parse('2026-10-17T10:02:00Z')

function setup(background = false) {
  const store = new FakeSiteImportStore()
  store.now = () => NOW
  const queue = { enqueue: vi.fn<JobQueue['enqueue']>(async () => {}) }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const sweeper = new SiteImportSweeper({
    store,
    queue,
    background,
    logger,
    now: () => NOW,
    intervalMs: 5,
  })
  return { store, queue, logger, sweeper }
}

describe('SiteImportSweeper', () => {
  it('returns a silent stage to the queue with a new event, and wakes the next of its workspace', async () => {
    const t = setup()
    const workspaceId = randomUUID()
    const silent = t.store.add({
      siteId: randomUUID(),
      workspaceId,
      status: 'running',
      leaseEpoch: 3,
      heartbeatAt: NOW - provisioningLimits.staleMs - 1,
    })
    const alive = t.store.add({ siteId: randomUUID(), status: 'running', heartbeatAt: NOW - 1_000 })
    const next = t.store.add({ siteId: randomUUID(), workspaceId, updatedAt: NOW })

    await t.sweeper.tick()

    expect(silent).toMatchObject({ status: 'queued', enqueues: 2, step: null })
    expect(alive.status).toBe('running')
    expect(t.store.outbox).toEqual([
      expect.objectContaining({ siteId: silent.siteId, enqueues: 2 }),
    ])
    expect(t.queue.enqueue).toHaveBeenCalledExactlyOnceWith(
      'site-import',
      'site.provision',
      { siteId: next.siteId, stage: 'code_import' },
      { jobId: siteProvisionWakeJobId(next.siteId, 'code_import', 1, `next-${silent.siteId}-3`) },
    )
  })

  it('fails a silent stage interrupted once its attempt has used its enqueues', async () => {
    const t = setup()
    const silent = t.store.add({
      siteId: randomUUID(),
      status: 'running',
      enqueues: provisioningLimits.enqueuesPerAttempt,
      heartbeatAt: NOW - provisioningLimits.staleMs - 1,
    })
    await t.sweeper.tick()
    expect(silent).toMatchObject({ status: 'failed', errorCode: 'interrupted', finished: true })
    expect(t.store.outbox).toEqual([])
  })

  it('wakes a stage that waited queued past queuedStaleMs, once per five-minute bucket', async () => {
    const t = setup()
    const waiting = t.store.add({
      siteId: randomUUID(),
      attempt: 2,
      updatedAt: NOW - provisioningLimits.queuedStaleMs - 1,
    })
    t.store.add({ siteId: randomUUID(), updatedAt: NOW - 1_000 })

    await t.sweeper.tick()

    const bucket = String(Math.floor(NOW / provisioningLimits.queuedStaleMs))
    expect(t.queue.enqueue).toHaveBeenCalledExactlyOnceWith(
      'site-import',
      'site.provision',
      { siteId: waiting.siteId, stage: 'code_import' },
      { jobId: siteProvisionWakeJobId(waiting.siteId, 'code_import', 2, bucket) },
    )
    // Nothing is written for a wake-up.
    expect(t.store.outbox).toEqual([])
    expect(waiting.status).toBe('queued')
  })

  it('never overlaps its passes, logs no error text and waits for the running pass on stop', async () => {
    const t = setup()
    let finish: (() => void) | undefined
    const sweep = vi
      .spyOn(t.store, 'sweepSilent')
      .mockImplementation(
        () => new Promise((resolve) => (finish = () => resolve({ requeued: [], interrupted: [] }))),
      )
    const first = t.sweeper.tick()
    const second = t.sweeper.tick()
    expect(second).toBe(first)
    const stopped = t.sweeper.onModuleDestroy()
    let done = false
    void stopped.then(() => (done = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(done).toBe(false)
    finish!()
    await stopped
    expect(sweep).toHaveBeenCalledOnce()

    const failing = setup()
    vi.spyOn(failing.store, 'sweepSilent').mockRejectedValue(new Error('password=leak'))
    await failing.sweeper.tick()
    expect(failing.logger.warn).toHaveBeenCalledExactlyOnceWith('site_import_sweep_failed')
  })

  it('runs on a timer only with background work', async () => {
    const quiet = setup(false)
    const quietSweep = vi.spyOn(quiet.store, 'sweepSilent')
    quiet.sweeper.onApplicationBootstrap()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(quietSweep).not.toHaveBeenCalled()

    const running = setup(true)
    const sweep = vi.spyOn(running.store, 'sweepSilent')
    running.sweeper.onApplicationBootstrap()
    await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(2))
    await running.sweeper.onModuleDestroy()
  })
})
