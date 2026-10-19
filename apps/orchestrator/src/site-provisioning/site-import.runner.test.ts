import { randomUUID } from 'node:crypto'

import { Prisma } from '@repo/db'
import { provisioningLimits, siteProvisionWakeJobId, type JobQueue } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { toBullJobId } from '../queue/bullmq-job-queue.ts'
import { FakeSiteImportStore } from '../testing/site-import-store.ts'
import { hiccup, refuse } from './import-failure.ts'
import type { ImportedVersion } from './site-import.ts'
import {
  SiteImportRunner,
  type SiteImportOutcome,
  type SiteImportTiming,
} from './site-import.runner.ts'
import type { ClaimedStage } from './stage-store.ts'

const SHA = 'a'.repeat(40)

function setup(
  importer: (stage: ClaimedStage, signal: AbortSignal) => Promise<ImportedVersion>,
  timing: Partial<SiteImportTiming> = {},
) {
  const store = new FakeSiteImportStore()
  const siteId = randomUUID()
  const workspaceId = randomUUID()
  store.add({ siteId, workspaceId })
  const queue = { enqueue: vi.fn<JobQueue['enqueue']>(async () => {}) }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const outcomes: SiteImportOutcome[] = []
  const runner = new SiteImportRunner({
    store,
    importer,
    queue,
    logger,
    count: (outcome) => outcomes.push(outcome),
    timing: { heartbeatMs: 10, abandonMs: 50, ...timing },
  })
  const shutdown = new AbortController()
  return {
    store,
    siteId,
    workspaceId,
    queue,
    logger,
    outcomes,
    shutdown,
    run: () => runner.run(siteId, shutdown.signal),
    /** Every line the runner logged: ids and codes only. */
    lines: () =>
      [...logger.log.mock.calls, ...logger.warn.mock.calls].map(([line]) => String(line)),
  }
}

/** Resolves when the signal aborts, or never. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))

describe('SiteImportRunner', () => {
  it('claims, runs and confirms the import, then wakes the next site of the workspace', async () => {
    const t = setup(async (stage, signal) => {
      expect(signal.aborted).toBe(false)
      t.store.plans.set(stage.siteId, {
        gitRepositoryId: randomUUID(),
        commitSha: SHA,
        files: 1,
        bytes: 1,
        leaseEpoch: stage.leaseEpoch,
        importedAt: null,
      })
      return { commitSha: SHA }
    })
    const next = t.store.add({ siteId: randomUUID(), workspaceId: t.workspaceId, attempt: 2 })

    expect(await t.run()).toBe('succeeded')
    const row = t.store.stage(t.siteId)
    expect(row).toMatchObject({ status: 'succeeded', finished: true, step: null, leaseEpoch: 1 })
    expect(t.store.plans.get(t.siteId)!.importedAt).toBeInstanceOf(Date)
    expect(t.queue.enqueue).toHaveBeenCalledExactlyOnceWith(
      'site-import',
      'site.provision',
      { siteId: next.siteId, stage: 'code_import' },
      { jobId: siteProvisionWakeJobId(next.siteId, 'code_import', 2, `next-${t.siteId}-1`) },
    )
    // BullMQ takes the id as it is encoded for it.
    expect(toBullJobId(t.queue.enqueue.mock.calls[0]![3]!.jobId!)).not.toContain(':')
    expect(t.outcomes).toEqual(['succeeded'])
    expect(t.lines().every((line) => /^site_import_\w+( \w+=[\w-]+)*$/.test(line))).toBe(true)
  })

  it('fails the stage with the code of a refusal, and internal for anything else', async () => {
    const refused = setup(async () => Promise.reject(refuse('auth_failed')))
    expect(await refused.run()).toBe('failed')
    expect(refused.store.stage(refused.siteId)).toMatchObject({
      status: 'failed',
      errorCode: 'auth_failed',
    })

    const odd = setup(async () => Promise.reject(new Error('password=leak in a driver message')))
    expect(await odd.run()).toBe('failed')
    expect(odd.store.stage(odd.siteId).errorCode).toBe('internal')
    expect(odd.lines().join('\n')).not.toContain('leak')
  })

  it('requeues a hiccup with a growing delay until the attempt has used its enqueues', async () => {
    const t = setup(async () => Promise.reject(hiccup('unreachable')))
    const before = Date.now()
    expect(await t.run()).toBe('requeued')
    expect(t.store.stage(t.siteId)).toMatchObject({ status: 'queued', enqueues: 2, step: null })
    expect(t.store.outbox).toEqual([
      expect.objectContaining({ siteId: t.siteId, attempt: 1, enqueues: 2 }),
    ])
    expect(t.store.outbox[0]!.availableAt).toBeGreaterThanOrEqual(before + 30_000)

    t.store.stage(t.siteId).enqueues = provisioningLimits.enqueuesPerAttempt - 1
    expect(await t.run()).toBe('requeued')
    expect(await t.run()).toBe('failed')
    expect(t.store.stage(t.siteId)).toMatchObject({ status: 'failed', errorCode: 'unreachable' })
  })

  it('gives the stage back at shutdown, after releaseDelayMs, and fails it interrupted at the limit', async () => {
    const t = setup((_, signal) => untilAborted(signal))
    const before = Date.now()
    const run = t.run()
    await vi.waitFor(() => expect(t.store.stage(t.siteId).status).toBe('running'))
    t.shutdown.abort()
    expect(await run).toBe('released')
    expect(t.store.stage(t.siteId)).toMatchObject({ status: 'queued', enqueues: 2 })
    expect(t.store.outbox[0]!.availableAt).toBeGreaterThanOrEqual(
      before + provisioningLimits.releaseDelayMs,
    )

    const last = setup((_, signal) => untilAborted(signal))
    last.store.stage(last.siteId).enqueues = provisioningLimits.enqueuesPerAttempt
    const ending = last.run()
    await vi.waitFor(() => expect(last.store.stage(last.siteId).status).toBe('running'))
    last.shutdown.abort()
    expect(await ending).toBe('failed')
    expect(last.store.stage(last.siteId).errorCode).toBe('interrupted')
  })

  it('releases without waiting for an import that does not stop', async () => {
    const t = setup(() => new Promise<never>(() => {}), { abandonMs: 20 })
    const run = t.run()
    await vi.waitFor(() => expect(t.store.stage(t.siteId).status).toBe('running'))
    const aborted = Date.now()
    t.shutdown.abort()
    expect(await run).toBe('released')
    expect(Date.now() - aborted).toBeLessThan(1_000)
  })

  it('takes no job once core is stopping', async () => {
    const importer = vi.fn()
    const t = setup(importer)
    t.shutdown.abort()
    expect(await t.run()).toBe('skipped')
    expect(t.store.stage(t.siteId).status).toBe('queued')
    expect(importer).not.toHaveBeenCalled()
  })

  it('fails timed_out at the deadline of the stage', async () => {
    const t = setup((_, signal) => untilAborted(signal), { stageMs: 30 })
    expect(await t.run()).toBe('failed')
    expect(t.store.stage(t.siteId).errorCode).toBe('timed_out')
  })

  it('stops and writes nothing once another run holds the stage', async () => {
    let seen: AbortSignal | undefined
    const t = setup((_, signal) => {
      seen = signal
      return untilAborted(signal)
    })
    const run = t.run()
    await vi.waitFor(() => expect(t.store.stage(t.siteId).status).toBe('running'))
    // The sweep gave the stage to another core, which claimed it again.
    t.store.stage(t.siteId).leaseEpoch += 1
    expect(await run).toBe('lease_lost')
    expect(seen?.aborted).toBe(true)
    expect(t.store.stage(t.siteId)).toMatchObject({ status: 'running', leaseEpoch: 2 })
    expect(t.store.outbox).toEqual([])
    expect(t.queue.enqueue).not.toHaveBeenCalled()
  })

  it('stops once its heartbeat has not been written for staleMs', async () => {
    const t = setup((_, signal) => untilAborted(signal), { staleMs: 40 })
    const heartbeat = vi
      .spyOn(t.store, 'heartbeat')
      .mockRejectedValue(new Error('connect ECONNREFUSED'))
    expect(await t.run()).toBe('lease_lost')
    expect(heartbeat).toHaveBeenCalled()
  })

  it('stops, and ends, when a heartbeat write hangs and never settles', async () => {
    // A pooled connection that died without a word: the UPDATE neither answers nor fails.
    const t = setup((_, signal) => untilAborted(signal), { staleMs: 60 })
    const heartbeat = vi.spyOn(t.store, 'heartbeat').mockReturnValue(new Promise<never>(() => {}))
    const started = Date.now()
    expect(await t.run()).toBe('lease_lost')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(heartbeat).toHaveBeenCalled()
    expect(t.lines()).toContain(`site_import_lease_lost site=${t.siteId} epoch=1`)
  })

  it.each([
    ['the pool waited past maxWait', 'P2028', {}],
    ['the server unreachable', 'P1001', {}],
    [
      'a raw statement cancelled by its timeout',
      'P2010',
      { originalCode: '57014', kind: 'postgres' },
    ],
    ['a lock not taken in lock_timeout', 'P2010', { originalCode: '55P03', kind: 'postgres' }],
    ['a connection reset under a raw query', 'P2010', { kind: 'ConnectionClosed' }],
    ['a connection failure', 'P2039', { originalCode: '08006', kind: 'postgres' }],
    [
      'a serialization failure',
      'P2034',
      { originalCode: '40001', kind: 'TransactionWriteConflict' },
    ],
  ])('requeues the import when PostgreSQL blinks under it: %s', async (_, code, cause) => {
    const error = new Prisma.PrismaClientKnownRequestError('synthetic database failure', {
      code,
      clientVersion: '7.10.0',
      meta: { driverAdapterError: { cause } },
    })
    const t = setup(async () => Promise.reject(error))
    expect(await t.run()).toBe('requeued')
    expect(t.store.stage(t.siteId)).toMatchObject({ status: 'queued', enqueues: 2 })
    expect(t.lines()).toContain(`site_import_requeued site=${t.siteId} code=internal`)
  })

  it('fails internal for an answer of PostgreSQL that a retry would meet again', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('synthetic unique violation', {
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
    })
    const t = setup(async () => Promise.reject(error))
    expect(await t.run()).toBe('failed')
    expect(t.store.stage(t.siteId)).toMatchObject({ status: 'failed', errorCode: 'internal' })
  })

  it('skips a stage that is not queued or whose workspace runs another import', async () => {
    const idle = setup(vi.fn())
    idle.store.stage(idle.siteId).status = 'running'
    expect(await idle.run()).toBe('skipped')

    const busy = setup(vi.fn())
    busy.store.add({ siteId: randomUUID(), workspaceId: busy.workspaceId, status: 'running' })
    expect(await busy.run()).toBe('skipped')
    expect(busy.store.stage(busy.siteId).status).toBe('queued')
  })

  it('fails a stage of a site that is no longer being connected, and wakes the next', async () => {
    const t = setup(vi.fn())
    t.store.stage(t.siteId).siteStatus = 'archived'
    const next = t.store.add({ siteId: randomUUID(), workspaceId: t.workspaceId })
    expect(await t.run()).toBe('failed')
    expect(t.store.stage(t.siteId).errorCode).toBe('access_refused')
    expect(t.queue.enqueue.mock.calls[0]![2]).toEqual({ siteId: next.siteId, stage: 'code_import' })
  })

  it('leaves the stage to the sweep when its end cannot be written', async () => {
    const t = setup(async () => Promise.reject(refuse('auth_failed')))
    t.store.failing.add('fail')
    expect(await t.run()).toBe('unsettled')
    expect(t.store.stage(t.siteId).status).toBe('running')
    expect(t.queue.enqueue).not.toHaveBeenCalled()
  })

  it('fails repository_mismatch when the remote commit is not the recorded one', async () => {
    const t = setup(async () => ({ commitSha: SHA }))
    expect(await t.run()).toBe('failed')
    expect(t.store.stage(t.siteId).errorCode).toBe('repository_mismatch')
  })
})
